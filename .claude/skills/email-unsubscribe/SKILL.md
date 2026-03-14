---
name: email-unsubscribe
description: Morning email unsubscribe curator. Scans Gmail each morning, sends a WhatsApp list of promotional/newsletter unsubscribe candidates, then uses the browser to unsubscribe from the ones the user selects.
---

# Email Unsubscribe Curator

This skill adds a daily morning routine that scans Gmail for newsletter and promotional emails, presents a curated list via WhatsApp, and — when the user replies with their selections — uses the browser to unsubscribe from each one.

## Phase 1: Pre-flight

### Check Gmail is configured

Read `.nanoclaw/state.yaml`. If `gmail` is not in `applied_skills`, stop and tell the user:

> Gmail isn't set up yet. Run `/add-gmail` first, then come back to `/email-unsubscribe`.

### Ask what time

Use `AskUserQuestion`:

> What time would you like the morning email scan to run? (e.g. "8:00 AM" — and what timezone are you in?)

Record their answer. You'll use it to build the cron expression in Phase 3.

## Phase 2: Apply Changes to groups/main/CLAUDE.md

Append the following section to `groups/main/CLAUDE.md`. Do not modify anything else in the file.

````markdown
---

## Email Unsubscribe Curator

### Morning Scan

When your prompt starts with `UNSUBSCRIBE_SCAN:`, perform the morning email unsubscribe scan:

1. Search Gmail for bulk/promotional/newsletter emails from the past 7 days:
   - `mcp__gmail__search_emails` with query: `list:* newer_than:7d`
   - Also try: `category:promotions newer_than:7d is:unread`
   - Merge and deduplicate results by sender

2. For each email, decide if it's a good unsubscribe candidate:
   - ✅ YES: newsletters, marketing blasts, promotional deals, digest emails, product updates from companies
   - ❌ NO: transactional emails (receipts, shipping notifications, bank alerts, 2FA codes), emails from real people, anything that looks important

3. Pick up to 10 of the best candidates (most repetitive senders first).

4. Save the candidate list to `/workspace/group/unsubscribe-pending.json`:
   ```json
   {
     "date": "YYYY-MM-DD",
     "candidates": [
       {
         "index": 1,
         "senderName": "Example Newsletter",
         "senderEmail": "news@example.com",
         "subject": "This week's top stories",
         "messageId": "gmail-message-id"
       }
     ]
   }
   ```

5. Send a WhatsApp message:
   ```
   🧹 *Morning Email Cleanup*

   Found X unsubscribe candidates:

   1. *Example Newsletter* (news@example.com)
      "This week's top stories"
   2. *Sale Alerts* (deals@shop.com)
      "50% off everything — today only!"
   ...

   Reply `unsub 1 3` (or just `1 3` if this is the only pending action), *unsub all*, or *unsub skip*.
   ```

If no candidates are found, send: `✅ Inbox clean — no unsubscribe candidates today.` and do not write the pending file.

---

### Handling Unsubscribe Replies

On every incoming message, check if `/workspace/group/unsubscribe-pending.json` exists and its `date` matches today.

If it does **and** the message matches the unsubscribe reply pattern:
- Starts with `unsub` (e.g. `unsub 1 3`, `unsub all`, `unsub skip`)
- OR contains only numbers/commas/spaces and no other pending state files exist today (fallback for when unsubscribe is the only pending action)

**On `unsub skip` / `unsub none` / `unsub cancel`:**
- Delete `/workspace/group/unsubscribe-pending.json`
- Reply: `Ok, skipping for today. 👍`

**On numbers or "all":**
1. Read the pending file and resolve the selected candidates
2. Delete `/workspace/group/unsubscribe-pending.json` immediately (before starting work, to avoid double-processing if something fails mid-way)
3. Send an acknowledgement: `Got it — unsubscribing from X sender(s)...`
4. For each selected candidate:
   a. Read the full email: `mcp__gmail__read_email` with the stored `messageId`
   b. Extract the unsubscribe URL:
      - First check the `List-Unsubscribe` header for an `https://` URL
      - If not found, scan the email body for a link containing "unsubscribe" (case-insensitive)
   c. If a URL is found, use `agent-browser` to unsubscribe:
      ```bash
      agent-browser open <unsubscribe-url>
      agent-browser snapshot -i
      # Look for a confirm/unsubscribe button and click it
      agent-browser wait --load networkidle
      agent-browser close
      ```
   d. If only a mailto unsubscribe link is found (e.g. `List-Unsubscribe: <mailto:unsub@example.com>`), note it as "requires manual action"
   e. If no unsubscribe link is found at all, note it as "no unsubscribe link found"
