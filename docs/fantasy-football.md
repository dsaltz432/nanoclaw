# Fantasy Football

Assistant for three Sleeper leagues (12-team redraft, 12-team dynasty, 22-team
superflex guillotine). Sleeper's API is **read-only**, so this subsystem is a
recommender: it produces a short ordered list that a human executes by hand in
the Sleeper app. Nothing here can or should write to Sleeper.

The data layer is a separate repo, `~/Documents/repositories/fantasy-football-agent`,
mounted into the group container. That repo also holds the research the
recommendations are built on (`FINDINGS.md`, `METHOD.md`, `LEAGUES.md`).

| Component | Location |
|-----------|----------|
| Group memory | `groups/fantasy-football/CLAUDE.md` |
| Data layer (package) | `fantasy-football-agent/ff/` |
| SQLite store | `fantasy-football-agent/store/ff.db` |
| Raw source cache | `fantasy-football-agent/data/` (git-ignored, regenerable) |
| Agent-written reports | `fantasy-football-agent/reports/` |
| Research + findings | `fantasy-football-agent/*.md`, `research/` |
| Dashboard tab | `dashboard/src/pages/FantasyPage.tsx` + `dashboard/src/pages/fantasy/` |
| Dashboard API | `dashboard/server/routes/fantasy.ts` |

## Ingest

Nine external sources, all free and unauthenticated. `python3 -m ff.cli` is the
single entry point:

| Command | What it does |
|---------|--------------|
| `backfill` | Every season of all three league chains, transactions, matchups, drafts, historical stats. Run once, and again each August. |
| `daily` | Player DB, Rotowire news, trending, FAAB snapshots, both projection sources, injuries, dynasty values. |
| `live` | In-season: this week's transactions, matchups, stats. |
| `audit` | Coverage assertions. **Non-zero exit means the data is not trustworthy.** |
| `digest` | Per-league text report of everything in the store. |
| `status` / `selftest` | Row counts and freshness; unit tests. |

Every ingest writes a row to `ingest_runs`, success or failure — a partial pull
is visible rather than silent. `audit` additionally re-derives four published
transaction counts from the live store, so a dropped week or a mis-parsed status
fails loudly instead of quietly invalidating every downstream conclusion.

## Container mounts

Four mounts, deliberately layered. The agent reads player-news text written by
strangers, which makes this the one group where a successful prompt injection
would matter — so the **code is read-only** and only the data directories are
writable:

```jsonc
{"additionalMounts": [
  {"hostPath": ".../fantasy-football-agent",         "containerPath": "ff",         "readonly": true},
  {"hostPath": ".../fantasy-football-agent/store",   "containerPath": "ff/store",   "readonly": false},
  {"hostPath": ".../fantasy-football-agent/data",    "containerPath": "ff/data",    "readonly": false},
  {"hostPath": ".../fantasy-football-agent/reports", "containerPath": "ff/reports", "readonly": false}
], "timeout": 1800000}
```

Nested mounts resolve most-specific-first, so `ff/` is read-only while
`ff/store`, `ff/data` and `ff/reports` are writable. Verified: writing to
`ff/ff/scoring.py` inside the container returns `Read-only file system`, and an
ingest into `ff/store/ff.db` succeeds.

`~/Documents/repositories` is already an allowed read-write root in
`~/.config/nanoclaw/mount-allowlist.json`, so no allowlist change is needed.

## The untrusted-text boundary

Player notes, team names, display names and transaction metadata are all free
text written by other people. `ff/sanitize.py` is the boundary:

- invisible characters (bidi overrides, zero-width joiners) are stripped
- `<` and `>` are escaped on every render, so no tag can form — including
  NanoClaw's own `<internal>` tag, which `router.ts` strips from final output
  and which a note could otherwise use to silence a report
- text that reads as an instruction is **flagged, not deleted** — a note that
  tries it is itself worth seeing
- `ff/views.py` and `ff/digest.py` defang everything they return, so the
  boundary does not depend on the agent remembering to call it

## Dashboard tab

`http://<host-ip>:3100/fantasy`. A league selector scopes everything below it, a
**Right now** block sits above the subtabs, then four subtabs.

