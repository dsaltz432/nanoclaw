# Multi-Group Architecture

How this install splits scheduled tasks across domain-specific groups
instead of running everything out of `telegram_main`.

**Audience:** future-me, debugging at 2am or re-orienting after a long gap.
**Scope:** install-specific. For framework-level group mechanics see
[`docs/SPEC.md`](../SPEC.md) and [`docs/REQUIREMENTS.md`](../REQUIREMENTS.md).

## Background

Originally everything lived in `telegram_main` — beacon intel, mortgage
tracking, Garmin/Strava syncs, email unsubscribe curator, the morning
briefing, and ad-hoc admin chat. One group means one serialized message
queue, which means a slow task blocks all other tasks behind it (head-of-
line blocking). The 2026-04-08 migration split these into six groups so
they run in parallel and the main channel stays reserved for admin/chat.

Migration landed in commit `c0d619f` on `origin/main`.

## The three-question rubric

When deciding whether a new task belongs in an existing group or warrants
its own, answer these in order:

1. **Do these tasks share state?** Two tasks writing the same SQLite file
   from separate containers will produce `database is locked` errors. If
   tasks share a DB or files, they *must* be in the same group. Shared
   state is the strongest grouping force and overrides everything else.
2. **Do these tasks share a domain?** Tasks that operate on the same
   subject matter belong together even if they don't directly share state.
   This keeps each group's CLAUDE.md focused, keeps mounts scoped (only
   fitness needs Strava creds, only beacon needs beacon.db), and tightens
   the security blast radius.
3. **Is `telegram_main` reserved for what it's actually for?** The main
   channel is the admin surface — `@Andy list scheduled tasks`, ad-hoc
   questions, etc. It shouldn't be a dumping ground for cron jobs. One
   exception: a single light task that's genuinely part of the main-chat
   experience (the morning briefing) is fine because it won't cause
   head-of-line blocking when it's the only scheduled task on that queue.

Corollary: **head-of-line blocking within a group is acceptable when the
tasks are temporally separated.** Four beacon tasks share one queue
because they share a DB, and that's fine because their cron schedules
don't overlap. Be deliberate when adding new tasks to an existing group —
check the schedule first.

## Current groups

| Group | Folder | JID | Trigger | Timeout | Purpose |
|---|---|---|---|---|---|
| Telegram Main | `telegram_main` | `tg:8684529481` | `@Andy` (required) | 30 min | Admin/chat surface + morning briefing |
| Beacon | `beacon` | `tg:-5234151269` | any (no prefix) | 30 min | Hudson Valley local intel |
| Finance | `finance` | `tg:-5180721066` | any (no prefix) | 30 min | Mortgage rate tracking |
| Fitness | `fitness` | `tg:-5113982013` | any (no prefix) | 30 min | Garmin + Strava health syncs |
| Email | `email` | `tg:-5289234401` | any (no prefix) | 30 min | Gmail unsubscribe curator |
| Recipe Club | `recipe-club` | `tg:-5280655097` | `@recipe` (required) | **2 hours** | Autonomous dev work on the Recipe Club repo |
| NanoClaw Dev | `nanoclaw-dev` | `tg:-5187361917` | `@nanoclaw` (required) | 30 min | Ad-hoc dev work on this repo |

**Why `telegram_main` keeps `requires_trigger=1` while the four new domain
groups don't:** the main chat is where I type normal admin messages and
ad-hoc questions. Without a trigger, every casual note would spawn a
container. The domain chats are single-purpose and I only ever message
them when I want the agent to act, so the trigger is friction with no
benefit. Recipe Club and nanoclaw-dev keep their triggers because they're
shared-ish spaces where not every message should invoke the agent.

### Scheduled tasks per group

| Group | Task | Cron | Status | Task ID |
|---|---|---|---|---|
| beacon | Daily gatherer | `0 16 * * *` | active | `task-1774660436430-uci0h5` |
| beacon | Venue enricher | `0 9 * * 1` | active | `task-1774660961290-hv7i8b` |
| beacon | Weekday report | `0 18 * * 0` | active | `task-1774660468420-bu8mhu` |
| beacon | Weekend report | `0 18 * * 4` | active | `task-1774660458131-jewpib` |
| email | Unsubscribe analyzer | `25 6 * * *` | active | `97ecc024b1753dae` |
| finance | Daily rate tracker | `47 5 * * *` | **paused** | `task-1774321313812-tu4hfc` |
| finance | Weekly rate report | `40 7 * * 3` | active | `task-1774321323925-cof6xm` |
| fitness | Strava daily sync | `0 1 * * *` | active | `task-1775342568705-spdd55` |
| fitness | Garmin daily sync | `30 1 * * *` | active | `task-garmin-daily-sync` |
| recipe-club | Nightly builder | `0 2 * * *` | active | `task-1774406569571-52712j` |
| telegram_main | Morning briefing | `15 6 * * *` | active | `task-1774495205281-pm7xml` |

