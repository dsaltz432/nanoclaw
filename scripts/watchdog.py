#!/usr/bin/env python3
"""
Health Watchdog — host job, every 30 min (:02 and :32) via com.nanoclaw.watchdog.

Replaces the "Health Watchdog" NanoClaw scheduled task (2026-11-24). That task
ran an Opus agent every 30 minutes against a ~500-line prompt: ~18 shell
commands per run, ~$0.35 a run, ~$17/day. Every check in it is a fixed rule,
and most of the prompt was a record of the agent misapplying those rules
(transient "missing" files, months-old log lines read as current, invented
re-alert intervals). Code applies them the same way every time.

Same 13 checks, same thresholds, same finding keys, same state file
(groups/telegram_ops/watchdog-state.json, whose mtime heartbeat.sh uses as
"is the watchdog alive"), same alert format, same chat (telegram_ops). It reads
the host files directly instead of through a Docker bind mount, which removes
the transient-missing-file problem at its source; two-run confirmation is kept
for the same findings anyway.

Dedupe:
  normal  alert on first sight; re-alert if it clears and comes back, or 24h
          after the last alert while it persists.
  once    keys that are unique per event (a failed task run, a crash, a
          container log, a dropped message): alert once, never again.
  confirm alert only if seen on two consecutive runs (pending{} in state).

  scripts/watchdog.py            normal run
  scripts/watchdog.py --dry-run  evaluate and print; send nothing, save nothing
"""
from __future__ import annotations

import glob
import hashlib
import json
import os
import re
import sqlite3
import subprocess
import sys
import time
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import nanoclaw_ipc  # noqa: E402

ROOT = nanoclaw_ipc.PROJECT_ROOT
PROBE = os.path.join(ROOT, "data/health-probe")
DB = os.path.join(ROOT, "store/messages.db")
HOST_LOGS = os.path.join(ROOT, "logs")
GROUPS = os.path.join(ROOT, "groups")
TICKETS_DB = os.path.join(ROOT, "data/sessions/tickets/.claude/tickets.db")
STATE = os.path.join(GROUPS, "telegram_ops/watchdog-state.json")
PRICER_STATE = os.path.expanduser("~/.local/share/nanoclaw/state/tickets-pricer.json")
GROUP = "telegram_ops"

NOW = datetime.now(timezone.utc)
REALERT = timedelta(hours=24)

EXPECTED_LABELS = [
    "com.nanoclaw", "com.nanoclaw.dashboard", "com.nanoclaw.heartbeat", "com.nanoclaw.caffeinate",
    "com.nanoclaw.email-metadata", "com.nanoclaw.briefing-upload", "com.nanoclaw.trip-briefing-upload",
    "com.nanoclaw.spotify-cleanup", "com.nanoclaw.backup", "com.nanoclaw.backup-verify",
    "com.nanoclaw.ff-news", "com.nanoclaw.ff-daily", "com.nanoclaw.ff-live", "com.nanoclaw.ha-probe",
    "com.nanoclaw.tickets-pricer", "com.nanoclaw.watchdog",
]
LONG_LIVED = {"com.nanoclaw", "com.nanoclaw.dashboard", "com.nanoclaw.caffeinate"}
SELF_EXCLUDED_TASKS = {"Health Watchdog", "Ticket Pricer"}
HA_NOTE = " _(diagnose from the laptop with the home-assistant skill; no automatic fixes)_"


def iso(d: datetime) -> str:
    return d.strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_iso(s: str) -> datetime | None:
    """ISO-ish timestamp -> aware UTC datetime. Fractions are dropped; no
    offset means UTC (every timestamp NanoClaw and the probes write is UTC)."""
    m = re.match(r"\s*(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.\d+)?\s*(Z|[+-]\d{2}:?\d{2})?", s or "")
    if not m:
        return None
    d = datetime.strptime(m.group(1) + "T" + m.group(2), "%Y-%m-%dT%H:%M:%S")
    off = m.group(3)
    if off and off != "Z":
        sign = 1 if off[0] == "+" else -1
        hh, mm = int(off[1:3]), int(off[-2:])
        d = d - sign * timedelta(hours=hh, minutes=mm)
    return d.replace(tzinfo=timezone.utc)


class Findings:
    def __init__(self):
        self.items = []   # (level, key, text, mode)

    def add(self, level, key, text, mode="normal"):
        self.items.append((level, key, text, mode))


