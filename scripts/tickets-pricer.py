#!/usr/bin/env python3
"""
Ticket Pricer — host job, every 30 min (:00 and :30) via com.nanoclaw.tickets-pricer.

Replaces the "Ticket Pricer" NanoClaw scheduled task (2026-11-24). That task
started a full Opus agent every 30 minutes whose only real work was one Bash
call to ticket-scraper.py and reading its JSON summary — about $0.25 a run,
~$12/day, purely agent start-up cost. It also had an alert bug: "message if the
two previous runs also failed" stays true for every run of a long outage, so
the StubHub block of 2026-11-18..19 sent ~40 identical alerts, one per tick,
and nothing said when it recovered.

What this does:
  1. Runs scripts/ticket-scraper.py in the same agent image with the same two
     mounts the agent container had (the tickets .claude dir, where tickets.db
     and the DataDome cookie live, and scripts/ read-only). No agent, no tokens.
  2. Classifies the run from the scraper's JSON summary:
       ok      scraped > 0, or nothing failed (incl. nothing due)
       fail    scraped == 0 and errors > 0   (e.g. every event 403'd)
       crash   no JSON / non-zero exit / docker problem / {"error": ...}
  3. Alerting, in the tickets chat:
       - ONE alert on the 3rd consecutive fail/crash (a single failed tick
         recovers by itself 30 min later and is not worth a message);
       - a reminder only if the outage is still going 24h later;
       - ONE "recovered" message on the first good run after an alert.
     Message wording keeps the old prompt's accuracy rules: never say the
     cookie needs a manual refresh (there is no manual refresh); report
     cookie_refresh / cookie_source literally; fresh cookie + all 403 means an
     IP/WAF-level block, not a cookie problem.

State:  ~/.local/share/nanoclaw/state/tickets-pricer.json
Log:    ~/.local/share/nanoclaw/logs/tickets-pricer.log (one line per run; its
        mtime is what heartbeat.sh's job-freshness row reads)
Last:   ~/.local/share/nanoclaw/logs/tickets-pricer.last.{json,stderr}

  scripts/tickets-pricer.py             normal run
  scripts/tickets-pricer.py --dry-run   run nothing; replay the last summary
                                        through the alert logic and print it
"""
from __future__ import annotations

import fcntl
import json
import os
import subprocess
import sys
import time
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import nanoclaw_ipc  # noqa: E402

ROOT = nanoclaw_ipc.PROJECT_ROOT
HOME = os.path.expanduser("~")
STATE_DIR = os.path.join(HOME, ".local/share/nanoclaw/state")
LOG_DIR = os.path.join(HOME, ".local/share/nanoclaw/logs")
STATE = os.path.join(STATE_DIR, "tickets-pricer.json")
LOG = os.path.join(LOG_DIR, "tickets-pricer.log")
LAST_JSON = os.path.join(LOG_DIR, "tickets-pricer.last.json")
LAST_ERR = os.path.join(LOG_DIR, "tickets-pricer.last.stderr")
LOCK = os.path.join(STATE_DIR, "tickets-pricer.lock")

GROUP = "tickets"
IMAGE = "nanoclaw-agent:latest"
DOCKER = "/usr/local/bin/docker"
RUN_TIMEOUT_S = 900          # scraper normally 30-120s; agent runs peaked ~7 min
ALERT_AFTER = 3              # consecutive bad runs before the first message
REMIND_AFTER_H = 24


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def log(line: str) -> None:
    with open(LOG, "a") as f:
        f.write("%s %s\n" % (now_iso(), line))


def load_state() -> dict:
    try:
        with open(STATE) as f:
            return json.load(f)
    except Exception:
        return {"consecutive_bad": 0, "outage_started": None, "alerted_at": None,
                "last_outcome": None, "last_run": None}


def save_state(st: dict) -> None:
    tmp = STATE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(st, f, indent=2)
    os.rename(tmp, STATE)


