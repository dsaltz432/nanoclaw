# People — how calls get in

When Daniel last had a real interaction with a small set of close friends and
family. The agent-facing description (what's stored, how the Telegram group
behaves) is [groups/people/CLAUDE.md](../groups/people/CLAUDE.md); this doc is
the operator's view: sources, the nightly job, the archive, and how to re-run
things.

```
phone, 3:30 AM ET ─┬─ SMS Backup & Restore ─→ Drive Agents/Call-Backups/calls-*.xml
                   └─ WhatsApp backup ──────→ Drive Agents/Whatsapp-Backups/msgstore.db.crypt15
                                                   │
Mac, 4:15 AM (+7:00 AM catch-up)                   ▼
  launchd com.nanoclaw.people-call-sync → scripts/people-call-sync.py
      ├─ saves each new backup privately   ~/.config/nanoclaw/people-exports/
      ├─ loads new calls for tracked people → data/sessions/people/.claude/contacts.db
      └─ logs each new call               ~/.local/share/nanoclaw/logs/people-call-sync.log

by hand ─ People page (/people) or "saw Mom" in the People Telegram group → contacts.db
```

| Source | Arrives | Matched by | Stored as |
|---|---|---|---|
| Android call log | nightly backup | phone number | `phone`, with length and direction |
| WhatsApp calls | nightly encrypted backup | phone number | `whatsapp`, with length and direction |
| In person, notes, anything else | typed on the People page or in Telegram | name | `in_person` / `manual` / … |

**Metadata only.** Who, when, which channel, how long. No message content from
anywhere, and nobody who isn't tracked: calls with other numbers are counted
and dropped. WhatsApp *messages* are out of scope; the WhatsApp backup is
decrypted only to read its call table (below).

## The nightly job

`scripts/people-call-sync.py`, run by launchd at **4:15 AM** and **7:00 AM**
(the second run covers a night the Mac slept through). Each run:

1. Lists `Call-Backups` and `Whatsapp-Backups` with a host-only copy of the
   dsaltzai Drive token (`~/.config/nanoclaw/people-drive-credentials.json`).
2. For each backup not seen before (tracked by Drive id + content checksum in
   `people-exports/sync-state.json`; the phone may overwrite the same file),
   downloads it into the private archive.
3. Loads **answered** calls with **tracked numbers** from **2025-01-01** on.
   Re-loading is a no-op. WhatsApp calls already imported from a call-history
   CSV are recognised (same person, same length, within the call's span) and not
   duplicated.
4. Logs every call that's new since the last ingest, one line each:
   ```
   phone · calls-20260923225225.xml: 2224 calls in the log · 1 new · 1022 with untracked numbers (not stored)
     new: phone    2026-09-23 18:50:05  → out    0m05s  Mom
   ```
   `WARN` lines mean a source's newest backup is over 48 h old, i.e. the
   phone's schedule stopped. `ERROR` lines (and a non-zero exit) mean a source
   couldn't be read or decrypted; the other source still runs.
5. Prunes the archive: newest **14** call logs, newest **3** WhatsApp backups
   (each is a full history).

The log is also on the dashboard: **Admin ▸ Host Tasks ▸ People: call-log sync**.

| Do | Command |
|---|---|
| Run now | `launchctl kickstart -k gui/$(id -u)/com.nanoclaw.people-call-sync` |
| Preview, write nothing | `~/.local/share/nanoclaw/people-call-sync-venv/bin/python scripts/people-call-sync.py --dry-run` |
| (Re)install | `./scripts/install-people-call-sync-plist.sh` — builds the venv (Python ≥ 3.11, google-auth, `wa-crypt-tools==0.1.0`), installs, test-runs |
| Stop | `launchctl unload ~/Library/LaunchAgents/com.nanoclaw.people-call-sync.plist` |

### Why it runs on the host, not as an agent task

These backups name everyone Daniel talks to. They never enter a container:
the job is launchd, the archive and log are outside the repo (the main group
mounts the whole repo read-only), and the People agent has **no Drive token at
all**. Untracked numbers are only ever counted, never listed.

### WhatsApp: calls only, decrypted in memory

`msgstore.db.crypt15` is WhatsApp's entire database, messages included. The job
(`scripts/people_whatsapp.py`):

- reads the 64-digit backup key from the **macOS Keychain**, item
  `whatsapp-backup-key`, via `/usr/bin/security` (it never appears in a file,
  log, argument list or error message);
- decrypts and decompresses **in memory** and opens the result as an in-memory
  SQLite database, so plaintext never touches the disk;
- reads only `call_log` (plus `jid` / `jid_map` to turn WhatsApp's private
  contact ids into phone numbers) and skips group calls;
- keeps the **encrypted** file, so messages for chosen people *could* be
  extracted later, as a deliberate decision. Nothing does that today.

Store or replace the key (you'll be prompted; it stays out of shell history):
`security add-generic-password -U -a "$USER" -s whatsapp-backup-key -w`.
It must be the 64-digit key: a password-protected backup can't be decrypted
offline. The job relies on the login keychain being unlocked overnight, which is
the default while logged in.

### Exposure to know about

Both folders sit in `Agents/`, readable by every group holding the dsaltzai
token (fitness, medical, …). The call log there is plain XML; the WhatsApp
backup is useless without the key. The job can't delete them: the phone uploads
as Daniel's main account and only the owner can trash a Drive file. Retention is
set on the phone instead: **last 10 backups** each.

## The private archive

`~/.config/nanoclaw/people-exports/` (folder 700, files 600), host-only:

| Path | Holds |
|---|---|
| `calls/` | call-log backups (newest 14; plus any saved with `--save`) |
| `whatsapp-backups/` | encrypted WhatsApp backups (newest 3) |
| `whatsapp-calls/` | WhatsApp call-history CSVs, `p<person id>__<name>.csv` (one-off imports, Sep 2026) |
| `sync-state.json` | which backups have been ingested |

It is **not** in the nightly repo backup. If the Mac is lost, the phone's
backups (last 10 on Drive) rebuild it.

**Adding someone later picks up their history.** Adding a person, or changing
someone's numbers, on the People page replays the archive (`people-backfill.py
rescan`), so their past calls since 2025 appear right away. The page says
how many it found. Renaming or changing rules doesn't trigger it; rules apply
at read time.

## One-off imports

`scripts/people-backfill.py`, run by hand, for anything outside the nightly
flow. Everything is idempotent and skips entries before `--since` (default
2025-01-01).

```bash
python3 scripts/people-backfill.py calls ~/Downloads/calls-*.xml --dry-run        # a call-log backup
python3 scripts/people-backfill.py whatsapp-calls --person Dad dad-calls.csv       # a WhatsApp call-history CSV
python3 scripts/people-backfill.py rescan                                          # replay the whole archive
```

Add `--save` to keep a private copy in the archive for future rescans.
WhatsApp *chat* exports ("Export chat") aren't supported: they carry no call
history, and messages are out of scope.

## Troubleshooting

| Symptom | Look at |
|---|---|
| No new calls for days | the log's `WARN` lines: has the phone's schedule stopped? |
| `ERROR WhatsApp …: Keychain item … not readable` | keychain locked, or item missing: re-run the `security add-generic-password` command |
| `ERROR WhatsApp …: decryption failed` | wrong key, or WhatsApp was switched to a password-protected backup |
| A call is missing for someone | is their number on their record? Is it before 2025, unanswered, or a group call? |
| Job exits 78 with empty logs | the `~/Documents` spawn-time rule in [host-cronjobs.md](host-cronjobs.md); the plist already avoids it |
