#!/usr/bin/env python3
"""
Deterministic GitHub side of the medical ingest PR flow. The agent does the
judgement (review, edits, replies); this does the bookkeeping.

  sync --shared-folder ID     run first, every night. Prints one JSON object:
      - brings the checkout to an up-to-date main (fast-forward only; refuses a
        dirty tree rather than discarding anything)
      - tracks every ingest/* PR: open / merged / closed-unmerged. A PR closed
        without merging is a rejection: its notes go on the rejected list and
        are never re-proposed (they stay pending for Cowork /ingest-updates).
      - new comments on the open PR since last handled (the agent's own
        comments carry NANOCLAW_MARK and are skipped — both are posted from
        Daniel's account, so author can't tell them apart)
      - uploads agents/appointment-card.md to Drive › Agents › shared whenever
        its content on main changed since the last upload
      - audit: any commit on main authored by the agent identity that did not
        arrive through a PR is reported as an alert (GitHub Free has no branch
        protection, so this is the after-the-fact check)
      - "claimed_titles": titles already in the open PR or rejected — pass to
        medical-inbox.py --exclude so they aren't proposed again
  record-pr --number N --titles-file F   remember which note titles a PR carries
  mark-seen --number N --until AT        comments up to AT (the "at" of the last
                                         comment handled) are done

State: /workspace/group/state/github.json. Token: the group's
.claude/github-token (repo-scoped fine-grained PAT).
"""
import argparse
import json
import os
import subprocess
import sys
from datetime import datetime, timezone

import requests

SLUG = "dsaltz432/daniel-medical-history"
API = f"https://api.github.com/repos/{SLUG}"
REPO_DIR = os.environ.get("MEDICAL_REPO_DIR", "/workspace/extra/repo")
TOKEN_FILE = os.environ.get("MEDICAL_GITHUB_TOKEN_FILE", "/home/node/.claude/github-token")
STATE = os.environ.get("MEDICAL_GITHUB_STATE", "/workspace/group/state/github.json")
WRAPPER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "medical-repo.sh")
AGENT_EMAIL = "dsaltzai@gmail.com"
AGENT_NAME = "NanoClaw medical ingest"
NANOCLAW_MARK = "<!-- nanoclaw-medical -->"
CARD = "agents/appointment-card.md"


def now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def load_state() -> dict:
    try:
        with open(STATE) as f:
            return json.load(f)
    except FileNotFoundError:
        return {"prs": {}, "rejected_titles": [], "main_sha": None, "card_blob": None}


def save_state(state: dict) -> None:
    os.makedirs(os.path.dirname(STATE), exist_ok=True)
    tmp = STATE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(state, f, indent=2, ensure_ascii=False, sort_keys=True)
    os.replace(tmp, STATE)


class GitHub:
    def __init__(self):
        with open(TOKEN_FILE) as f:
            token = f.read().strip()
        self.s = requests.Session()
        self.s.headers.update({
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        })

    def get(self, path: str, **params):
        r = self.s.get(f"{API}{path}", params=params, timeout=30)
        r.raise_for_status()
        return r.json()

    def pages(self, path: str, **params):
        out, page = [], 1
        while True:
            batch = self.get(path, per_page=100, page=page, **params)
            out += batch
            if len(batch) < 100:
                return out
            page += 1


def git(*args: str) -> str:
    r = subprocess.run([WRAPPER, "git", *args], capture_output=True, text=True)
    if r.returncode:
        raise RuntimeError(f"git {' '.join(args)}: {r.stderr.strip()[:300]}")
    return r.stdout.strip()


def sync_checkout(alerts: list) -> bool:
    if git("status", "--porcelain"):
        alerts.append("Checkout has uncommitted changes — skipped tonight so nothing is lost. "
                      "Commit or discard them in ~/Documents/repositories/daniel-medical-history.")
        return False
    git("fetch", "-q", "--prune", "origin")
    git("checkout", "-q", "main")
    try:
        git("merge", "-q", "--ff-only", "origin/main")
    except RuntimeError:
        alerts.append("Local main has diverged from origin/main — skipped tonight. Reconcile the "
                      "checkout by hand.")
        return False
    return True


def new_comments(gh: GitHub, number: int, since: str | None) -> list[dict]:
    items = []
    for c in gh.pages(f"/issues/{number}/comments"):
        items.append({"kind": "comment", "at": c["created_at"], "body": c["body"] or "",
                      "url": c["html_url"]})
    for c in gh.pages(f"/pulls/{number}/comments"):
        items.append({"kind": "line comment", "at": c["created_at"], "body": c["body"] or "",
                      "path": c.get("path"), "line": c.get("line"), "url": c["html_url"]})
    for r in gh.pages(f"/pulls/{number}/reviews"):
        if r.get("body"):
            items.append({"kind": f"review ({r['state'].lower()})", "at": r["submitted_at"],
                          "body": r["body"], "url": r["html_url"]})
    items = [i for i in items if NANOCLAW_MARK not in i["body"] and (not since or i["at"] > since)]
    return sorted(items, key=lambda i: i["at"])


