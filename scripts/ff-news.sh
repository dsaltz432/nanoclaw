#!/usr/bin/env bash
#
# Fantasy football news refresh. Runs on the HOST every 15 minutes via launchd.
#
# Deliberately not a NanoClaw scheduled task. This is a data pull with no
# judgement in it — fetch Sleeper's player index, then fetch notes for the
# players whose `news_updated` moved. No agent needs to read anything, so
# spawning a container to do it would burn tokens on work a shell script does
# in six seconds.
#
# It also means this job CANNOT message anyone. Silence is structural rather
# than a prompt asking an agent to stay quiet — there is no send_message to
# call and no final output to filter. When alerting is wanted later, that is a
# separate NanoClaw task reading data this job has already made fresh.
#
# Why the two steps, in this order:
#   sleeper.ingest_players   one call, ~1s. Carries `news_updated` per player,
#                            which is the change detector the news layer keys
#                            on. Skipping it means the next step looks for
#                            changes against a stale index and finds nothing.
#   espn.ingest_news         one call per CHANGED player. ~300 of 8,193 players
#                            have news in any 48h window, so on a quiet
#                            fifteen minutes this is a handful of requests.
#
# Cost measured on this machine: 0.9s + 5.4s = ~6s per run against a 2h window.
# A 126h catch-up took 45s, which is the worst case if the job has been off.
#
# The 2h window against a 15 minute interval is deliberate overlap. Notes are
# occasionally republished with a corrected timestamp, and the ingest is
# idempotent (note_id is a content hash), so re-reading the last two hours
# costs a few requests and closes the gap that clock skew or a missed run
# would otherwise leave.

set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FF_DIR="${FF_ROOT:-${HOME}/Documents/repositories/fantasy-football-agent}"
LOCK="/tmp/nanoclaw-ff-news.lock"
WINDOW_HOURS="${FF_NEWS_WINDOW_HOURS:-2}"

stamp() { date -u +%Y-%m-%dT%H:%M:%SZ; }

if [ ! -d "${FF_DIR}/ff" ]; then
  echo "$(stamp) FATAL ff package not found at ${FF_DIR}" >&2
  exit 1
fi

# One run at a time. A catch-up run after downtime can take 45s; at a 15 minute
# interval that will never collide, but a hung network call could, and two
# processes writing the same SQLite file is not worth finding out about later.
exec 9>"${LOCK}"
if ! flock -n 9 2>/dev/null; then
  # macOS has no flock(1) by default; fall back to a pid check.
  if [ -s "${LOCK}" ] && kill -0 "$(cat "${LOCK}" 2>/dev/null)" 2>/dev/null; then
    echo "$(stamp) SKIP previous run still going (pid $(cat "${LOCK}"))"
    exit 0
  fi
fi
echo $$ > "${LOCK}"

cd "${FF_DIR}" || exit 1

OUT=$(python3 - "${WINDOW_HOURS}" <<'PY' 2>&1
import sys, time
sys.path.insert(0, ".")
from ff import db
from ff.sources import sleeper, espn

hours = int(sys.argv[1])
conn = db.connect()
t0 = time.time()
# Count rows either side, because the ingest upsert count is "notes seen in the
# window", not "notes that are new" -- it reports the same number every run and
# would make a job that has stopped working look identical to one that is.
before = conn.execute("SELECT COUNT(*) FROM news").fetchone()[0]
players = sleeper.ingest_players(conn)
seen = espn.ingest_news(conn, hours=hours, limit=400)
after = conn.execute("SELECT COUNT(*) FROM news").fetchone()[0]
print("players=%d seen=%d new=%d total=%d elapsed=%.1fs"
      % (players, seen, after - before, after, time.time() - t0))
PY
)
STATUS=$?

if [ "${STATUS}" -ne 0 ]; then
  echo "$(stamp) FAIL ${OUT}" >&2
  exit "${STATUS}"
fi

echo "$(stamp) ok ${OUT}"