5. Send a summary:
   ```
   ✅ *Unsubscribe complete*

   • Example Newsletter — unsubscribed ✓
   • Sale Alerts — unsubscribed ✓
   • Some Sender — no unsubscribe link found ⚠️
   ```

If the pending file does not exist or the message doesn't look like a selection, process it as a normal message.
````

## Phase 3: Schedule the Task

### Convert the user's time to a cron expression

Examples:
- "8:00 AM Eastern" → cron `0 8 * * *` with TZ=America/New_York (or `0 13 * * *` in UTC if server is UTC)
- "7:30 AM" → `30 7 * * *`

Check the server's timezone:

```bash
gcloud compute ssh nanoclaw --zone=us-central1-a --command="cat /etc/timezone || timedatectl show | grep Timezone"
```

The GCP instance runs UTC. Convert the user's requested local time to UTC for the cron expression.

### Create the scheduled task

Write the task directly into the SQLite database on the GCP instance. First get the main group's chat JID:

```bash
gcloud compute ssh nanoclaw --zone=us-central1-a --command="sqlite3 ~/nanoclaw/store/messages.db \"SELECT jid, name FROM registered_groups WHERE is_main = 1 OR folder LIKE '%main%' LIMIT 5;\""
```

Then insert the task (replace `<CHAT_JID>`, `<CRON_EXPRESSION>`, and `<NEXT_RUN_ISO>` with actual values):

```bash
gcloud compute ssh nanoclaw --zone=us-central1-a --command="sqlite3 ~/nanoclaw/store/messages.db \"
INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, next_run, status, context_mode, created_at)
VALUES (
  lower(hex(randomblob(8))),
  'main',
  '<CHAT_JID>',
  'UNSUBSCRIBE_SCAN: Check Gmail for newsletter and promotional emails. Identify unsubscribe candidates and send the morning email cleanup list.',
  'cron',
  '<CRON_EXPRESSION>',
  '<NEXT_RUN_ISO>',
  'active',
  'fresh',
  datetime('now')
);
\""
```

Verify it was created:

```bash
gcloud compute ssh nanoclaw --zone=us-central1-a --command="sqlite3 ~/nanoclaw/store/messages.db \"SELECT id, prompt, schedule_value, next_run, status FROM scheduled_tasks ORDER BY created_at DESC LIMIT 3;\""
```

### Check the registered_groups table schema if needed

If the INSERT fails because of schema uncertainty, first check the actual column names:

```bash
gcloud compute ssh nanoclaw --zone=us-central1-a --command="sqlite3 ~/nanoclaw/store/messages.db \".schema scheduled_tasks\""
```

And check the registered_groups schema for the main group's folder name:

```bash
gcloud compute ssh nanoclaw --zone=us-central1-a --command="sqlite3 ~/nanoclaw/store/messages.db \".schema registered_groups\" && sqlite3 ~/nanoclaw/store/messages.db \"SELECT * FROM registered_groups LIMIT 5;\""
```

## Phase 4: Verify

Tell the user:

> All set! Here's what will happen:
>
> • Every morning at [their requested time], Andy will scan your Gmail for unsubscribe candidates and send you a list via WhatsApp
> • Reply with numbers (e.g. _1 3_), *all*, or *skip*
> • Andy will use the browser to unsubscribe from each one you select
>
> To test it right now, send this in your main WhatsApp channel:
>
> `UNSUBSCRIBE_SCAN: Check Gmail for newsletter and promotional emails. Identify unsubscribe candidates and send the morning email cleanup list.`
>
> (This is the exact prompt the scheduled task will send — it'll do a real scan of your inbox.)

## Troubleshooting

### Task not running

Check the scheduler picked it up:

```bash
gcloud compute ssh nanoclaw --zone=us-central1-a --command="sqlite3 ~/nanoclaw/store/messages.db \"SELECT id, next_run, status FROM scheduled_tasks ORDER BY created_at DESC LIMIT 5;\""
```

### Gmail search returning no results

The `list:*` query only matches emails with a `List-*` header (bulk senders). If the inbox is empty, try a broader test query: `category:promotions`.

### Browser unsubscribe failing

Some unsubscribe pages require JavaScript-heavy flows. If `agent-browser snapshot -i` shows no button after loading:
- Try scrolling: `agent-browser scroll down 500`
- Check for iframes: `agent-browser snapshot` (without `-i`)
- Take a screenshot to see what the page looks like: `agent-browser screenshot`

### Removal

To remove this feature:
1. Delete the "Email Unsubscribe Curator" section from `groups/main/CLAUDE.md`
2. Cancel the scheduled task by running on the GCP instance:
   ```bash
   sqlite3 ~/nanoclaw/store/messages.db "UPDATE scheduled_tasks SET status = 'cancelled' WHERE prompt LIKE 'UNSUBSCRIBE_SCAN:%';"
   ```
