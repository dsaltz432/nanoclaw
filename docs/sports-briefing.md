# Sports Briefing

Daily scout (9:15 PM ET) checks for upcoming sporting events and offers to generate a
shareable HTML briefing. Agent saves HTML to `data/briefings/`, a launchd `WatchPaths` job
uploads it to `gs://sports-briefings/`, and the agent sends the public URL.

The upload watcher is a host launchd `WatchPaths` job — see [host-cronjobs.md](host-cronjobs.md)
for the file-watcher pattern.

| Component | Location |
|-----------|----------|
| Container skill | `container/skills/sports-briefing/SKILL.md` |
| Upload script | `scripts/upload-briefing.sh` |
| Upload watcher plist | `launchd/com.nanoclaw.briefing-upload.plist` |
| GCS bucket (public) | `gs://sports-briefings/` |

**Scheduled task in SQLite:** `Sports Briefing Scout` — cron `15 21 * * *`, `context_mode: group`,
`group_folder: sports-briefings`.