**Task IDs are load-bearing** — see the Dashboard section below.

## State lives in per-group `.claude/`

NanoClaw auto-mounts `data/sessions/<group>/.claude/` at
`/home/node/.claude` inside every container, read-write and isolated per
group. This is the preferred place for per-group state. **Most groups
don't need any `additionalMounts` at all** — their DBs and credentials
just live in `.claude/`.

Current state layout:

```
data/sessions/
├── beacon/.claude/
│   └── beacon.db                     # items, venues tables
├── email/.claude/                    # (empty — state comes from additional mount + group folder)
├── finance/.claude/
│   └── mortgage-rates.db             # canonical rate history (see below)
├── fitness/.claude/
│   ├── garmin.db                     # empty default profile
│   ├── garmin-daniel-saltz.db        # Daniel's profile
│   ├── garmin-sarah-saltz.db         # Sarah's profile
│   ├── garmin-credentials.json
│   ├── garmin-tokens/                # directory — oauth1/oauth2 tokens
│   ├── garmin-tokens-sarah-saltz/    # directory — oauth1/oauth2 tokens
│   ├── strava.db                     # athletes, activities tables
│   └── strava-credentials.json
├── nanoclaw-dev/.claude/             # dev playground
├── recipe-club/.claude/              # recipe club state
└── telegram_main/.claude/            # framework state only (backups/, plans/, skills/, etc.)
```

The email group is the only one with an `additionalMounts` entry. Its
`container_config` in `registered_groups`:

```json
{
  "timeout": 1800000,
  "additionalMounts": [
    {
      "hostPath": "~/Documents/repositories/nanoclaw/data/email-unsubscribe",
      "readonly": true
    }
  ]
}
```

This mounts the host's metadata scan output read-only at
`/workspace/extra/email-unsubscribe/` inside the container. The agent
reads `sanitized_metadata.json` and `known_unsubscribe_domains.json` from
there; the host script `scripts/email-metadata-extractor.ts` writes them.

**Additional mounts land under `/workspace/extra/<basename>`**, never
inside `/home/node/.claude/`. You cannot "mount a host file into .claude/"
— that's not how `container-runner.ts` works. Per-group state either lives
in `.claude/` (auto-mounted, writable) or in an additional mount under
`/workspace/extra/` (validated by `mount-security.ts`, often read-only).

## Timeout model

The `.env` sets `CONTAINER_TIMEOUT=1800000` (30 min) as the framework
default. Each registered group carries an **explicit** `containerConfig.timeout`
override in its `container_config` JSON column, even when it matches the
default. This is intentional:

- **Explicit intent survives env var changes.** If I (or a skill, or an
  upstream update) flips `.env`, the per-group timeout stays what it was
  supposed to be.
- **Recipe Club carries `"timeout": 7200000`** (2 hours) because the
  nightly builder does real dev work — install, build, test, PR — and
  needs the longer ceiling. This is the *only* group with a non-default
  timeout. Before the migration, `.env` had `CONTAINER_TIMEOUT=7200000`
  globally to support Recipe Club, which meant every other group also got
  2 hours whether it needed them or not. After the migration, Recipe Club
  carries its timeout explicitly and everything else gets the saner 30
  min.

**Gotcha — `||` vs `??`:** `src/container-runner.ts:429` reads
`group.containerConfig?.timeout || CONTAINER_TIMEOUT`. If a future-me ever
sets `timeout: 0` explicitly thinking it means "no timeout," it would
fall through to the env var default because `0 || x === x`. If you ever
need a special timeout semantics, change the operator to `??` or handle
it explicitly. Not a bug today because no group uses `0`.

## Dashboard hard-coding constraints

Several dashboard routes hard-code absolute paths into per-group
directories. **Rewriting or deleting per-group files means you must also
update these routes.** This bit during the migration and I don't want it
to bite again.

| Route file | Hard-coded path | What it reads |
|---|---|---|
| `dashboard/server/routes/beacon-intel.ts:11` | `data/sessions/beacon/.claude/beacon.db` | items, venues for the Beacon Intel dashboard tab |
| `dashboard/server/routes/garmin.ts:9` | `data/sessions/fitness/.claude/` | `garmin-credentials.json` + per-profile DBs |
| `dashboard/server/routes/strava.ts:12,15,533` | `data/sessions/fitness/.claude/{strava.db, strava-credentials.json, ask/}` | Strava dashboard tab + ask flow |
| `dashboard/server/routes/mortgage.ts:10` | `data/sessions/finance/.claude/mortgage-rates.db` | Rate history for the Mortgage dashboard tab |

