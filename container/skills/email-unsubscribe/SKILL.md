---
name: email-unsubscribe
description: Morning email cleanup — analyze pre-scanned Gmail metadata, present unsubscribe candidates, visit unsubscribe pages via browser, and save results to history. Run via scheduled task or /email-unsubscribe.
---

# Email Unsubscribe Curator

## Security

*Never use Gmail tools for this workflow.* Email metadata is pre-extracted by a host-side script. Read ONLY from the metadata JSON — never call `mcp__gmail__*`.

## Paths

| File | Container path | Direction |
|------|---------------|-----------|
| Metadata | `/workspace/extra/email-unsubscribe/sanitized_metadata.json` | read |
| Domain allowlist | `/workspace/extra/email-unsubscribe/known_unsubscribe_domains.json` | read |
| History | `/workspace/group/unsubscribe-history.json` | read/write |
| Seen-list (skip-list) | `/workspace/group/unsubscribe-seen.json` | read/write |

## Morning Analysis

1. Read `/workspace/extra/email-unsubscribe/sanitized_metadata.json`. If it doesn't exist or `scanDate` is not today, handle per the "Stale or missing metadata: scheduled vs interactive" section in the email group's CLAUDE.md — interactive triggers reply `Metadata not ready — the scan may still be running. Try again in a minute.` and stop; scheduled triggers emit a loud skip message with launchd diagnostic info and stop.

2. The host extractor already filters out senders in `unsubscribe-history.json` (successful) and in `unsubscribe-seen.json` (skip-list). You can read both for context, but you don't need to re-filter — anything in `candidates` is a sender you have not already unsubscribed from or dismissed.

3. Evaluate each candidate:

   *Include (likely unwanted):*
   - High frequency (3+ emails in 7 days) from promotional senders
   - `CATEGORY_PROMOTIONS` label — surface these even when `hasUnsubscribeHeader` is `false`. Many small/local senders (gyms, community lists, vendor announcements) don't include `List-Unsubscribe` headers, but the user still wants the option to deal with them. Note in the message that the unsubscribe is browser-only or manual (e.g. "in-body link, browser unsubscribe only").
   - Subject lines suggesting marketing blasts, sales, re-engagement, digests, surveys
   - `hasUnsubscribeHeader: true`

   *Exclude (never suggest):*
   - Labels `newsletters-daily-pulse` or `newsletters-deep-dives`
   - Transactional content: receipts, shipping, 2FA codes, password resets, bank alerts (typically `CATEGORY_UPDATES` without `CATEGORY_PROMOTIONS`)
   - Personal correspondence or calendar events
   - When in doubt, leave it out.

4. If the metadata contains a `stillEmailing` array, mention any senders who are still emailing after a previous unsubscribe attempt (3+ days since unsubscribe). The user may want to try again or block them.

5. Send a categorized list (high-priority, consider, skip). Let the user reply in any format — numbers, sender names, "all", "skip", or natural language.

## Processing Unsubscribes

When the user replies with which senders to unsubscribe from:

1. Match their selections to the metadata candidates.
2. For each selected sender, use the `unsubscribeUrl` from the metadata:
   - *One-click (RFC 8058):* If `hasOneClickUnsubscribe` is true, try a POST with `List-Unsubscribe=One-Click` first.
   - *Browser flow:* Use `agent-browser` to open the URL, find and click the unsubscribe/confirm button, fill email if needed. Hard limits: 30 seconds per URL, 5 browser actions per URL.
3. **CRITICAL — Save results to history.** After processing ALL URLs, you MUST update `/workspace/group/unsubscribe-history.json`:
   ```json
   {
     "history": [
       {
         "unsubscribedAt": "2026-03-31T02:48:00.000Z",
         "senderName": "Example Store",
         "senderEmail": "deals@example.com",
         "result": "success",
         "url": "https://example.com/unsubscribe/abc123",
         "method": "one-click",
         "lastSeen": null
       }
     ]
   }
   ```
   Use `unsubscribedAt` with a full ISO timestamp. Set `lastSeen` to `null` — the host script updates this when it detects the sender is still emailing. Append new entries; preserve existing history. **This prevents the same senders from appearing in future scans.**
4. Send a summary table with results per sender.

## Skip-list (`unsubscribe-seen.json`)

When the user replies "skip", "dismiss", "ignore X", or otherwise declines specific candidates without asking you to unsubscribe, append those `senderEmail` values to `/workspace/group/unsubscribe-seen.json`:

```json
{
  "seenSenderEmails": [
    "deals@example.com",
    "newsletter@othersite.com"
  ]
}
```

The host extractor reads this file and filters those senders out of future scans. Use lowercase emails. Don't add a sender to the seen-list if the user agreed to unsubscribe — that goes in `unsubscribe-history.json` instead. Only add senders the user explicitly dismissed (so they aren't re-shown tomorrow).

If the user later says something like "actually let's revisit X" or "show me everything", you can remove that email from the seen-list.

## Unsub History

When the user asks about unsubscribe history, read `/workspace/group/unsubscribe-history.json` and send a formatted summary. Entries with `lastSeen` set (not null) indicate when the sender was last observed emailing after unsubscribe — a stale (older) `lastSeen` means they've stopped, a recent one means they're still active.
