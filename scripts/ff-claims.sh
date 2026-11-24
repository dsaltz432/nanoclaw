#!/usr/bin/env bash
#
# Fantasy football claim extraction (content layer 2). Runs on the HOST every
# 15 minutes via launchd, on its own lock so a slow model call never delays
# the news pull in ff-news.sh.
#
# What it does: for up to LIMIT articles that ff-news.sh has stored and the
# extractor has not yet seen, one headless `claude -p` call each with NO tools
# attached and a JSON schema enforced, writing player-level claims to
# ff.db. See fantasy-football-agent/CONTENT-PLAN.md (layer 2) and
# ff/content/claims.py for the containment argument.
#
# Auth is NanoClaw's long-lived CLAUDE_CODE_OAUTH_TOKEN from the repo's .env —
# the same token the agent containers use — never the interactive Claude Code
# login in the keychain. That login expires and needs a human at /login: on
# 2026-10-13 it did, and this job failed for ~40 hours (87 articles stranded).
# No token in .env is a FATAL, not a quiet fallback to the keychain.
# `--bare` is deliberately NOT used by the extractor: it skips credential
# loading and every call returns "Not logged in".
#
# This job cannot message anyone. It has no send_message and its child
# process has no tools. Steady state is one to three new articles per run,
# ~6-30s each; a cold backlog drains at LIMIT per run.

set -uo pipefail

FF_DIR="${FF_ROOT:-${HOME}/Documents/repositories/fantasy-football-agent}"
NANOCLAW_ENV="${NANOCLAW_ENV:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/.env}"
LOCK="/tmp/nanoclaw-ff-claims.lock"
LIMIT="${FF_CLAIMS_LIMIT:-8}"

stamp() { date -u +%Y-%m-%dT%H:%M:%SZ; }

if [ ! -d "${FF_DIR}/ff" ]; then
  echo "$(stamp) FATAL ff package not found at ${FF_DIR}" >&2
  exit 1
fi

# The token, read without ever echoing it. Strips optional surrounding quotes.
CLAUDE_CODE_OAUTH_TOKEN="$(sed -n 's/^CLAUDE_CODE_OAUTH_TOKEN=//p' "${NANOCLAW_ENV}" 2>/dev/null \
  | head -1 | sed -e 's/^["'"'"']//' -e 's/["'"'"']$//')"
if [ -z "${CLAUDE_CODE_OAUTH_TOKEN}" ]; then
  echo "$(stamp) FATAL no CLAUDE_CODE_OAUTH_TOKEN in ${NANOCLAW_ENV}; refusing to fall back to the interactive login" >&2
  exit 1
fi
export CLAUDE_CODE_OAUTH_TOKEN
unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN  # nothing may outrank the token

# The claude CLI lives in ~/.local/bin (native installer) or, on older npm
# installs, under nvm — launchd's PATH includes neither. Put its directory on
# PATH and tell the extractor where it is, unless the operator already did.
if [ -z "${FF_CLAUDE_BIN:-}" ]; then
  # The installer's link can be briefly broken mid-update; the newest
  # version it would point to is still there (ls -t: newest first).
  newest_version="$(ls -t "${HOME}"/.local/share/claude/versions/* 2>/dev/null | head -1)"
  for c in "$(command -v claude 2>/dev/null)" "${HOME}/.local/bin/claude" "${newest_version}" "${HOME}"/.nvm/versions/node/*/bin/claude; do
    if [ -n "${c}" ] && [ -x "${c}" ] && [ -f "${c}" ]; then FF_CLAUDE_BIN="${c}"; break; fi
  done
fi
if [ -z "${FF_CLAUDE_BIN:-}" ]; then
  echo "$(stamp) FATAL claude CLI not found; set FF_CLAUDE_BIN" >&2
  exit 1
fi
export FF_CLAUDE_BIN
export PATH="$(dirname "${FF_CLAUDE_BIN}"):${PATH}"

# Opened for APPEND: `9>` would truncate the file at open, emptying the pid
# the fallback below reads, so on macOS the check never fired.
exec 9>>"${LOCK}"
if ! flock -n 9 2>/dev/null; then
  if [ -s "${LOCK}" ] && kill -0 "$(cat "${LOCK}" 2>/dev/null)" 2>/dev/null; then
    echo "$(stamp) SKIP previous run still going (pid $(cat "${LOCK}"))"
    exit 0
  fi
fi
echo $$ > "${LOCK}"

cd "${FF_DIR}" || exit 1

OUT=$(python3 -m ff.cli claims --limit "${LIMIT}" 2>&1)
STATUS=$?

if [ "${STATUS}" -ne 0 ]; then
  echo "$(stamp) FAIL ${OUT}" >&2
  exit "${STATUS}"
fi
echo "$(stamp) ok $(echo "${OUT}" | tail -1)"
