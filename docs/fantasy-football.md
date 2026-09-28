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

### The content layer

Since 2026-09-15 the data layer also ingests expert-site content — the plan,
per-site feasibility and rules are in `fantasy-football-agent/CONTENT-PLAN.md`,
the code in `ff/content/`. Six sites: The Fantasy Footballers, CBS Sports,
FantasyPros (its article blog via RSS, plus rankings; its player-news scrape
is off), Footballguys, DraftSharks and FantasyLife (ESPN is WAF-blocked and
skipped).
Articles and player-news blurbs land in `articles`, rankings snapshots in
`rankings`, and the Fantasy Footballers' three analysts' projections in
`projections` as source `ffballers`. Names resolve to Sleeper ids through a
constrained resolver that returns NULL on ambiguity rather than guessing.
`python3 -m ff.cli content all --summary` runs everything by hand; the host
jobs below run it on a schedule.

Layer 2 turns each stored article into player-level **claims** (`claims`
table: player, action add/drop/start/sit/buy/sell/hold/stash/watch, horizon
week/ros/dynasty, the author's confidence, a one-line rationale). One
headless `claude -p` call per article with `--tools ""`, no MCP, no session
and a JSON schema enforced — an article that tries to instruct the model can
at worst corrupt its own row. `--bare` must not be used: it skips keychain
credential loading. `python3 -m ff.cli claims --dry-run` shows what one
article would produce without writing; `ff.cli claims --limit N` drains the
queue. Per-article status lives in `article_extractions` and on the Admin
subtab; `ff.cli api claims` lists recent claims.

Layer 3 folds both into per-player consensus (`ff/content/consensus.py`):
`ff.cli api consensus league=… scope=weekly|ros|dynasty [position=] [include=available|mine]`
returns the median position rank across sources with spread and movement,
FantasyPros' expert min/max/std, a confidence-weighted claims tally with the
strongest rationales, roster status and league-correct projections from three
sources; `ff.cli api dossier player=<id>` is the same for one player across
every scope and league. `ff.cli consensus --league … --scope …` prints the
board. The Telegram agent's memory points it at both. This is untrusted text like everything else
in this group — cleaned on write, defanged on read, flagged when it reads as
an instruction.

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

`http://<host-ip>:3100/fantasy`. A league selector scopes everything below it;
**Today** is the landing subtab and carries the **Right now** block at its top.

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
| **Today** | The landing view (`ff.cli api today`). Served from `payload_cache` (built by the ff-news job every 15 min, `_generated_at` / `_cached` in the payload; computed live on a miss older than 20 min). **Right now** at the top (from the payload's `needs_you`; starters the bench already covers go on one quiet "covered off the bench" line), then **Since yesterday** — the diff against the last daily snapshot (snapshots filed once a day after 06:00, kept 14 days): new/cleared drop and injury flags, position-prefixed consensus rank moves on your roster (depth-scaled: at least 2 places or 10% of the previous rank, whichever is larger), new talk/sell/buy lines only when the player has a claim published since the snapshot (a player who merely entered a top-N list because others aged out is not news), new Right-now items; then **your roster as the sites see it** (flagged rows only — drop talk, a falling consensus rank or an injury designation — folded at 5: consensus rank, the claims summary and one quote); **moves** (top three add/drop pairs with the expert overlay, bid in dollars, then a link to Moves); and an **Elsewhere** line linking to Trades (sell talk on your players, or buy targets) and Moves (crowd signals, only when there are any). The dashboard requests the digest with `slim=1`, which serves counts in place of the trade/crowd lists and drops fields the tab does not render; the stored digest, the CLI and the Telegram agent keep the full payload. |
| **Lineup** | Start / sit this week (`ff.cli api lineup`). **Switch these** (swaps the projections suggest, plus bench players the sites rank above a starter he could replace), **streaming** picks at QB/TE/DEF/K grouped by position (highest Rotowire projection first, anyone projected at zero left out, compared against your weakest set starter there), then **Starters**, **Bench**, **IR** and **Taxi** in one column layout, each row led by its **Slot** (QB, RB, WR, TE, FLEX, SFLEX, K, DEF; BN, IR, TX — a fixed gutter left of the name on a phone): Rotowire under this league's scoring (ESPN and the Fantasy Footballers in the tooltip, a ± when they disagree), **matchup** (opponent and the Vegas implied team total as "28 pts", BYE; hover for kickoff, the O/U total, the spread and both sides' implied points) with **usage** under it (last completed week's snap and target share in plain grey, the week-over-week moves and raw counts on hover, carries only when he had some or is a back; no usage line for QB, K or DEF. The payload still carries `role_change` for the Telegram agent; the dashboard does not show it), the consensus rank, what the sites say, and the newest wire note inline. A player whose game has kicked off is locked: his Proj cell reads *played* and shows what he scored, his matchup and usage dim, he is never part of a switch, and the totals stay projections. Guillotine league: a **Survival** card on top — your set total against every surviving roster's, the margin above the lowest rival, last week's chop line. |
| **Moves** | Add / drop / claim / stash (`ff.cli api moves`). The **Board** is the one add/drop list: up to 150 available players sorted by lineup gain, with name/team search, position chips and (weekly leagues) an "include players who wouldn't start" switch; each row carries availability (free, or the waiver clear time and the market's price range), the engine's move with a bid in dollars and who it displaces, rank, sites-say and the crowd's verdict under the name (rest-of-season points and rank for the dynasty league). Then **drop candidates** (bench only, weakest first, capped at 6; hurt players are tagged "hurt, not weak" and sorted last), **stash** (contingent value plus stash claims), **the crowd**, and a collapsed **FAAB market** reference card (price table, rivals' budgets, burn curves). Guillotine league: the **chopped roster** (above the Board while a released player is still on waivers, below it otherwise) — unclaimed players with price and bid guidance sized against live rivals' budgets, every claimed player on one line, and the superflex QB premium in the subtitle. |
| **Trades** | **Trade intel** first (`ff.cli api trade-intel`): sell talk on your roster, a **weakening** list (drop/sit talk or a consensus fall of 3+, softer than a sell call), buy targets on rival rosters (one quote each; the dossier has the rest), for the dynasty league the value gaps between FantasyPros dynasty ECR and FantasyCalc market rank (cheap by the market / sell high) and **your picks** priced at FantasyCalc. Every row has a **price this** action that drops the player (or pick) into the builder. Then the trade builder (`ff.cli api trades`), both rosters (folded at 12 rows), **your surplus → who needs it** (spare players and the managers short at that position), positional strength for every roster, and who actually accepts trades. Chopped guillotine rosters are excluded everywhere. |
| **Rankings** | One **consensus board** card (`ff.cli api consensus`): scope, position and everyone / available always visible; the claims window and a **snapshot date** picker sit in the card header on desktop and behind a Filters toggle on phones. In All, the number before each name is the FLEX / SUPERFLEX / OVERALL rank the list is ordered by; every row shows the position-prefixed median rank (range in the tooltip), then **By source** and **Proj** as one-line sub-columns under their site labels (FP · CBS · FBG · FFB; roto · espn · ffb, projections in the weekly and rest-of-season scopes only), then the sites' lean with one quote. Your own players get a green edge and tint; other owners are not named (the slim payload drops `owner`). The dynasty scope shows age and a rookie flag instead of projections. The dashboard requests `slim=1`, which leaves out the buzz lists and trims each row's claims to the counts and the one quote shown. Folds after 25 rows. |
| **Reading** | One feed (`ff.cli api reading`): articles with the model's one-line summary and the claims each produced, and Rotowire wire notes with role/return tags; filter to my players (my roster in the selected league), articles vs wire, site, claim horizon, window, unread only. Read state is stored per article or note id (`news_read`), so marking read applies in every league. Box-score-only notes are shown only for your players. |
| **Player dossier** (panel) | Opened from any player name (`ff.cli api dossier`), about the league being viewed: who has him and his projection (or points scored, once his game kicks off), a **Games** timeline, one line per ranking list the league plays with FantasyPros' expert range, a **trade value** chart, the claims (five, then a fold) with rationale and link, recent wire notes, age and rookie flag. Described below. |
| **Admin** | Ingest health for the content layer (`ff.cli api content-status`, league-independent): a health line with anything late or failing, three tiles (articles and wire notes in 24h, unresolved names), the **sources** table (every site job, the core feeds and claims extraction in one list with state, last run and what is stored), the **resolver** panel, every article with its extraction status, and the run log (collapsed). The header's health badge summarises the audit, failing sources and `overview.content_health` and links here. |

Retired as tabs: Waiver wire (`WaiversTab.tsx` now only renders Moves' FAAB market card from the moves payload), Experts (renamed Rankings). The News and Trends files were deleted on 2026-09-16 (their actionable rungs live on Moves, Today and Reading). The Alerts section was removed outright on 2026-09-16 (rule engine, `alert_log`, `ff.cli alerts`, tab, route) so a future alerting design starts clean. **Dynasty is league behaviour, not a tab**: selecting the dynasty league puts Trades on dynasty ECR vs market, Moves on rest-of-season, Rankings on the dynasty scope.

**Every panel is served by `python3 -m ff.cli api <endpoint>`.** The Express
route shells out and caches; nothing is recomputed in TypeScript. Since
2026-09-17 the per-league tabs (today, lineup, moves, trade-intel, trades) are
precomputed into the data layer's `payload_cache` by the ff-news job every 15
minutes (`ff.cli digest-cache`) and served while younger than 20 minutes, so a
subtab answers in ~0.2 s instead of 1–4 s; `fresh=1` forces a live build. The
audit behind `overview` is cached for six hours the same way (it used to run on
every page load at ~5 s). The scoring pass itself is memoised per process, and
`rescore_week` / `rank_consensus` / `claim_signals` take a `player_ids` filter,
so the player dossier scores and ranks one player instead of every player (a
cold dossier went from ~2.2 s to ~0.5 s, and Rankings from ~1 s to ~0.5 s).

**The Express route never makes a visitor wait twice** (2026-09-27). Its cache is
stale-while-revalidate: an expired entry is served at once and refreshed in the
background (for up to an hour; after that the request waits), identical
concurrent requests share one Python run, and cache keys ignore parameter order.
A warmer re-runs every tab's default view in every league every 10 minutes
(today, lineup, moves, trade-intel, trades, Rankings QB/RB/WR/TE/All, Reading,
the default "find trades across the league" search, plus overview, news-index
and content-status), so those answer in ~10–100 ms; and every 30 minutes it
warms the dossiers of your own rostered players, since a phone tap has no hover
to prefetch on.
JSON over 2 KB is gzipped. Hovering a player name for 150 ms warms his dossier,
so the click usually opens it in under 100 ms. Admin's Refresh (`refresh=1`)
still waits for fresh data. League-correct
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

**The player dossier** (click any name) is about the league being viewed. Its
header says who has him there (Yours / Free agent / Owned by X) and his number
this week (projection, or what he scored once his game kicked off; the other
sources on hover). **Games** is one timeline: his last four weeks (points scored
under this league's scoring and his position's box score: carries, catches,
yards and TDs for a back, targets for a receiver, passing for a QB, kicks and
defensive stats) and his next five (date, bye, and the O/U and spread once
posted), this season only. Each opponent is coloured green to red by how many
fantasy points it allows his position per game this season (hover for the
number and the games behind it). **Where the sites rank him** is one
line per list the league plays (this week and rest of season, plus dynasty only
in the dynasty league): consensus and move, each site's rank, the FantasyPros
expert range. **Trade value** charts FantasyCalc over every stored daily
snapshot in that league's format, with the 7- and 30-day change. Then what the
sites say and recent wire notes. The Trades rows' "mkt 1,262 ▲659" is the 7-day
change (one game in season); the hover gives 7 and 30 days. Both come from the
stored snapshots, not FantasyCalc's own trend30Day, which is not a plain
difference of its values and disagreed with the chart.

**Player news is one click from anywhere.** Every player name opens the dossier,
which ends with his recent wire notes; Lineup and Moves also carry a fresh (72h)
injury / role note inline under the name. Beside every player name on Today,
Lineup, Moves, Trades and Rankings sits a **news badge**: how many notes he has
in the last 14 days (up to 3), in one hue at three strengths — solid when an
injury / out / role / return note landed in the last 24h, a bright outline
within 72h, dim when there are only older or routine notes (box scores). Red is
kept for a note flagged as reading like an instruction. Hover or tap it for
those notes, newest first, with links. Pure recency would light up nearly every
player the morning after a game, since each gets a box score. The count and
shade for every player, and the headlines, come from one page-wide
`news-index` call (~43KB gzipped, pre-warmed), so a hover shows the notes at
once and no tab's payload carries them. Reading (whose rows are the news) and Admin leave it off.
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
page: the summary, a News card ~400px below it, the player card below that,
and a log. The summary was also a lossy subset of the card under it. The
duplicate card was cut: **"Right now" owns the synthesis**, and the player card owns
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

**Why "Right now" is narrow.** "There is news about a player you own" is not an item
— there is always news. An item needs a state change: a designation, a material
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
| Model | `opus` (containerConfig.model on the registered group; an alias, so it follows the current Opus without a pin). Other groups use the `.env` `CLAUDE_MODEL` default, else the Agent SDK's own (Sonnet). Passed to the container as `ANTHROPIC_MODEL`. |

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

Four host launchd jobs, split by how fast the data underneath them moves.

| Job | Cadence | Refreshes | Script / template |
|---|---|---|---|
| `com.nanoclaw.ff-news` | every 15 min | Sleeper player index, Rotowire notes, **expert-site articles + player news** (content layer), then **`ff.cli digest-cache`**: the Today digest per league into `payload_cache` + the daily snapshot | `scripts/ff-news.sh` · `launchd/com.nanoclaw.ff-news.plist` |
| `com.nanoclaw.ff-live` | every 2h | transactions, matchups, FAAB, **rosters**, **traded picks**, **FantasyPros weekly + ROS ECR and Fantasy Footballers projections** (content layer) | `scripts/ff-refresh.sh live` · `launchd/com.nanoclaw.ff-live.plist` |
| `com.nanoclaw.ff-daily` | 06:40 daily | projections, ownership, market values, injuries, **nflverse usage (snap + target share for the week just played)**, **schedules/Vegas lines**, **CBS + Footballguys rankings, dynasty ECR** (content layer) | `scripts/ff-refresh.sh daily` · `launchd/com.nanoclaw.ff-daily.plist` |
| `com.nanoclaw.ff-claims` | every 15 min | **claim extraction** (content layer 2): up to 8 stored articles per run through headless `claude -p` with no tools, JSON-schema output, on the host's Claude Code login | `scripts/ff-claims.sh` · `launchd/com.nanoclaw.ff-claims.plist` · install `scripts/install-ff-claims-plist.sh` |

All four appear on the dashboard's **Scheduled Tasks** page (last exit, running
state, log tail, trigger-now) via the descriptor list in
`dashboard/server/routes/scheduled-tasks.ts`; the Fantasy › Admin subtab shows
what they *wrote* (per-site ingest runs, articles, claims, the resolver's
misses). The host heartbeat (`scripts/heartbeat.sh`) additionally writes one
`ff-content.<site>.<articles|rankings>` line per enabled adapter into
`data/health-probe/jobs.txt`, aged from the adapter's newest *successful*
`ingest_runs` row with the newest run's state (`ok` or `FAIL:<error>`) in the
last field — so a parser that breaks while the job keeps exiting 0 trips the
watchdog's ordinary job-stale rule within the adapter's cadence.

Install: `scripts/install-ff-news-plist.sh` and `scripts/install-ff-refresh-plists.sh`
(both idempotent). News logs to `logs/ff-news.log`; the other three log to
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

**Not scheduled, by design:** alerting. The previous alert engine was removed
on 2026-09-16 so a future one can start clean; ingestion and notification
stay separate so the alert cadence can change without touching the refresh
cadence.