**Right now** exists because the tabs did not talk to each other. On a live
example the news layer knew a starter had a sprained ankle, that his projection
had fallen 2.2, that the sources disagreed by 7.3, and that a named successor was
the fourth-most-added player in the country — while the waiver board still showed
him as a healthy starter and the successor was nowhere on it. Every fact was on
screen; noticing required cross-referencing three tabs.

An item needs a starter of yours *plus a state change*. Successors get a separate
**contingent value** section rather than promotion into the board, because the
board optimises gain to THIS week's lineup and a handcuff almost never clears that
bar — so expected-value-for-this-week systematically rejects exactly the adds you
regret missing. Each carries the trigger, both conditional values, an option-priced
bid, and a willingness to conclude *"not worth a slot this week"* with the
arithmetic shown. Successors already claimed are named with their new owner,
because a closed window changes the plan.

The promotion rule is provable rather than inferred: if a role-transferring note
published *after* the last projection snapshot, the projection cannot have
incorporated it. That is a fact about timestamps, and it is self-clearing.
Projections already price usage in — the usage-signal null is the precedent — so
the default assumption stays that the projection is right.

| Subtab | What it shows |
|--------|---------------|
| **Waiver wire** | Your roster and projected lineup, bench sorted weakest-first; **suggested roster moves** as add/drop pairs split into free agents (addable now) and waiver claims (Wednesday); the full board, searchable and filterable by position or FLEX, showing **which slot each player would take and from whom**; suggested bid as percent of budget; the tier price table; rivals' remaining budget; budget-burn curves; zero-point starter risk. |
| **Trades** | A **trade builder** — one panel that prices the working deal AND searches from it. Chips in "You give"/"You get" can be pinned; pinned players are held constant while the league is searched for the rest. Prices both sides two ways (league VOR and FantasyCalc market value, draft picks included) with dynasty/redraft modes. Below it, **your roster and any rival's side by side** with click-to-add and click-to-pin; positional surplus and shortfall; counterparty behaviour last, since it is background rather than deal-making. |
| **News** | **My news / All news** — a card per player, ranked by how much it could change a decision, with every note, the projection move, the designation and what corroborates it; cards whose only news is a box score with an unmoved projection fold into a "No change (n)" row; full-text search; article links out to the source. Alerts are deliberately absent — see below. |
| **Alerts** | The four firing rules in plain language, the de-duplicated alert log (what fired, how many times, whether it was ever delivered), and whether any job is actually running them. |

**Every panel is served by `python3 -m ff.cli api <endpoint>`.** The Express
route shells out and caches; nothing is recomputed in TypeScript. League-correct
scoring, the FAAB contest reconstruction and the untrusted-text boundary have
exactly one implementation, and a second one in the dashboard would be a second
set of conventions quietly producing a second set of answers — the failure mode
`METHOD.md` is entirely about. On a CLI failure the route serves the last good
payload marked `_stale` rather than an error page.

Charts are plain SVG on the validated dark palette, checked against the
dashboard's own card surface rather than a generic dark one:

```
node scripts/validate_palette.js "#3987e5,#d95926,#199e70" --mode dark --surface "#111827"
→ all six checks PASS
```

Twelve managers is too many series to colour, so the burn-curve chart emphasises
one named series and draws the rest as recessive context hairlines.

**Managers are named by real name where one is known, otherwise their most
recent Sleeper username. Never by team name.** Team names change
whenever their owner feels like it, so a chart read last week names different
people this week; usernames are stable, every current owner in all three leagues
has one, and the guillotine league has almost no team names at all. It also makes
the dashboard cross-reference with the research, which talks about `dsaltz190`,
`ronbraha` and `micklepickle` — with team names on screen there was no way to tell
which row was which manager. `owner_labels()` in `ff/views.py` is the single
resolver; it still returns the team name for anywhere the flavour is wanted, and
shows the username beside a real name so a row stays cross-referenceable.

Real names live in `people.json`, hand-edited, **keyed on `owner_id`** — because
usernames change too. This league contains two renames (`Splotnik` → `Sploots`,
`Plowtime9696` → `docjoff`) that a handle-keyed map would have silently split
into four managers. The file may be written with handles for legibility; they are
matched against every username an account has ever used and resolved to ids on
load. `python3 -m ff.cli people` lists who is unmapped and prints a paste-ready
stub. Anyone unmapped falls back to their current username.

