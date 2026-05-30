# Email Unsubscribe Curator

Daily email cleanup: a host-side script scans Gmail metadata (no bodies, no LLM), then the
agent analyzes candidates and handles browser-based unsubscribes.

The metadata extractor is a host launchd job — see [host-cronjobs.md](host-cronjobs.md) for
the plist pattern.

| Component | Location |
|-----------|----------|
| Metadata extractor script | `scripts/email-metadata-extractor.ts` |
| Gmail auth script | `scripts/gmail-auth.ts` |
| Launchd plist template | `launchd/com.nanoclaw.email-metadata.plist` |
| LaunchAgent (installed) | `~/Library/LaunchAgents/com.nanoclaw.email-metadata.plist` |
| Agent instructions | `groups/main/CLAUDE.md` (Email Unsubscribe Curator section) |
| Setup skill | `.claude/skills/email-unsubscribe/SKILL.md` |
| Scan output | `data/email-unsubscribe/` |
| Unsubscribe history | `groups/email/unsubscribe-history.json` |
| Gmail credentials | `~/.gmail-mcp/` (not in repo) |
| Logs | `logs/email-metadata.log`, `logs/email-metadata.error.log` |

**Scheduled task in SQLite:** `Email Unsubscribe Analyzer` — cron `25 6 * * *` (6:25 AM ET),
`context_mode: isolated`, `group_folder: email`. Must be recreated on new machine via
`/email-unsubscribe`.

```bash
# Service management (macOS)
launchctl load ~/Library/LaunchAgents/com.nanoclaw.email-metadata.plist    # start
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.email-metadata.plist  # stop

# Manual test
npx tsx scripts/email-metadata-extractor.ts

# Full setup on new machine
# 1. Run /email-unsubscribe (installs plist + creates scheduled task)
# 2. If Gmail token expired: npx tsx scripts/gmail-auth.ts
```