def read_probe(name: str) -> str | None:
    """None = missing or (for anything but restarts.txt) empty."""
    p = os.path.join(PROBE, name)
    for _ in range(3):
        if os.path.exists(p):
            try:
                txt = open(p, errors="replace").read()
            except OSError:
                txt = None
            if txt is not None:
                if txt.strip() == "" and name != "restarts.txt":
                    return None
                return txt
        time.sleep(1)
    return None


def db_connect(path):
    return sqlite3.connect("file:%s?mode=ro" % path, uri=True, timeout=10)


def db_query(sql, args=()):
    last = None
    for attempt in range(2):
        try:
            c = db_connect(DB)
            try:
                return c.execute(sql, args).fetchall()
            finally:
                c.close()
        except sqlite3.DatabaseError as e:
            last = e
            time.sleep(10)
    raise last


# ---------------------------------------------------------------- checks

def check_snapshot(f: Findings):
    ts = read_probe("timestamp.txt")
    t = parse_iso(ts) if ts else None
    if t is None or NOW - t > timedelta(minutes=15):
        f.add("critical", "probe-stale:timestamp.txt",
              "Host health probe is stale — heartbeat plist may be dead (timestamp.txt %s)"
              % ("missing" if ts is None else "from " + ts.strip()), "confirm")
    return t


def check_launchd(f: Findings):
    txt = read_probe("launchctl.txt")
    if txt is None:
        f.add("high", "probe-missing:launchctl.txt", "Probe file launchctl.txt is missing or empty", "confirm")
        return
    rows = {}
    for line in txt.splitlines():
        parts = line.split()
        if len(parts) >= 3:
            rows[parts[2]] = (parts[0], parts[1])
    for label in EXPECTED_LABELS:
        if label not in rows:
            f.add("critical", "service-missing:%s" % label, "Service `%s` not registered with launchd" % label)
            continue
        pid, code = rows[label]
        if label in LONG_LIVED and pid == "-":
            f.add("critical", "service-down:%s" % label, "Service `%s` is not running" % label)
        if code not in ("0", "143", "-15"):
            f.add("high", "service-exit:%s:%s" % (label, code), "Service `%s` last exited with code %s" % (label, code))


def check_task_errors(f: Findings):
    rows = db_query("""
        SELECT t.name, t.id, l.run_at, COALESCE(l.error, '(no error message)')
        FROM task_run_logs l JOIN scheduled_tasks t ON t.id = l.task_id
        WHERE l.status = 'error' AND l.run_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-24 hours')
        ORDER BY l.run_at DESC""")
    for name, tid, run_at, err in rows:
        if name in SELF_EXCLUDED_TASKS:
            continue
        f.add("high", "task-error:%s:%s" % (tid, run_at),
              'Task "%s" errored at %s UTC: %s' % (name, run_at[:16].replace("T", " "), err.strip().splitlines()[0][:200] if err.strip() else err),
              "once")


def check_overdue(f: Findings):
    rows = db_query("""
        SELECT name, id, next_run FROM scheduled_tasks
        WHERE status = 'active' AND next_run IS NOT NULL
          AND datetime(next_run) < datetime('now', '-1 hour')""")
    for name, tid, nxt in rows:
        f.add("high", "task-overdue:%s" % tid,
              'Task "%s" is >1h overdue: expected at %s, now %s' % (name, nxt, iso(NOW)))


TRACE_RE = re.compile(r"(Traceback \(most recent call last\)|Unhandled|unhandledRejection|^panic:|FATAL|^Error: |^\s+at .+\(.+:\d+:\d+\)$)")


