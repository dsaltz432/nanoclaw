# Sports Briefings

Generate interactive, shareable HTML briefing pages for upcoming sporting events.

## Hard Rules

1. **No agent name anywhere.** No "Andy's Briefing", no agent attribution in headers, footers, or titles.
2. **Use actual dates only.** "April 18" not "tomorrow" or "tonight." These pages are permanent.
3. **Sticky nav required.** `position: sticky; top: 0; z-index: 100;` with anchor links to each section. Every section needs an `id`.
4. **No duplicate stories.** If it's in a team card, it cannot be in Human Interest. Every entry unique.
5. **Human Interest stories default collapsed.** Title visible, body hidden. Click to expand.
6. **Event-start meta tag required.** Put `<meta name="event-start" content="YYYY-MM-DD">` in the `<head>`, set to the event's first day (ISO date). The index page reads this to display and sort briefings — a missing tag falls back to upload time and sorts wrong.

## Research First

Before writing anything, search the web for:
- Rosters, standings, seedings, recent form, injuries
- Schedule, venues, TV/streaming info
- Historical results and past champions
- **Human interest stories separately** — player backgrounds, family connections, personal journeys, off-court stories. This requires its own searches beyond box scores.

## Output

Save a self-contained HTML file to `/workspace/extra/briefings/` using kebab-case: `nba-playoffs-2026.html`. Include the `event-start` meta tag in the `<head>` (Hard Rule 6).

A host-side watcher uploads to GCS. After saving, send the user a 2–3 sentence preview and the raw URL on its own line:
`https://storage.googleapis.com/sports-briefings/{filename}.html`

## Technical

- React via CDN (react, react-dom, babel-standalone)
- All CSS inline, dark background (#0a0a0a), mobile-responsive
- Gradient accent bar in event colors
- Filter buttons (All/Favorites/Wildcards/Underdogs), default to Favorites
- Collapsible cards with smooth animations

## Validate before saving

**Required, not optional.** Run a Babel parse check before writing the final file. Apostrophes silently break Babel in JS string literals and need different handling than apostrophes in JSX text nodes.

**JS string literals** (`const text = '...'`, `{ label: '...' }`): apostrophes in contractions will silently break the parse. Use backtick template literals for any string with an apostrophe — `` `he hasn't won yet` `` — or escape as `\'`. Prefer backticks.

**JSX text nodes** (`<p>He hasn't won yet.</p>`): apostrophes are fine as-is. **Do NOT escape with `\'` here** — JSX renders `\'` literally as backslash-apostrophe, which shows up broken on the page.

**Golden rule:** put write-up text directly in JSX markup, not in JS variables. Only use JS strings for short labels, and use backticks if they contain contractions.

Run this check before saving:

```bash
# Download babel-standalone once if missing:
[ -f /tmp/babel.min.js ] || curl -sL https://unpkg.com/@babel/standalone/babel.min.js -o /tmp/babel.min.js

node -e "
const fs = require('fs');
const Babel = require('/tmp/babel.min.js');
const content = fs.readFileSync('/workspace/extra/briefings/FILENAME.html', 'utf8');
const match = content.match(/<script type=\"text\/babel\">([\s\S]*?)<\/script>/);
try { Babel.transform(match[1], { presets: ['react'] }); console.log('PARSE OK'); }
catch(e) { console.log('PARSE ERROR:', e.message); }
"
```

If parse fails: an apostrophe is inside a JS string literal. Switch that string to a backtick template literal. Do NOT add `\'` escapes to JSX text nodes.

Also confirm the `event-start` meta tag (Hard Rule 6) is present and is a valid ISO date — the index page depends on it:

```bash
grep -qE '<meta name="event-start" content="[0-9]{4}-[0-9]{2}-[0-9]{2}">' /workspace/extra/briefings/FILENAME.html \
  && echo "EVENT-START OK" || echo "ERROR: missing or malformed event-start meta tag"
```

If it errors, add `<meta name="event-start" content="YYYY-MM-DD">` to the `<head>` with the event's first day before saving.

## Sections

1. **Explainer** — Format, how it works, why care. Hype it up for a casual fan.
2. **History** — Past champions, iconic moments.
3. **Bracket/Groups** (if applicable)
4. **Team Cards** (8–10 teams) — Title, subtitle, role badge (FAVORITE/WILDCARD/UNDERDOG), 2–3 paragraph write-up, unique player storyline hook, stat card for top favorite. Max 3 paragraphs.
5. **Rest of Field** — One-liners, ordered by seed.
6. **Human Interest** (8–12 stories) — Stories about people and the forces shaping their sport. Requires dedicated web research beyond standings. Each entry: 2–3 sentences, collapsible, unique to this section.
   - YES: comebacks, family ties, personal journeys, off-court stories, career milestones, backstories
   - YES: high-profile disputes that directly affect athletes — prize money fights, player boycotts, eligibility battles, labor actions. If players are walking out of press conferences over it, it belongs here.
   - NO: dry rule-change explanations with no human stakes, matchup previews, duplicates from team cards, two entries same person
7. **Key Dates** — Eastern Time, include TV/streaming.
8. **TL;DR** — 3–4 sentences you'd text to a group chat.

## Tone

Confident and dry. State absurd facts plainly — don't explain the joke. Vary comedic angles across teams. Cut anything that *describes* drama instead of showing it. Assume a casual fan. Roast locations specifically (not generically). Give underdogs real personality.

## Daily Scout

Search for events starting in 1–2 weeks. Message user only if something notable. No "nothing found" updates. If user wants a briefing, generate it per this doc.
