---
name: email-unsubscribe
description: "Set up the daily email unsubscribe curator. A host-side script scans Gmail metadata (no bodies), the agent analyzes candidates and messages the user, then uses the browser to unsubscribe from selected senders."
user_invocable: true
---

# Email Unsubscribe Curator Setup

Two-component architecture:
1. **Host script** (launchd cron) — queries Gmail API for metadata only, no LLM
2. **Main group agent** (NanoClaw scheduled task) — reads metadata, messages user, handles browser unsubscribes

**Security:** The script that reads email has no AI. The AI that processes the list never has Gmail credentials (`noGmailMount: true`).

---

## Phase 1: Pre-flight

### 1.1 Check Gmail is configured

Check if Gmail credentials exist:

```bash
ls ~/.gmail-mcp/credentials.json ~/.gmail-mcp/token.json
```

If either is missing, tell the user:

> Gmail isn't set up yet. Run `/add-gmail` first, then come back to `/email-unsubscribe`.

Stop here if Gmail is not configured.

### 1.2 Check script exists

Verify the extractor script is present:

```bash
ls scripts/email-metadata-extractor.ts
```

If missing, tell the user to pull the latest NanoClaw code.

### 1.3 Ask for schedule time

Ask the user:

> What time would you like the morning email scan to run? (e.g. "8:00 AM") And what timezone are you in?

---

## Phase 2: Verify CLAUDE.md instructions

Check that `groups/main/CLAUDE.md` contains the "Email Unsubscribe Curator" section:

```bash
grep -c "Email Unsubscribe Curator" groups/main/CLAUDE.md
```

If the section is missing, tell the user the CLAUDE.md instructions need to be added and offer to do it. The instructions are documented in the design spec.

---

## Phase 3: Set up the launchd plist

### 3.1 Convert time to launchd format

The plist uses `StartCalendarInterval` with `Hour` and `Minute` keys.

### 3.2 Substitute template variables in the plist

Read `launchd/com.nanoclaw.email-metadata.plist` and replace:
- `{{NODE_PATH}}` — run `which node` to get the path
- `{{PROJECT_ROOT}}` — use the absolute path to the NanoClaw directory
- `{{HOME}}` — use `$HOME`

Write the substituted plist to `~/Library/LaunchAgents/com.nanoclaw.email-metadata.plist`.

### 3.3 Load the launchd service

```bash
launchctl load ~/Library/LaunchAgents/com.nanoclaw.email-metadata.plist
```

Verify it's loaded:

```bash
launchctl list | grep email-metadata
```

---

## Phase 4: Schedule the agent task

### 4.1 Get the main group's chat JID

```bash
sqlite3 store/messages.db "SELECT jid FROM registered_groups WHERE is_main = 1 LIMIT 1;"
```

### 4.2 Convert user's time to cron expression

Add 2 minutes to the scan time so metadata is ready when the agent runs.

Examples:
- User says "8:00 AM" → script runs at 8:00, agent cron = `2 8 * * *`
- User says "7:30 AM" → script runs at 7:30, agent cron = `32 7 * * *`

Check system timezone: `date +%Z`

### 4.3 Create the scheduled task

```bash
sqlite3 store/messages.db "
INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, next_run, status, context_mode, name, created_at)
VALUES (
  lower(hex(randomblob(8))),
  'telegram_main',
  '<MAIN_JID>',
  'UNSUBSCRIBE_ANALYZE: Read /workspace/project/data/email-unsubscribe/sanitized_metadata.json. Evaluate the unsubscribe candidates and send the morning cleanup list.',
  'cron',
  '<CRON_EXPRESSION>',
  '<NEXT_RUN_ISO>',
  'active',
  'isolated',
  'Email Unsubscribe Analyzer',
  datetime(''now'')
);
"
```

### 4.4 Initialize history file

```bash
[ -f groups/telegram_main/unsubscribe-history.json ] || echo '{"history":[]}' > groups/telegram_main/unsubscribe-history.json
```

### 4.5 Verify

```bash
sqlite3 store/messages.db "SELECT id, name, schedule_value, context_mode, status FROM scheduled_tasks WHERE name LIKE '%Unsubscribe%' ORDER BY created_at DESC LIMIT 2;"
```

---

## Phase 5: Confirm Setup

Tell the user:

> All set! Here's how it works:
>
> *Every morning at [their time]:*
> 1. A host-side script fetches Gmail metadata only — no email bodies, no LLM
> 2. Two minutes later, the agent reads the metadata and sends you a list
> 3. Reply `unsub 1 2` (or `unsub all` / `unsub skip`)
> 4. The agent visits each unsubscribe page via browser
> 5. You get a summary of what worked and what didn't
>
> *Security:* The script that reads your email has no AI. The AI that sees your inbox metadata never has Gmail credentials.
>
> To test immediately:
> ```
> npx tsx scripts/email-metadata-extractor.ts
> ```
> Then send `UNSUBSCRIBE_ANALYZE:` in your main channel.

---

## Troubleshooting

### No candidates found
```bash
npx tsx scripts/email-metadata-extractor.ts
cat data/email-unsubscribe/sanitized_metadata.json | node -e "const d=require('fs').readFileSync(0,'utf8');console.log(JSON.parse(d).candidates.length,'candidates')"
```

### Gmail credentials error
Re-authenticate via `/add-gmail`. The script reads from `~/.gmail-mcp/credentials.json` and `~/.gmail-mcp/token.json`.

### Launchd not running
```bash
launchctl list | grep email-metadata
cat logs/email-metadata.log
cat logs/email-metadata.error.log
```

### Removal

```bash
# Stop launchd service
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.email-metadata.plist
rm ~/Library/LaunchAgents/com.nanoclaw.email-metadata.plist

# Cancel scheduled task
sqlite3 store/messages.db "UPDATE scheduled_tasks SET status = 'cancelled' WHERE name LIKE '%Unsubscribe%';"

# Remove data (optional)
rm -rf data/email-unsubscribe/
rm -f groups/main/unsubscribe-*.json
```

Then delete the "Email Unsubscribe Curator" section from `groups/main/CLAUDE.md`.
