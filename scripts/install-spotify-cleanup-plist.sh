#!/usr/bin/env bash
#
# Sets up the venv (outside ~/Documents), renders launchd/com.nanoclaw.spotify-cleanup.plist
# with real paths, installs it to ~/Library/LaunchAgents, loads it, and (if a token cache
# exists) triggers a test run.
#
# Why the plist is shaped the way it is: launchd's spawn-time file access is denied for a job
# loaded mid-session whose program or Standard{Out,Error}Path live under ~/Documents (TCC,
# exit 78). So the plist launches via inline `/bin/bash -c` (no repo script), runs the venv
# python from ~/.local, and writes launchd stdout/stderr to ~/.local/share/nanoclaw/logs. The
# child process still reads/writes the repo (cleanup.py, .env, .cache, audit log) fine.
#
# Run the interactive first-run auth BEFORE this script so the headless job has a token:
#   "${VENV}/bin/python" scripts/spotify-cleanup/cleanup.py --auth      (VENV path printed below)

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="com.nanoclaw.spotify-cleanup"
TEMPLATE="${REPO_DIR}/launchd/${LABEL}.plist"
INSTALLED="${HOME}/Library/LaunchAgents/${LABEL}.plist"
JOB_DIR="${REPO_DIR}/scripts/spotify-cleanup"
VENV="${HOME}/.local/share/nanoclaw/spotify-cleanup-venv"
VENV_PYTHON="${VENV}/bin/python"
LAUNCHD_LOG_DIR="${HOME}/.local/share/nanoclaw/logs"
LOG_FILE="${LAUNCHD_LOG_DIR}/spotify-cleanup.log"

[[ -f "${TEMPLATE}" ]] || { echo "ERROR: template not found at ${TEMPLATE}"; exit 1; }

echo "==> Ensuring venv at ${VENV}"
mkdir -p "$(dirname "${VENV}")" "${LAUNCHD_LOG_DIR}"
if [[ ! -x "${VENV_PYTHON}" ]]; then
    python3 -m venv "${VENV}"
fi
"${VENV_PYTHON}" -m pip install --quiet --upgrade pip
"${VENV_PYTHON}" -m pip install --quiet -r "${JOB_DIR}/requirements.txt"

echo "==> Rendering plist → ${INSTALLED}"
mkdir -p "${HOME}/Library/LaunchAgents"
sed -e "s|{{PROJECT_ROOT}}|${REPO_DIR}|g" \
    -e "s|{{HOME}}|${HOME}|g" \
    "${TEMPLATE}" > "${INSTALLED}"

echo "==> Validating plist syntax"
plutil -lint "${INSTALLED}"

echo "==> Unloading any previous version (ok if not loaded)"
launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true

echo "==> Loading plist"
launchctl load "${INSTALLED}"

echo "==> Confirming launchd sees the job"
launchctl list | grep "${LABEL}" || { echo "ERROR: job not registered"; exit 1; }

if [[ ! -f "${JOB_DIR}/.cache" ]]; then
    echo
    echo "!! No OAuth token cache at ${JOB_DIR}/.cache"
    echo "   Run the interactive first-run auth, then the scheduled job will work headless:"
    echo "     \"${VENV_PYTHON}\" ${JOB_DIR}/cleanup.py --auth"
    echo "   Skipping the test run (it would fail loudly with no cache)."
    exit 0
fi

echo "==> Triggering test run via kickstart"
: > "${LOG_FILE}"
launchctl kickstart -k "gui/$(id -u)/${LABEL}"
sleep 9
echo
echo "==> launchd run exit code (column 2 should be 0):"
launchctl list | grep "${LABEL}"
echo "==> Last lines of ${LOG_FILE}:"
tail -n 20 "${LOG_FILE}" || true
echo
echo "Detailed per-run audit log: ${REPO_DIR}/logs/spotify-cleanup-audit-YYYYMMDD.log"