Identity itself is always the `owner_id`. The frontend used to find "you" by
string-comparing a hardcoded team name, which stopped working the moment anyone
renamed; rows now carry `is_me` and `active` resolved server-side. `active` marks
an account with no current roster — this league contains `Eyal10` (2020–21) and
`Eyalshoham10` (2022–) as separate `owner_id`s, almost certainly the same person
on two accounts, and keying on the id keeps them correctly separate.

**Player news is one click from anywhere.** A small count badge sits beside each
player's name on the waiver board, both roster panels and the trade chips; hover
or tap it for his most recent reports with dates and links. The notes ship with
the page payload (~24KB for a waiver board), so opening one fires no request.
Players with no notes render no badge at all — a greyed-out icon invites a click
that does nothing, while an absent one correctly reads as "nothing to see".

Coverage needed a **backfill** to be useful. `ingest_news` is driven by Sleeper's
`news_updated`, which is the right filter for a daily job — it turns 12,000
possible calls into a few hundred — but it means a player who has been quiet
since the store was created has nothing on file even though ESPN holds his
history. `espn.backfill_news` pulls history for everyone on a roster of mine
regardless of the freshness window, and now runs as part of `daily`. Coverage of
my rostered players went from 30/45 to **43/45**; the two misses are team
defences, which have no ESPN player page.

**Notes are ranked, not just truncated.** Showing a player's three most recent
notes usually meant three consecutive weekly stat lines — Rotowire writes box
scores from a template, so *"Allen rushed three times for four yards in Friday's
17-0 loss"* and *"Allen rushed four times for 44 yards in Friday's 24-16 loss"*
are 0.66 similar and a week apart. They read as duplicates while crowding out the
injury note that mattered. `newsfeed.rank_notes` sorts by topic weight
(out > injury/role > return > transaction > box score), newest first inside a
tier, and truncates after ranking.

**De-duplication keys on TIME, not text.** Those box scores are different events
and collapsing on similarity alone would delete them. What is genuinely a
duplicate is the same fact re-filed within the hour: ESPN republished a Kittle
note differing only in the capitalisation of "Active/PUP", and a Watson note
differing by one "the". So `dedupe_notes` requires ≥0.90 similarity **and**
publication within 90 minutes, comparing headlines with the reporter attribution
stripped — two outlets filing the same fact differ only in the tail. Applied on
read; both rows stay in the store. Five regression tests cover it, including the
negative case.

**Why availability is inferred.** Sleeper publishes no per-player waiver flag. A
player dropped inside the league's `waiver_clear_days` window is on waivers until
the next run; everyone else is addable now. The estimate is only as current as
the last `live` transaction pull, and every payload carrying it says so.

**One event, one presentation.** Jeanty's ankle was appearing four times on one
page: the summary, a News→Alerts card ~400px below it, the player card below
that, and the Alerts-tab log. The summary was also a lossy subset of the card
under it. The News→Alerts card was cut: **"Right now" owns the synthesis, the
Alerts tab owns the rule engine and firing history**, and the player card owns
the dossier. Three surfaces, three jobs, no repeated sentences.

**"Right now" collapses when you switch tabs.** It opens expanded, then folds to
a one-line headline carrying the action the moment you go to work in a tab —
otherwise a summary costs a scroll on every subsequent view. At a 716px viewport
the tab bar sits at y≈478 on load and y≈298 once collapsed.

**It states an action, including "nothing to do".** A briefing that stops at the
facts leaves the reader to infer the conclusion, and the most common conclusion
is that no move is available. On the live example: *"Nothing to add — the
successor is gone. Your fallback is Jonathon Brooks (7.5) off your own bench."*

**Contingent value is news-triggered only.** The man in front must actually be at
risk — a designation, a fresh injury report, or a material projection drop.
Without that condition it degenerates into generic handcuffing and was surfacing
a backup to a starter who had no injury and no note anywhere on the page.
Speculative handcuffs and news-triggered successors need different thresholds;
mixing them dilutes both.

**Rounding happens once, server-side.** `db.r1()` rounds half away from zero and
every consumer prints what it is handed. Formatting the same number in two
languages produced a real bug: a delta of exactly −2.25 rendered as *"fell 2.2"*
in Python's `%.1f` and `-2.3` in JavaScript's `toFixed(1)`, four pixels apart.

