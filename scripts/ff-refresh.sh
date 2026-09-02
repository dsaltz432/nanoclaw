#!/usr/bin/env bash
#
# Fantasy football DATA refresh. Runs on the HOST via launchd, in two flavours:
#
#   ff-refresh.sh live     every 2h  — transactions, matchups, FAAB, ROSTERS
#   ff-refresh.sh daily    06:40     — projections, ownership, market values
#
# Companion to ff-news.sh, which refreshes only news every 15 minutes. Same
# reasoning as that script: this is a data pull with no judgement in it, so it
# is a shell script rather than a NanoClaw scheduled task, and it therefore
# CANNOT message anyone — there is no send_message to call. Alerting, when it
# is wanted, is a separate task reading data this job has made fresh.
#
# ── why the extra roster step ────────────────────────────────────────────────
#
# `ff.cli live` does NOT refresh roster contents, despite labelling one of its
# steps "rosters:<league>". That step calls sleeper.ingest_faab_snapshot, which
# writes the faab_snapshots table only. The player list on a roster is written
# by sleeper.ingest_league_chain, which is called from pipeline.backfill — the
# one-time seasonal setup — and from nothing that runs on a schedule.
#
# The visible symptom: you add a player, `sleeper.transactions` picks the
# transaction up, and the roster panel still shows the man you dropped, because
# `rosters.players` has not been rewritten since the league was first set up.
#
# So this script calls ingest_league_chain itself, with max_seasons=1: the
# current season only, which is three cheap calls per league rather than the
# ten-season walk backfill does. The proper fix is to add the step to
# pipeline.live in the fantasy-football-agent repo; doing it here keeps that
# repo — which also feeds the Telegram agent — untouched.
#
# ── and the same again for schedules ─────────────────────────────────────────
#
# nflverse.ingest_schedules has the identical shape of problem: called from
# pipeline.backfill and from nothing periodic, while ff/api.py reads
# total_line and spread_line out of that table for game environment. Those are
# VEGAS LINES. They move on exactly the injury news the rest of this system
# tracks, and each week's lines are posted about a week ahead — so left alone
# the table goes stale where it has numbers and empty where it does not.
# One CSV from GitHub, so it rides along with the daily flavour.

set -uo pipefail

MODE="${1:-live}"
if [[ "${MODE}" != "live" && "${MODE}" != "daily" ]]; then
    echo "usage: $(basename "$0") [live|daily]" >&2
    exit 2
fi

FF_DIR="${FF_ROOT:-${HOME}/Documents/repositories/fantasy-football-agent}"
LOCK="/tmp/nanoclaw-ff-refresh.lock"

stamp() { date -u +%Y-%m-%dT%H:%M:%SZ; }

if [ ! -d "${FF_DIR}/ff" ]; then
    echo "$(stamp) FATAL ff package not found at ${FF_DIR}" >&2
    exit 1
fi

# One run at a time, and note this lock is SHARED between the live and daily
# flavours on purpose: both write the same SQLite file, and 06:40 is inside the
# 2-hourly grid, so the two will collide roughly once a day by construction.
exec 9>"${LOCK}"
if ! flock -n 9 2>/dev/null; then
    if [ -s "${LOCK}" ] && kill -0 "$(cat "${LOCK}" 2>/dev/null)" 2>/dev/null; then
        echo "$(stamp) SKIP previous run still going (pid $(cat "${LOCK}"))"
        exit 0
    fi
fi
echo $$ > "${LOCK}"

cd "${FF_DIR}" || exit 1

echo "$(stamp) START ${MODE}"
python3 -m ff.cli "${MODE}"
STATUS=$?

if [ "${STATUS}" -ne 0 ]; then
    echo "$(stamp) FAIL ff.cli ${MODE} exited ${STATUS}" >&2
    exit "${STATUS}"
fi

# Schedules / Vegas lines — see the header. Daily is enough: lines drift within
# a day but not in a way a waiver or trade decision turns on, and this is one
# CSV fetch for the whole season.
if [ "${MODE}" = "daily" ]; then
    python3 - <<'PY'
import sys
sys.path.insert(0, ".")
from ff import db
from ff.sources import nflverse

conn = db.connect()
try:
    n = nflverse.ingest_schedules(conn)
    print("  ok    nflverse.schedules                 %d" % n)
except Exception as exc:
    print("  FAIL  nflverse.schedules                 %s" % exc)
    raise
conn.commit()
PY
    SSTATUS=$?
    if [ "${SSTATUS}" -ne 0 ]; then
        echo "$(stamp) FAIL schedules refresh exited ${SSTATUS}" >&2
        exit "${SSTATUS}"
    fi
fi

# Rosters — see the header. Only on the live flavour; the daily one runs two
# hours after a live run at most and the roster contents will not have moved.
if [ "${MODE}" = "live" ]; then
    python3 - <<'PY'
import sys
sys.path.insert(0, ".")
from ff import db
from ff.pipeline import league_ids, current_state, CURRENT_SEASON
from ff.views import target_week
from ff.sources import sleeper

conn = db.connect()
tseason, _ = target_week(conn, current_state(conn))
season = int(tseason or CURRENT_SEASON)
total = 0
for key, lid in league_ids(conn, season).items():
    try:
        n = sleeper.ingest_league_chain(conn, key, lid, max_seasons=1)
        total += n
        print("  ok    rosters:%-11s %d" % (key, n))
    except Exception as exc:                      # one bad league must not
        print("  FAIL  rosters:%-11s %s" % (key, exc))   # cost the others
conn.commit()
print("rosters refreshed, %d rows" % total)
PY
    RSTATUS=$?
    if [ "${RSTATUS}" -ne 0 ]; then
        echo "$(stamp) FAIL roster refresh exited ${RSTATUS}" >&2
        exit "${RSTATUS}"
    fi
fi

echo "$(stamp) ok ${MODE}"