def run_scraper() -> tuple[str, dict | None, str]:
    """Returns (outcome, summary, reason)."""
    uid, gid = os.getuid(), os.getgid()
    tz = os.environ.get("TZ") or time.strftime("%Z")
    try:
        tz = os.path.realpath("/etc/localtime").split("zoneinfo/")[1]
    except Exception:
        pass
    name = "nanoclaw-tickets-pricer-%d" % int(time.time())
    cmd = [DOCKER, "run", "--rm", "-i", "--name", name,
           "--entrypoint", "python3",
           "-e", "TZ=%s" % tz, "-e", "HOME=/home/node",
           "-v", "%s/data/sessions/tickets/.claude:/home/node/.claude" % ROOT,
           "-v", "%s/scripts:/home/node/nanoclaw/scripts:ro" % ROOT]
    if uid not in (0, 1000):
        cmd += ["--user", "%d:%d" % (uid, gid)]
    cmd += [IMAGE, "/home/node/nanoclaw/scripts/ticket-scraper.py"]
    try:
        p = subprocess.run(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                           stderr=subprocess.PIPE, timeout=RUN_TIMEOUT_S)
    except subprocess.TimeoutExpired as e:
        subprocess.run([DOCKER, "kill", name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        with open(LAST_ERR, "wb") as f:
            f.write(e.stderr or b"")
        return "crash", None, "scraper did not finish within %ds (container killed)" % RUN_TIMEOUT_S
    except Exception as e:  # docker missing, etc.
        return "crash", None, "could not start the scraper container: %s" % e
    with open(LAST_ERR, "wb") as f:
        f.write(p.stderr[-200000:])
    summary = None
    for line in reversed(p.stdout.decode("utf-8", "replace").strip().splitlines()):
        line = line.strip()
        if line.startswith("{"):
            try:
                summary = json.loads(line)
                break
            except ValueError:
                pass
    if summary is not None:
        with open(LAST_JSON, "w") as f:
            json.dump(summary, f, indent=2)
    if summary is None:
        tail = p.stderr.decode("utf-8", "replace").strip().splitlines()[-1:] or ["(no stderr)"]
        return "crash", None, "scraper exited %d without a JSON summary; last stderr: %s" % (p.returncode, tail[0][:200])
    if "error" in summary and "scraped" not in summary:
        return "crash", summary, "scraper error: %s" % str(summary["error"])[:200]
    return classify(summary), summary, ""


def classify(s: dict) -> str:
    if s.get("scraped", 0) > 0 or s.get("errors", 0) == 0:
        return "ok"
    return "fail"


def describe(summary: dict | None, outcome: str, reason: str) -> str:
    if outcome == "crash" or not summary:
        return "The scraper did not produce a result: %s" % reason
    errs = summary.get("error_details") or []
    kinds = {}
    for e in errs:
        kinds[e.get("error", "?")] = kinds.get(e.get("error", "?"), 0) + 1
    kind_txt = ", ".join("%d× `%s`" % (n, k) for k, n in sorted(kinds.items(), key=lambda x: -x[1]))
    lines = ["This run: %d due, 0 scraped, %d failed (%s)." % (summary.get("due_count", 0), summary.get("errors", 0), kind_txt or "no details")]
    cr, cs = summary.get("cookie_refresh"), summary.get("cookie_source", "?")
    lines.append("cookie_refresh: `%s`, cookie_source: `%s`" % (str(cr).lower(), cs))
    if cs == "disk":
        lines.append("The Playwright warmup did not get a fresh cookie, so this run used the cookie saved on disk; the warmup is degraded.")
    elif not cr:
        lines.append("The Playwright warmup did not yield a fresh cookie on this run.")
    elif kinds and all("403" in str(k) or "waf" in str(k).lower() for k in kinds):
        lines.append("The cookie was fresh and everything still got 403, so the block is IP/WAF-level, not the cookie.")
    titles = [e.get("title") for e in errs if e.get("title")][:7]
    if titles:
        lines.append("Events: " + ", ".join(titles))
    return "\n".join(lines)


def hours_since(iso: str | None) -> float:
    if not iso:
        return 0.0
    t = datetime.strptime(iso, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    return (datetime.now(timezone.utc) - t).total_seconds() / 3600


def decide(st: dict, outcome: str, summary: dict | None, reason: str) -> str | None:
    """Update state in place; return the message to send, if any."""
    now = now_iso()
    st["last_run"], st["last_outcome"] = now, outcome
    st["last_reason"] = reason or None
    if outcome == "ok":
        msg = None
        if st.get("alerted_at"):
            msg = ("*Ticket scraper recovered*\n\nScraped %d event(s) this run after %d failed run(s) in a row (since %s UTC)."
                   % (summary.get("scraped", 0) if summary else 0, st.get("consecutive_bad", 0),
                      (st.get("outage_started") or "?")[:16].replace("T", " ")))
        st.update(consecutive_bad=0, outage_started=None, alerted_at=None)
        return msg
    st["consecutive_bad"] = st.get("consecutive_bad", 0) + 1
    if not st.get("outage_started"):
        st["outage_started"] = now
    n = st["consecutive_bad"]
    if n < ALERT_AFTER:
        return None
    if not st.get("alerted_at"):
        st["alerted_at"] = now
        return ("*Ticket scraper: %d failed runs in a row*\n\n%s\n\n_I'll message again when it recovers, or in 24h if it hasn't._"
                % (n, describe(summary, outcome, reason)))
    if hours_since(st["alerted_at"]) >= REMIND_AFTER_H:
        st["alerted_at"] = now
        return ("*Ticket scraper still failing*: %d runs in a row, since %s UTC.\n\n%s"
                % (n, st["outage_started"][:16].replace("T", " "), describe(summary, outcome, reason)))
    return None


def main() -> int:
    os.makedirs(STATE_DIR, exist_ok=True)
    os.makedirs(LOG_DIR, exist_ok=True)
    dry = "--dry-run" in sys.argv

    if dry:
        st = load_state()
        try:
            summary = json.load(open(LAST_JSON))
        except Exception:
            summary = None
        outcome = classify(summary) if summary else "crash"
        print("state:", json.dumps(st))
        print("last summary outcome:", outcome)
        for label, oc in (("as-is", outcome), ("simulated failure", "fail")):
            s = dict(st)
            fake = summary or {"scraped": 0, "errors": 7, "due_count": 7, "cookie_refresh": True,
                               "cookie_source": "playwright",
                               "error_details": [{"error": "403", "title": "Example @ Event"}] * 7}
            if oc == "fail":
                fake = dict(fake, scraped=0, errors=max(1, fake.get("errors", 0)))
            msgs = []
            for _ in range(5):
                m = decide(s, oc, fake, "")
                msgs.append(m)
            print("--- %s x5 -> messages on runs: %s" % (label, [i + 1 for i, m in enumerate(msgs) if m]))
            for m in msgs:
                if m:
                    print(m)
                    print("~~~")
            m = decide(s, "ok", dict(fake, scraped=3), "")
            print("--- then a good run ->", m)
        return 0

    lockf = open(LOCK, "a")
    try:
        fcntl.flock(lockf, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        log("skip previous run still going")
        return 0

    t0 = time.time()
    outcome, summary, reason = run_scraper()
    st = load_state()
    msg = decide(st, outcome, summary, reason)
    sent = ""
    if msg:
        try:
            nanoclaw_ipc.send_message(GROUP, nanoclaw_ipc.group_jid(GROUP), msg)
            sent = " alert-sent"
        except Exception as e:
            sent = " alert-FAILED(%s)" % e
            print("could not queue Telegram message: %s" % e, file=sys.stderr)
    save_state(st)
    s = summary or {}
    log("outcome=%s due=%s scraped=%s errors=%s cookie=%s/%s bad_streak=%d %.0fs%s%s"
        % (outcome, s.get("due_count", "-"), s.get("scraped", "-"), s.get("errors", "-"),
           s.get("cookie_refresh", "-"), s.get("cookie_source", "-"), st["consecutive_bad"],
           time.time() - t0, sent, (" reason=" + reason) if reason else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