def audit_main(gh: GitHub, since_sha: str | None, head_sha: str) -> list[str]:
    if not since_sha or since_sha == head_sha:
        return []
    alerts = []
    for c in gh.get(f"/compare/{since_sha}...{head_sha}").get("commits", []):
        a = c["commit"]["author"]
        if a.get("email") == AGENT_EMAIL and a.get("name") == AGENT_NAME:
            if not gh.get(f"/commits/{c['sha']}/pulls"):
                alerts.append(f"Commit {c['sha'][:7]} on main was pushed directly by the agent, "
                              f"not via a PR: {c['commit']['message'].splitlines()[0]}")
    return alerts


def sync_card(state: dict, folder: str) -> str | None:
    blob = git("rev-parse", f"HEAD:{CARD}")
    if blob == state.get("card_blob"):
        return None
    r = subprocess.run(
        [sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)), "drive-put.py"),
         os.path.join(REPO_DIR, CARD), folder, "--name", "appointment-card.md",
         "--mime", "text/markdown"],
        capture_output=True, text=True,
    )
    if r.returncode:
        raise RuntimeError(f"card upload failed: {r.stderr.strip()[:300]}")
    state["card_blob"] = blob
    return r.stdout.strip()


def cmd_sync(args) -> int:
    state = load_state()
    out = {"ok": True, "alerts": [], "open_pr": None, "merged": [], "rejected": [],
           "card_upload": None}
    try:
        gh = GitHub()
    except OSError as e:
        print(json.dumps({"ok": False, "error": f"no GitHub token: {e}"}))
        return 1

    try:
        if not sync_checkout(out["alerts"]):
            out["ok"] = False
            print(json.dumps(out, indent=2))
            return 0
        head = git("rev-parse", "HEAD")
        out["alerts"] += audit_main(gh, state.get("main_sha"), head)
        state["main_sha"] = head

        for pr in gh.pages("/pulls", state="all", sort="created", direction="desc"):
            ref = pr["head"]["ref"]
            if not ref.startswith("ingest/"):
                continue
            key = str(pr["number"])
            rec = state["prs"].setdefault(key, {"titles": [], "last_seen": None, "status": None})
            status = "merged" if pr.get("merged_at") else pr["state"]  # open | closed | merged
            if status != rec["status"]:
                if status == "merged" and rec["status"] is not None:
                    out["merged"].append({"number": pr["number"], "url": pr["html_url"]})
                if status == "closed":
                    out["rejected"].append({"number": pr["number"], "url": pr["html_url"],
                                            "titles": rec["titles"]})
                    state["rejected_titles"] = sorted(set(state["rejected_titles"]) | set(rec["titles"]))
                rec["status"] = status
            if status == "open" and out["open_pr"] is None:
                out["open_pr"] = {
                    "number": pr["number"], "url": pr["html_url"], "branch": ref,
                    "titles": rec["titles"],
                    "new_comments": new_comments(gh, pr["number"], rec["last_seen"]),
                }

        try:
            out["card_upload"] = sync_card(state, args.shared_folder)
        except (RuntimeError, OSError) as e:
            out["alerts"].append(str(e))

        open_titles = out["open_pr"]["titles"] if out["open_pr"] else []
        out["claimed_titles"] = sorted(set(open_titles) | set(state["rejected_titles"]))
    except (requests.RequestException, RuntimeError) as e:
        print(json.dumps({"ok": False, "error": str(e)[:500]}))
        return 1
    finally:
        save_state(state)

    print(json.dumps(out, indent=2, ensure_ascii=False))
    return 0


def cmd_record_pr(args) -> int:
    with open(args.titles_file) as f:
        titles = json.load(f)
    state = load_state()
    rec = state["prs"].setdefault(str(args.number), {"titles": [], "last_seen": None, "status": "open"})
    rec["titles"] = sorted(set(rec["titles"]) | set(titles))
    rec["status"] = rec["status"] or "open"
    if rec["last_seen"] is None:
        rec["last_seen"] = now()
    save_state(state)
    print(json.dumps({"number": args.number, "titles": rec["titles"]}))
    return 0


def cmd_mark_seen(args) -> int:
    state = load_state()
    state["prs"].setdefault(str(args.number), {"titles": [], "last_seen": None, "status": "open"})
    state["prs"][str(args.number)]["last_seen"] = args.until
    save_state(state)
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="Medical ingest PR bookkeeping")
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("sync")
    s.add_argument("--shared-folder", required=True, help="Drive folder for appointment-card.md")
    r = sub.add_parser("record-pr")
    r.add_argument("--number", type=int, required=True)
    r.add_argument("--titles-file", required=True, help="JSON list of exact note titles")
    m = sub.add_parser("mark-seen")
    m.add_argument("--number", type=int, required=True)
    m.add_argument("--until", required=True, help='"at" of the last comment handled')
    args = ap.parse_args()
    return {"sync": cmd_sync, "record-pr": cmd_record_pr, "mark-seen": cmd_mark_seen}[args.cmd](args)


if __name__ == "__main__":
    sys.exit(main())