def container_log_findings(path: str, group: str):
    """Return [(level, key, text)] for one container log."""
    out = []
    base = os.path.basename(path)
    try:
        txt = open(path, errors="replace").read()
    except OSError:
        return out
    head = txt[:3000]
    first = txt.splitlines()[0] if txt else ""
    m = re.search(r"^Exit Code: (-?\d+)", head, re.M)
    code = int(m.group(1)) if m else None
    timeout_log = "(TIMEOUT)" in first
    streamed = "Had Streaming Output: true" in head
    if timeout_log:
        if not streamed:
            out.append(("high", "container-exit:%s:%s" % (group, base),
                        "Container run in group `%s` timed out having produced nothing (%s)" % (group, base)))
    elif code not in (0, None):
        reason = ""
        se = txt.split("=== Stderr ===", 1)
        if len(se) > 1:
            lines = [l for l in se[1].splitlines() if l.strip() and not l.startswith("[agent-runner]")]
            errl = [l for l in lines if re.search(r"(Error|error|failed|Fatal|No conversation)", l)]
            reason = (errl or lines or [""])[-1].strip()[:180]
        out.append(("high", "container-exit:%s:%s" % (group, base),
                    "Container run in group `%s` exited with code %d (%s)%s"
                    % (group, code, base, (': "%s"' % reason) if reason else "")))
    # stack traces in stderr (non-agent-runner lines only — the agent-runner
    # echoes tool output, and a tool printing "Error:" is not a crash)
    se = txt.split("=== Stderr ===", 1)
    if len(se) > 1 and not timeout_log:
        body = se[1].split("=== Stdout ===", 1)[0]
        hits = [l for l in body.splitlines() if not l.startswith("[agent-runner]") and TRACE_RE.search(l)]
        if hits and code == 0:
            out.append(("high", "container-trace:%s:%s" % (group, base),
                        "Container in group `%s` logged a stack trace (%s): `%s`" % (group, base, hits[0].strip()[:160])))
        tools = re.findall(r"tool=(mcp__[A-Za-z0-9_]+)", body)
        counts = {}
        for t in tools:
            counts[t] = counts.get(t, 0) + 1
        for t, n in counts.items():
            if n > 20:
                out.append(("high", "container-loop:%s:%s" % (group, base),
                            "Possible tool-call loop in group `%s`: %s called %d times (%s)" % (group, t, n, base)))
                break
    m = re.search(r"^Duration: (\d+)ms", head, re.M)
    if m and int(m.group(1)) > 5400000 and not (timeout_log and streamed):
        out.append(("low", "container-slow:%s:%s" % (group, base),
                    "Container in group `%s` ran for %dm (%s)" % (group, int(m.group(1)) // 60000, base)))
    return out


def check_container_logs(f: Findings):
    cutoff = time.time() - 3600
    for path in glob.glob(os.path.join(GROUPS, "*/logs/container-*.log")):
        group = path.split(os.sep)[-3]
        if group == "telegram_ops":
            continue
        try:
            if os.path.getmtime(path) < cutoff:
                continue
        except OSError:
            continue
        for level, key, text in container_log_findings(path, group):
            f.add(level, key, text, "once")


ERRLINE_RE = re.compile(r"(Error:|Exception:|Fatal|ERROR )")


def check_error_logs(f: Findings):
    cutoff = time.time() - 3600
    for path in sorted(glob.glob(os.path.join(HOST_LOGS, "*.error.log"))):
        try:
            if os.path.getmtime(path) < cutoff or os.path.getsize(path) == 0:
                continue
            mtime = datetime.fromtimestamp(os.path.getmtime(path), timezone.utc)
            lines = open(path, errors="replace").read().splitlines()[-50:]
        except OSError:
            continue
        for line in lines:
            if ERRLINE_RE.search(line):
                h = hashlib.sha1(line.encode()).hexdigest()[:12]
                f.add("high", "service-error:%s:%s" % (os.path.basename(path), h),
                      "`%s` (written %s UTC): `%s`" % (os.path.basename(path), mtime.strftime("%H:%M"), line.strip()[:200]))


def check_disk(f: Findings):
    txt = read_probe("disk.txt")
    if txt is None:
        f.add("high", "probe-missing:disk.txt", "Probe file disk.txt is missing or empty", "confirm")
        return
    try:
        pct = int(txt.split()[4].rstrip("%"))
    except (IndexError, ValueError):
        return
    if pct > 95:
        f.add("critical", "disk:critical", "Host disk at %d%% — clean up now" % pct)
    elif pct > 90:
        f.add("high", "disk:high", "Host disk at %d%% — clean up before it fills" % pct)


def check_tickets(f: Findings):
    if os.path.exists(TICKETS_DB):
        try:
            c = db_connect(TICKETS_DB)
            row = c.execute("""
                SELECT COUNT(DISTINCT e.id), MAX(ps.polled_at),
                       ROUND((julianday('now') - julianday(MAX(ps.polled_at))) * 24, 1),
                       MIN(e.event_datetime)
                FROM events e LEFT JOIN price_snapshots ps ON ps.event_id = e.id
                WHERE e.event_datetime > datetime('now') AND e.status != 'cancelled'""").fetchone()
            c.close()
        except sqlite3.DatabaseError:
            row = None
        if row and row[0]:
            n, last, hrs, soonest = row
            if last is None:
                f.add("high", "tickets-stale", "Tickets: no price snapshots in DB despite %d upcoming events" % n)
            else:
                sd = parse_iso(soonest.replace(" ", "T")) if soonest else None
                h_out = (sd - NOW).total_seconds() / 3600 if sd else 1e9
                limit = 1 if h_out < 6 else 2 if h_out < 24 else 6 if h_out < 168 else 30
                if hrs is not None and hrs > 48:
                    f.add("critical", "tickets-stale-critical", "Tickets: last price snapshot was %.1f hours ago" % hrs)
                elif hrs is not None and hrs > limit:
                    f.add("high", "tickets-stale",
                          "Tickets: last price snapshot was %.1f hours ago — data may be stale (soonest event in ~%.0fh, threshold %dh)"
                          % (hrs, h_out, limit))
    # the pricer job itself failing to run (docker problem, script crash).
    # Scrape failures (403s) are the pricer's own alert in the tickets chat.
    try:
        ps = json.load(open(PRICER_STATE))
        if ps.get("last_outcome") == "crash" and ps.get("consecutive_bad", 0) >= 2:
            f.add("high", "tickets-pricer-crash",
                  "Ticket pricer job could not run the scraper %d times in a row: %s"
                  % (ps["consecutive_bad"], (ps.get("last_reason") or "?")[:200]))
    except Exception:
        pass


def check_jobs(f: Findings):
    txt = read_probe("jobs.txt")
    if txt is None:
        f.add("high", "job-snapshot-missing", "jobs.txt is missing — the heartbeat may be running an older script", "confirm")
        return
    for line in txt.splitlines():
        p = line.split("|")
        if len(p) < 5:
            continue
        label, kind, max_age, age, src = p[0], p[1], p[2], p[3], "|".join(p[4:])
        if kind not in ("daily", "interval", "weekly"):
            continue
        try:
            max_age, age = int(max_age), int(age)
        except ValueError:
            continue
        mode = "confirm" if label.startswith("ff-content.") else "normal"
        if age == -1:
            f.add("high", "job-nolog:%s" % label, "Job `%s` has never run / its log is missing (%s)" % (label, src), mode)
        elif age > max_age:
            extra = (" — last result: `%s`" % src[:140]) if src.startswith("FAIL:") else ""
            f.add("high", "job-stale:%s" % label,
                  "Job `%s` has not run in %d minutes — expected roughly every %d min%s" % (label, age, max_age, extra), mode)


def check_restarts(f: Findings, state):
    txt = read_probe("restarts.txt")
    if txt is None:
        return
    by_label = {}
    for line in txt.splitlines():
        p = line.split("|")
        if len(p) >= 4:
            by_label.setdefault(p[0], []).append(p)
    for label, rows in by_label.items():
        new = [r for r in rows if "service-restart:%s:%s" % (label, r[3]) not in state["alerted"]]
        if not new:
            continue
        last = new[-1]
        exitc = last[4] if len(last) > 4 else "?"
        if len(rows) >= 3:
            text = "Service `%s` is crash-looping — %d crash-restarts in the last 6h, last at %s, exit %s" % (label, len(rows), last[3], exitc)
        else:
            text = "Service `%s` crashed and restarted %d time(s), last at %s, exit %s" % (label, len(new), last[3], exitc)
        # ONE bullet per label (carried by the first new row's key); every
        # other new row's key is recorded silently so it is never re-reported.
        for i, r in enumerate(new):
            f.add("high", "service-restart:%s:%s" % (label, r[3]), text if i == 0 else None, "once")


LOG_TS_RE = re.compile(r"^\[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)\]")


def dated_log_tail():
    try:
        out = subprocess.run(["tail", "-4000", os.path.join(HOST_LOGS, "nanoclaw.log")],
                             stdout=subprocess.PIPE, stderr=subprocess.DEVNULL).stdout.decode("utf-8", "replace")
    except Exception:
        return []
    res = []
    for line in out.splitlines():
        m = LOG_TS_RE.match(line)
        if m:
            res.append((parse_iso(m.group(1)), line))
    return res


def check_delivery_and_rates(f: Findings):
    lines = dated_log_tail()
    h1, h2 = NOW - timedelta(hours=1), NOW - timedelta(hours=2)
    send_fail = {}
    last_disc, last_conn = {}, {}
    proxy = timeouts = 0
    for ts, line in lines:
        if ts is None:
            continue
        if "Max retries exceeded" in line and ts >= h2:
            f.add("high", "messages-dropped:%s" % iso(ts),
                  "Dropped messages at %s UTC — user-visible message loss: `%s`" % (iso(ts)[11:16], line[:160]), "once")
        m = re.search(r"Failed to send (\w+) message", line)
        if m and ts >= h1:
            send_fail[m.group(1)] = send_fail.get(m.group(1), 0) + 1
        m = re.search(r"\): (\w+).*\b(disconnected|disconnect)\b", line, re.I)
        if m:
            last_disc[m.group(1)] = ts
        else:
            m = re.search(r"\): (\w+).*\bconnected\b", line, re.I)
            if m:
                last_conn[m.group(1)] = ts
        if ts >= h1:
            if "Credential proxy upstream error" in line:
                proxy += 1
            if "Container timeout" in line or "Container timed out" in line:
                timeouts += 1
    for ch, n in send_fail.items():
        if n >= 3:
            f.add("high", "channel-send-failures:%s" % ch, "Failed to send %s message %d times in the last hour" % (ch, n))
    for ch, t in last_disc.items():
        if t >= h2 and (ch not in last_conn or last_conn[ch] < t):
            f.add("high", "channel-down:%s" % ch, "Channel %s appears disconnected (disconnect at %s UTC, no reconnect since)" % (ch, iso(t)[11:16]))
    if proxy > 20:
        f.add("high", "proxy-error-rate", "Credential proxy failing upstream %d times in the last hour — check network or api.anthropic.com" % proxy)
    if timeouts > 5:
        f.add("high", "container-timeout-rate", "Container timeouts: %d in the last hour" % timeouts)


def check_backup_verify(f: Findings):
    txt = read_probe("backup-verify-status.txt")
    if txt is None:
        f.add("high", "backup-verify-missing", "backup-verify-status.txt is missing — backup verification status unknown", "confirm")
        return
    p = txt.strip().split("|")
    if p[0] == "FAIL":
        f.add("critical", "backup-verify-failed:%s" % (p[1] if len(p) > 1 else "?"),
              "Backup verification failed: %s" % ("|".join(p[2:]) or "?"), "once")
    elif p[0] == "OK" and len(p) > 1:
        t = parse_iso(p[1])
        if t and NOW - t > timedelta(days=10):
            f.add("high", "backup-verify-stale", "Backup has not been verified since %s (the verifier has not run; the backup itself may be fine)" % p[1])


def check_ha(f: Findings):
    txt = read_probe("home-assistant/status.txt")
    if txt is None:
        f.add("high", "ha-probe-missing", "Home Assistant probe output missing — is com.nanoclaw.ha-probe running?" + HA_NOTE, "confirm")
        return
    kv = {}
    for line in txt.splitlines():
        if line.startswith("FINDING|"):
            p = line.split("|", 3)
            if len(p) == 4:
                sev, key, msg = p[1], p[2], p[3]
                if key in ("ha-unreachable", "ha-error"):
                    mode = "confirm"
                elif re.match(r"ha-kernel-(io-errors|usb-resets):\d+$", key):
                    # since-boot counter carried in the key: alert when it
                    # rises (a new key), never re-alert a count that sits still
                    mode = "once"
                else:
                    mode = "normal"
                f.add("critical" if sev == "critical" else "high", key, msg + HA_NOTE, mode)
        elif "=" in line:
            k, v = line.split("=", 1)
            kv[k] = v
    t = parse_iso(kv.get("probe_at", ""))
    if t is None or NOW - t > timedelta(minutes=75):
        f.add("high", "ha-probe-stale", "Home Assistant probe is stale: last run %s" % kv.get("probe_at", "?") + HA_NOTE, "confirm")


# ---------------------------------------------------------------- engine

def load_state():
    try:
        st = json.load(open(STATE))
        st.setdefault("alerted", {})
        st.setdefault("pending", {})
        return st
    except Exception:
        return {"alerted": {}, "pending": {}, "runCount": 0}


def evaluate(f: Findings, state):
    """Apply dedupe/confirmation; return list of (level, text) to send. Mutates state."""
    now = iso(NOW)
    seen = set()
    to_send = []
    for level, key, text, mode in f.items:
        if key in seen:
            continue
        seen.add(key)
        a = state["alerted"].get(key)
        if mode == "confirm" and a is not None and a.get("clearedAt"):
            # it went away and is back: confirm it again before alerting
            del state["alerted"][key]
            a = None
        if mode == "confirm" and a is None:
            if key not in state["pending"]:
                state["pending"][key] = now
                continue
        if a is None:
            if text:
                to_send.append((level, text))
            state["alerted"][key] = {"firstSeen": state["pending"].get(key, now), "lastAlerted": now,
                                     "level": level, "once": mode == "once"}
            state["pending"].pop(key, None)
            continue
        if a.get("once"):
            continue
        cleared = a.pop("clearedAt", None)
        last = parse_iso(a.get("lastAlerted", "")) or NOW
        if cleared or NOW - last >= REALERT:
            if text:
                to_send.append((level, text + (" _(back again)_" if cleared else " _(still present, first seen %s)_" % a.get("firstSeen", "?")[:10])))
            a["lastAlerted"] = now
            if cleared:
                a["firstSeen"] = now
    # bookkeeping for keys not seen this run
    for key in list(state["pending"]):
        if key not in seen:
            del state["pending"][key]
    for key, a in list(state["alerted"].items()):
        if key not in seen and not a.get("once") and "clearedAt" not in a:
            a["clearedAt"] = now
        lastA = parse_iso(a.get("lastAlerted", "")) or NOW
        if NOW - lastA > timedelta(days=7) and key not in seen:
            del state["alerted"][key]
    for key, t in list(state["pending"].items()):
        tt = parse_iso(t)
        if tt and NOW - tt > timedelta(hours=24):
            del state["pending"][key]
    return to_send


def format_message(items, snap_ts):
    order = [("critical", "Critical"), ("high", "High"), ("low", "Low")]
    age = ""
    if snap_ts:
        age = "\n\n_Snapshot age: %dm._" % max(0, int((NOW - snap_ts).total_seconds() // 60))
    if len(items) == 1:
        return "*Watchdog alert*\n\n• %s%s" % (items[0][1], age)
    parts = ["*Watchdog alert*"]
    for lvl, title in order:
        b = [t for l, t in items if l == lvl]
        if b:
            parts.append("*%s:*\n" % title + "\n".join("• " + t for t in b))
    return "\n\n".join(parts) + age


def main():
    dry = "--dry-run" in sys.argv
    state = load_state()
    f = Findings()
    snap = check_snapshot(f)
    errors = []
    for fn in (check_launchd, check_task_errors, check_overdue, check_container_logs, check_error_logs,
               check_disk, check_tickets, check_jobs, check_delivery_and_rates, check_backup_verify, check_ha):
        try:
            fn(f)
        except sqlite3.DatabaseError as e:
            f.add("high", "db-unreadable", "Cannot read store/messages.db: %s" % e, "confirm")
        except Exception as e:  # a bug in one check must not silence the others
            errors.append("%s: %r" % (fn.__name__, e))
    try:
        check_restarts(f, state)
    except Exception as e:
        errors.append("check_restarts: %r" % e)
    if errors:
        f.add("high", "watchdog-internal:" + hashlib.sha1("|".join(errors).encode()).hexdigest()[:8],
              "Watchdog script error (other checks still ran): %s" % "; ".join(errors)[:300])

    to_send = evaluate(f, state)
    state["lastRun"] = iso(NOW)
    state["runCount"] = state.get("runCount", 0) + 1
    msg = format_message(to_send, snap) if to_send else None

    if dry:
        print("findings this run:")
        for lvl, key, text, mode in f.items:
            if text:
                print("  [%s/%s] %s :: %s" % (lvl, mode, key, text))
        print("pending after run:", state["pending"])
        print("would send:" if msg else "would send: nothing")
        if msg:
            print(msg)
        return 0

    if msg:
        nanoclaw_ipc.send_message(GROUP, nanoclaw_ipc.group_jid(GROUP), msg)
    tmp = STATE + ".tmp"
    try:
        with open(tmp, "w") as fh:
            json.dump(state, fh, indent=2)
        os.rename(tmp, STATE)
    except OSError as e:
        nanoclaw_ipc.send_message(GROUP, nanoclaw_ipc.group_jid(GROUP),
                                  "*Watchdog cannot run*\n\nCannot write %s (%s)" % (STATE, e))
        raise
    print("%s findings=%d sent=%d pending=%d" % (iso(NOW), len([x for x in f.items if x[2]]), len(to_send), len(state["pending"])))
    return 0


if __name__ == "__main__":
    sys.exit(main())