**When moving per-group state files:**

1. Grep first: `grep -rn "sessions/<old_group>" dashboard/server`
2. Update every hit in the `.ts` source.
3. Recompile: `cd dashboard && npx tsc -p tsconfig.server.json`
4. Restart: `launchctl kickstart -k gui/$(id -u)/com.nanoclaw.dashboard`
5. **Then** delete the old files. Never delete before the grep/recompile/
   restart cycle completes.

### Mortgage task IDs are load-bearing

`dashboard/server/routes/mortgage.ts` also hard-codes the weekly task ID:

```ts
const WEEKLY_TASK_ID = "task-1774321323925-cof6xm";
```

It queries `task_run_logs` by this ID to pull the weekly report's
free-text summary for the dashboard. The daily task ID used to be
hard-coded too (the dashboard regex-parsed rates out of
`task_run_logs.result`) but the migration removed that hack — rates now
come from `mortgage-rates.db` directly.

**Never delete the two mortgage task rows and recreate them.** Always
`UPDATE` in place so the IDs are preserved. If you ever truly need to
rebuild them from scratch, also update the hard-coded ID in
`mortgage.ts` to match.

Same principle applies to any future dashboard integration that
hard-codes a task ID. Check the dashboard source before deleting or
recreating scheduled task rows.

## The mortgage DB contract

Finance is the one group where a per-group DB holds history that tasks
exchange between runs. Documenting it here because the design is a bit
subtle.

**`/home/node/.claude/mortgage-rates.db`** (container path) =
**`data/sessions/finance/.claude/mortgage-rates.db`** (host path).

Schema:

```sql
CREATE TABLE rates (
  date      TEXT PRIMARY KEY,   -- ISO YYYY-MM-DD, one row per day
  rate_30yr REAL NOT NULL,      -- 30-year fixed rate as percentage (e.g. 6.45)
  source    TEXT,               -- e.g. "Freddie Mac PMMS", "Mortgage News Daily", "backfill"
  logged_at TEXT NOT NULL       -- ISO timestamp when row was written
);
```

**Daily tracker** — web search → `INSERT OR REPLACE` today's row → post
chat log line in the format:

```
📈 DAILY RATE LOG [DATE]: 30yr Fixed: **X.XX%** | Source: [source name]
```

The **bold `**X.XX%**`** is required. The dashboard's regex-parse of
`task_run_logs.result` depends on it for backwards compatibility even
though the primary source is now the DB. If a future task prompt drops
the bold, the dashboard silently shows incomplete history.

**Refi alert:** if the rate is **strictly below** 5.80% (not equal),
append:

```
⚠️ ALERT: Rate below 5.80% threshold — potential refinancing opportunity!
```

Strict inequality is intentional. 5.80% exact is the threshold itself.

