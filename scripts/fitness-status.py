#!/usr/bin/env python3
"""
Nightly NanoClaw status → markdown: every scheduled task with its latest run,
plus the Health Heartbeat freshness shown on the dashboard.

Reads the host health-probe snapshot (mounted read-only into the fitness group
at /workspace/extra/health-probe), not store/messages.db — that DB also holds
every chat. scripts/heartbeat.sh refreshes tasks.txt and timestamp.txt every
5 minutes. A missing/unreadable snapshot marks its section "unavailable"; the
file is still written.

Usage (fitness container):
  python3 /home/node/nanoclaw/scripts/fitness-status.py \\
      --out /workspace/group/publish/status.md
"""
import argparse
import os
import sys
from datetime import datetime, timezone

HEARTBEAT_STALE_MIN = 15  # heartbeat runs every 5 min


def local(ts: str) -> str:
    if not ts:
        return "never"
    dt = datetime.fromisoformat(ts.replace("Z", "+00:00")).astimezone()
    return dt.strftime("%Y-%m-%d %H:%M")


def duration(ms: str) -> str:
    if not ms:
        return "—"
    s = int(ms) // 1000
    return f"{s // 60}m{s % 60:02d}s" if s >= 60 else f"{s}s"


def schedule(kind: str, value: str) -> str:
    if kind == "cron":
        return f"`{value}`"
    if kind == "interval":
        return f"every {int(value) // 60000} min"
    return f"once {local(value)}"


def tasks_section(path: str) -> list[str]:
    out = [
        "## Scheduled tasks",
        "",
        "| Task | Schedule | State | Last run | Outcome | Duration |",
        "|---|---|---|---|---|---|",
    ]
    with open(path) as f:
        for line in f:
            parts = line.rstrip("\n").split("|")
            if len(parts) != 8:
                continue
            tid, name, kind, value, state, run_at, outcome, ms = parts
            out.append(
                f"| {name or tid} | {schedule(kind, value)} | {state} | {local(run_at)} | "
                f"{outcome or '—'} | {duration(ms)} |"
            )
    mtime = datetime.fromtimestamp(os.path.getmtime(path)).astimezone()
    out += ["", f"Snapshot taken {mtime.strftime('%Y-%m-%d %H:%M')}."]
    return out


def heartbeat_section(path: str) -> list[str]:
    with open(path) as f:
        ts = f.read().strip()
    last = datetime.fromisoformat(ts.replace("Z", "+00:00"))
    age = int((datetime.now(timezone.utc) - last).total_seconds() // 60)
    state = "ok" if age <= HEARTBEAT_STALE_MIN else "STALE"
    return [
        "## Dashboard heartbeat",
        "",
        f"- Health Heartbeat (`com.nanoclaw.heartbeat`, every 5 min): last {local(ts)}, "
        f"{age} min ago — {state}",
    ]


def main() -> int:
    ap = argparse.ArgumentParser(description="NanoClaw status → markdown")
    ap.add_argument("--out", required=True)
    ap.add_argument("--probe-dir", default="/workspace/extra/health-probe")
    args = ap.parse_args()

    now = datetime.now().astimezone()
    lines = [f"# NanoClaw status — generated {now.isoformat(timespec='seconds')}", ""]
    failures = 0
    for title, fn, name in (
        ("Scheduled tasks", tasks_section, "tasks.txt"),
        ("Dashboard heartbeat", heartbeat_section, "timestamp.txt"),
    ):
        try:
            lines += fn(os.path.join(args.probe_dir, name))
        except Exception as e:  # noqa: BLE001 — each section degrades independently
            failures += 1
            print(f"[fitness-status] {title}: {type(e).__name__}: {e}", file=sys.stderr)
            lines += [f"## {title}", "", "unavailable"]
        lines.append("")

    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    tmp = args.out + ".tmp"
    with open(tmp, "w") as f:
        f.write("\n".join(lines).rstrip() + "\n")
    os.replace(tmp, args.out)
    print(f"wrote {args.out} ({failures} section(s) unavailable)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