**Why alerts are narrow.** "There is news about a player you own" is not an alert
— there is always news. An alert needs a state change: a designation, a material
projection move (2.0 league-correct points), a fresh injury or role report, or
somebody named as taking your player's work. Notes are classified on the
*headline* only; scanning the analysis paragraph turned every box-score recap
into an injury report.

**Why the builder is one panel.** The players you are pricing and the players you
want held constant during a search are the same players. Splitting them into a
"calculator" and a separate "find trades" card meant entering each name twice and
reading two valuations of the same deal. A chip now carries both actions: it is
priced, and it can be pinned.

**Why note links point at a player page.** ESPN returns `links.mobile.href` on
each Rotowire note — `m.espn.go.com/wireless/story?storyId=…` — and it is dead:
it 302s to the ESPN homepage and drops its path, leaving a dangling query string.
`/nfl/story/_/id/{id}` 404s; these are wire notes, not articles, and have no
standalone page. Read paths therefore build
`espn.com/nfl/player/news/_/id/{espn_id}`, which renders the note in context and
is keyed on an id already in the crosswalk. The stored `news.url` column is
retained but unreliable and is not read.

**Why the trade finder ranks the way it does.** Market value is zero-sum, so no
package is good for both sides on value alone — what makes a trade work is that
the rosters need different things. Unpinned, only packages that raise BOTH
starting lineups survive. Pinned, you have already decided you want the move, so
it becomes a return search ranked on market value plus your lineup change
converted at the exchange rate implied by your own roster. Packages that leave
either side unable to field a legal lineup are rejected outright.

**Why the "would take" column exists.** A tight end is eligible for the TE slot
*and* for FLEX, so his bar is whichever is weaker — in a roster with a strong TE
that is the FLEX slot, occupied by a replaceable back. A board that prints
"TE +2.6 over my bar" then reads as "upgrade at tight end" when what it means is
"your weakest starting slot is a flex and a startable TE can fill it". The column
names the slot and the incumbent so the two cannot be confused.

## Alerts: where they live, and why not in Admin

`Admin → Tasks` owns **job health** — cron, last run, duration, exit status,
trigger-now — and picks up fantasy jobs automatically the moment one is
registered, exactly as it does for Sports Briefing and the mortgage tracker.
Duplicating that in the Fantasy tab would create two places to check that can
disagree.

The Fantasy `Alerts` subtab owns what Admin structurally cannot: Admin knows a
task ran for 43 seconds and exited 0. It has no idea it said *"Jeanty sprained
ankle"*, whether that was the fourth day of the same sprain, or whether it ever
reached you. So the split is:

| Question | Where |
|---|---|
| Is the job running? Did it fail? Run it now. | Admin → Tasks |
| What did the alerts say? Was it new? Did it reach me? | Fantasy → Alerts |

`ff.db` holds the alert log; NanoClaw's `scheduled_tasks` holds the job. The
route merges them rather than teaching either side about the other, which is what
lets the page say *"the rule exists but nothing runs it"* — the true state today.

**The log is keyed on the CONDITION, not the run.** An injury that persists for
four days is one alert seen four times, not four alerts. Without that, a job on a
thirty-minute cron re-announces the same sprain until it gets muted. And like the
projection snapshots, it can only be populated going forward: whether an alert was
worth sending has no retroactive answer unless the firing was written down.

**Nothing here sends anything.** `python3 -m ff.cli alerts --emit` returns the
text and marks the rows; a scheduled task owns the channel. It prints nothing
when there is nothing new, which is the behaviour a quiet job needs.

## Scheduling

**Not yet configured.** Ingest is deterministic Python with no model in the loop,
so it belongs in a host launchd cronjob (see [host-cronjobs.md](host-cronjobs.md)),
with NanoClaw scheduled tasks used only for the parts that need an agent to
reason and message. Cadence is still to be decided.

## Telegram group

| | |
|---|---|
| Chat | `Fantasy Football` — `tg:-5468369997` |
| Folder | `groups/fantasy-football/` (memory in its `CLAUDE.md`) |
| Trigger | none — every message in the chat invokes the agent |
| Session | `data/sessions/fantasy-football/.claude/` |
| Mounts | `fantasy-football-agent` read-only at `/workspace/extra/ff`, with `store/` nested read-write so `ff.cli daily` can refresh |

