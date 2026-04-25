#!/usr/bin/env python3
"""Audit only the 12 never-verified venues with long delay."""
import json, sqlite3, time, importlib.util, os
NANOCLAW = '/Users/danielsaltz/Documents/repositories/nanoclaw'
spec = importlib.util.spec_from_file_location("ts", f"{NANOCLAW}/scripts/ticket-scraper.py")
scraper = importlib.util.module_from_spec(spec); spec.loader.exec_module(scraper)

UNVERIFIED = [
    'chase-field', 'citi-field', 'citizens-bank-park', 'climate-pledge-arena',
    'college-park-center', 'comerica-park', 'coors-field', 'crypto-com-arena',
    'daikin-park', 'dodger-stadium', 'ford-field', 'gainbridge-fieldhouse',
]
DB = f'{NANOCLAW}/data/sessions/tickets/.claude/tickets.db'
DELAY = 40

conn = sqlite3.connect(DB)
mapping = {}
for vs, sec, cat in conn.execute("SELECT venue_slug, section_name, category FROM section_categories"):
    mapping.setdefault(vs, {})[sec] = cat

results = []
for i, slug in enumerate(UNVERIFIED):
    row = conn.execute("""
        SELECT id, stubhub_url FROM events
        WHERE venue_slug = ? AND is_home_game = 0 AND status != 'completed'
          AND stubhub_url IS NOT NULL AND event_datetime > datetime('now')
        ORDER BY event_datetime LIMIT 1
    """, (slug,)).fetchone()
    if not row:
        print(f"[{i+1}/12] {slug}: no event"); continue
    if i > 0: time.sleep(DELAY)
    print(f"[{i+1}/12] {slug} (event {row[0]})...", flush=True)
    result = scraper.fetch_event_prices(row[1])
    if not result or "error" in result:
        err = result.get("error") if result else "none"
        print(f"  SKIP: {err}")
        results.append((slug, None, None, None, []))
        continue
    stubhub = set(result.get("section_prices", {}).keys())
    ours = set(mapping.get(slug, {}).keys())
    matched = stubhub & ours
    unmapped = sorted(stubhub - ours)
    pct = 100*len(matched)/max(len(stubhub),1)
    results.append((slug, len(matched), len(stubhub), pct, unmapped))
    print(f"  {len(matched)}/{len(stubhub)} ({pct:.1f}%) — {len(unmapped)} unmapped")
    if unmapped: print(f"  unmapped: {unmapped[:10]}")

conn.close()
print('\n=== Summary ===')
for slug, m, t, pct, un in sorted(results, key=lambda x: x[3] if x[3] else 100):
    if m is None:
        print(f"  {slug:35s} WAF-blocked")
    else:
        print(f"  {slug:35s} {m:3d}/{t:3d} ({pct:5.1f}%) — {len(un)} unmapped")

with open('/tmp/audit-unverified.json', 'w') as f:
    json.dump([{'venue': s, 'matched': m, 'total': t, 'pct': p, 'unmapped': u} for s,m,t,p,u in results], f, indent=2)