**Weekly report** — Wed 7:40 AM ET — queries the DB for the last 30 days,
computes weekly and monthly trend, posts a report. Loud-failure rule: if
the 7-day query returns zero rows, it must say so explicitly ("unable to
reconstruct trend, check the daily tracker") rather than fabricate or
web-search for historical rates.

**`source='backfill'`** marks rows seeded from historical task run logs
when this group was first created (Mar 25 – Apr 7, 2026). Fresh runs
write real source names. Filter on `source != 'backfill'` if you want
only post-migration data.

## Adding a new group (runbook)

When the three-question rubric says "new group":

1. **Create the Telegram chat.** Create a new private group, add the bot
   as a member, send one message so the JID lands in `store/messages.db`.
2. **Decide trigger behavior.** Single-purpose dedicated chat → no
   trigger (`requires_trigger=0`). Shared-ish chat where not every
   message should invoke the agent → trigger required (`requires_trigger=1`,
   pattern = `@Andy` to match muscle memory).
3. **Write the group CLAUDE.md.** `groups/<name>/CLAUDE.md`. Cover:
   what lives where (table with container paths), what the group is NOT
   for, conventions, and any shared schemas. See the existing groups
   (beacon, finance, fitness, email) as reference.
4. **Insert the `registered_groups` row** in `store/messages.db`:
   ```sql
   INSERT INTO registered_groups
     (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger, is_main)
   VALUES
     ('tg:-XXXXXXXXX', 'Display Name', 'folder-name', '@Andy',
      '<now ISO>', '{"timeout":1800000}', 0, 0);
   ```
   Include any `additionalMounts` in the `container_config` JSON. Always
   carry an explicit `timeout` even if it matches the framework default.
5. **Create the session dir.** `mkdir -p data/sessions/<name>/.claude`.
   The framework populates `settings.json`, `skills/`, etc. on first
   container start.
6. **Restart NanoClaw.** `launchctl kickstart -k gui/$(id -u)/com.nanoclaw`.
   The state loader reads `registered_groups` on startup.
7. **Smoke test.** Send a plain message in the new Telegram chat and
   confirm: `Telegram message stored` → `Spawning container agent` →
   `Telegram message sent` in `logs/nanoclaw.log`. Confirm the reply
   actually arrives in the chat, not just that the log claims it sent.
8. **Copy state in** (if migrating tasks from another group) — copy
   relevant files into `data/sessions/<name>/.claude/`. Keep originals
   until you've verified the new location works.
9. **Flip scheduled tasks.** `UPDATE scheduled_tasks SET
   group_folder='<name>', chat_jid='tg:-XXXXXXXXX' WHERE id IN (...)`.
   **Preserve task IDs** — always UPDATE, never DELETE-and-INSERT.
10. **Shadow-test before flipping** if you want extra safety: insert
    `schedule_type='once'` rows cloning the prompts but routed at the
    new group. The real scheduled tasks remain in place until you're
    sure.
11. **Update dashboard routes** if the new group has per-group state the
    dashboard should display. Follow the "When moving per-group state
    files" checklist above.
12. **Document the new group here.** Add a row to the Current Groups
    table and the Scheduled Tasks table. Update the state layout
    diagram. Commit to your fork.

## What the migration touched

Full list of changes made during the 2026-04-08 migration (commit
`c0d619f`):

- 4 new groups registered with explicit `containerConfig.timeout`
- Recipe Club's timeout moved from the global env var to its row
- `.env` `CONTAINER_TIMEOUT` flipped from 2h to 30min
- 9 scheduled tasks flipped to new groups via `UPDATE` (IDs preserved)
- State files copied from `telegram_main/.claude/` to new per-group
  `.claude/` directories
- `mortgage-rates.db` created and seeded with 11 rows backfilled from
  `task_run_logs.result` (Mar 25 – Apr 7, excluding a false-positive on
  Mar 24 where the regex matched "5.8% threshold")
- Two mortgage task prompts rewritten to use the DB instead of chat
  history
- Four dashboard routes updated to read from new per-group paths:
  beacon-intel, garmin, strava, mortgage
- Mortgage dashboard route switched from regex-parsing `task_run_logs`
  to `SELECT date, rate_30yr FROM rates`
- `container/skills/email-unsubscribe/SKILL.md` path updated from
  `/workspace/project/data/...` (main-only) to `/workspace/extra/...`
  (email group's additional mount)
- `scripts/email-metadata-extractor.ts` `HISTORY_PATHS` narrowed to
  `groups/email/` only
- Project `CLAUDE.md` updated with new email task schedule + path
- Old state files deleted from `data/sessions/telegram_main/.claude/`
  and `groups/telegram_main/`
- `store/beacon-intel.db` (unreferenced) and
  `data/sessions/nanoclaw-dev/.claude/beacon.db` (stale dev snapshot)
  deleted
- Two pre-existing TS narrow errors in dashboard routes fixed as a bonus
- 6 shadow test rows inserted and cleaned up

## Known gotchas and rough edges

- **`||` vs `??` in the timeout read** — see Timeout Model above.
- **Mortgage daily task is paused.** Unpause via the dashboard task
  toggle or `UPDATE scheduled_tasks SET status='active' WHERE
  id='task-1774321313812-tu4hfc'`. Not unpaused as part of the
  migration to keep the change set small; reactivate separately once
  you've watched it work end-to-end.
- **Email metadata extractor is Gmail-OAuth-dependent.** If
  `sanitized_metadata.json` stops updating, check
  `logs/email-metadata.error.log` for `invalid_grant` and run
  `npx tsx scripts/gmail-auth.ts` to reauth. The email task's scheduled-
  trigger path will emit a loud skip message when metadata is stale, so
  you'll notice.
- **Dashboard routes don't fall back gracefully.** If a per-group file
  is missing, most routes return empty data rather than erroring. The
  dashboard tab looks "working but empty" which can be misleading.
- **The `backups/`, `plans/`, `plugins/`, `projects/`, `session-env/`,
  `shell-snapshots/`, `skills/` dirs inside each `.claude/`** are
  framework-managed. Don't touch manually; they're recreated as needed.