The repo is mounted **read-only on purpose**: this group reads third-party news
text, and it must not be able to rewrite the analysis it is quoting. Only
`store/` is writable, and everything in it is re-fetchable — which is what makes
that exception acceptable.

Ask it questions directly ("who do I pick up in dynasty", "is this trade fair").
Its memory instructs it to answer from an `ff.cli api` call rather than from
training, and to say plainly when the data does not cover the question — whether
a player beats his projection is not modelled, and whether an offer is accepted
cannot be.

## Scheduled jobs

Three host launchd jobs, split by how fast the data underneath them moves.

| Job | Cadence | Refreshes | Script / template |
|---|---|---|---|
| `com.nanoclaw.ff-news` | every 15 min | Sleeper player index, Rotowire notes | `scripts/ff-news.sh` · `launchd/com.nanoclaw.ff-news.plist` |
| `com.nanoclaw.ff-live` | every 2h | transactions, matchups, FAAB, **rosters** | `scripts/ff-refresh.sh live` · `launchd/com.nanoclaw.ff-live.plist` |
| `com.nanoclaw.ff-daily` | 06:40 daily | projections, ownership, market values, injuries, **schedules/Vegas lines** | `scripts/ff-refresh.sh daily` · `launchd/com.nanoclaw.ff-daily.plist` |

Install: `scripts/install-ff-news-plist.sh` and `scripts/install-ff-refresh-plists.sh`
(both idempotent). News logs to `logs/ff-news.log`; the other two log to
`~/.local/share/nanoclaw/logs/ff-{live,daily}.log` — outside `~/Documents`, because
launchd is denied spawn-time access there for a job loaded mid-session
(see [host-cronjobs.md](host-cronjobs.md#exit-78-with-empty-logs--the-documents-spawn-time-gotcha)).

A host cronjob, not a NanoClaw scheduled task, because there is no judgement in
it: pull Sleeper's player index for `news_updated`, then fetch notes for the
players it says changed. No agent needs to read anything, so spawning a
container would burn tokens on six seconds of shell work.

It also cannot alert. There is no `send_message` to call and no final output to
filter, so silence is structural rather than a prompt asking an agent to stay
quiet. When alerting is wanted, that is a **separate** NanoClaw task reading
data this job has already made fresh — keeping ingestion and notification apart
means the alert cadence can change without touching the refresh cadence.

**Why 15 minutes.** The refresh costs ~6s, so the interval is set by how fast a
decision needs the news, not by what the pull costs. Fifteen minutes is ~7
minutes of average detection latency, and that matters in exactly one place: a
**free agent** is first-come, so when a starter's backup is unrostered the edge
goes to whoever adds first. Waiver claims are immune — they all process together
at Wednesday 03:00 ET, so being an hour earlier changes nothing there.

**Rosters need their own step.** `ff.cli live` labels one of its steps
`rosters:<league>`, but that step calls `sleeper.ingest_faab_snapshot`, which
writes `faab_snapshots` only. The player list on a roster is written by
`sleeper.ingest_league_chain`, which runs from `pipeline.backfill` — seasonal
setup — and from nothing on a schedule. Left alone the symptom is that you add a
player, the transaction is ingested, and the roster panel still shows the man you
dropped. `scripts/ff-refresh.sh` therefore calls `ingest_league_chain` itself
(with `max_seasons=1`) after `ff.cli live`. The tidier fix is to add the step to
`pipeline.live` upstream in `fantasy-football-agent`; it lives here so that repo,
which also feeds the Telegram agent, stays untouched.

**So do schedules, for the same reason.** `nflverse.ingest_schedules` is also
reachable only from `pipeline.backfill`, while `ff/api.py` reads `total_line` and
`spread_line` out of that table for game environment — Vegas lines, which move on
injury news and are posted about a week ahead. Left to `backfill` alone the table
goes stale where it has numbers and stays empty for weeks not yet published.
`ff-refresh.sh daily` calls `ingest_schedules` (one CSV, whole season).

`sleeper.drafts` is genuinely static in-season and is correctly left to `backfill`.

**Still not scheduled:** alerting. `ff.cli alerts --emit` has no job, by design —
see the alerting section above; ingestion and notification are kept apart so the
alert cadence can change without touching the refresh cadence.
