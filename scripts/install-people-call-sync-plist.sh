#!/usr/bin/env bash
#
# Sets up the venv (outside ~/Documents), renders launchd/com.nanoclaw.people-call-sync.plist
# with real paths, installs it to ~/Library/LaunchAgents, loads it, and triggers a test run.
#
# Shaped like install-spotify-cleanup-plist.sh, for the same reason: a job loaded mid-session
# is denied ~/Documents at spawn (TCC, exit 78), so the plist runs an inline /bin/bash -c with
# the venv python from ~/.local and logs to ~/.local/share/nanoclaw/logs. The child process
# still reads the repo (scripts, contacts.db) normally.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="com.nanoclaw.people-call-sync"
TEMPLATE="${REPO_DIR}/launchd/${LABEL}.plist"
INSTALLED="${HOME}/Library/LaunchAgents/${LABEL}.plist"
VENV="${HOME}/.local/share/nanoclaw/people-call-sync-venv"
VENV_PYTHON="${VENV}/bin/python"
LAUNCHD_LOG_DIR="${HOME}/.local/share/nanoclaw/logs"
LOG_FILE="${LAUNCHD_LOG_DIR}/people-call-sync.log"
# Host-only copy of the dsaltzai Drive token (never inside a group's session dir,
# which a container would mount). Copy it from any group that holds one, mode 600.
TOKEN="${HOME}/.config/nanoclaw/people-drive-credentials.json"

[[ -f "${TEMPLATE}" ]] || { echo "ERROR: template not found at ${TEMPLATE}"; exit 1; }
[[ -f "${TOKEN}" ]] || { echo "ERROR: Drive token missing at ${TOKEN} (copy a group's drive-credentials.json there, chmod 600)"; exit 1; }

# Python >= 3.11: drive_common.py needs 3.10, and people_whatsapp.py decrypts the
# WhatsApp backup into an in-memory SQLite (Connection.deserialize, 3.11+).
# The system python3 is 3.9.
PY_BASE=""
for cand in python3.13 python3.12 python3.11 /usr/local/bin/python3.13 /opt/homebrew/bin/python3; do
    if command -v "${cand}" >/dev/null 2>&1 && "${cand}" -c 'import sys; sys.exit(sys.version_info < (3, 11))'; then
        PY_BASE="$(command -v "${cand}")"; break
    fi
done
[[ -n "${PY_BASE}" ]] || { echo "ERROR: need Python >= 3.11 to build the venv"; exit 1; }

echo "==> Ensuring venv at ${VENV} (from ${PY_BASE})"
mkdir -p "$(dirname "${VENV}")" "${LAUNCHD_LOG_DIR}"
chmod 700 "${LAUNCHD_LOG_DIR}"
if [[ ! -x "${VENV_PYTHON}" ]]; then
    "${PY_BASE}" -m venv "${VENV}"
fi
"${VENV_PYTHON}" -m pip install --quiet --upgrade pip
# wa-crypt-tools decrypts the WhatsApp backup; pinned — it handles the key.
"${VENV_PYTHON}" -m pip install --quiet google-auth requests "wa-crypt-tools==0.1.0"

if ! /usr/bin/security find-generic-password -s whatsapp-backup-key >/dev/null 2>&1; then
    echo "!! No Keychain item 'whatsapp-backup-key' — WhatsApp backups will be skipped with an error."
    echo "   Store the 64-digit key (you'll be prompted; it never touches shell history):"
    echo "     security add-generic-password -U -a \"\$USER\" -s whatsapp-backup-key -w"
fi

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

echo "==> Triggering test run via kickstart"
touch "${LOG_FILE}"
chmod 600 "${LOG_FILE}"
launchctl kickstart -k "gui/$(id -u)/${LABEL}"
sleep 12
echo
echo "==> launchd run exit code (column 2 should be 0):"
launchctl list | grep "${LABEL}"
echo "==> Last lines of ${LOG_FILE}:"
tail -n 20 "${LOG_FILE}" || true
