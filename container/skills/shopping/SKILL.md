# Shopping Price Checker

Check prices for tracked products using structured data sources.
Browser is a last resort only.

## CRITICAL RULES

- **Do NOT write custom Python scraping code.** Use only the provided
  helper scripts (`shopping-db.py`, `serper.py`) and `curl`.
- **Record snapshots as you go.** Don't wait until the end. If you
  found a price, record it immediately before moving to the next source.
- **Budget ~5 minutes per product.** Move fast. Skip anything slow.
- **Serper results are unverified.** Record them with `verified=0`.
  The links from Serper are Google redirect URLs, not direct retailer
  links — set `source_url` to `null` for Serper results.
- **Filter out used, refurbished, bundles, and wrong models.** Only
  record prices for the exact new product. Check the title carefully.

## Workflow

1. **Get products due for checking:**
   ```bash
   python3 /home/node/nanoclaw/scripts/shopping-db.py due
   ```

2. **For each product**, run these phases in order. Record snapshots
   after EACH phase — don't batch them.

   ### Phase 1 — Cached URLs via JSON-LD (~2 min)

   ```bash
   python3 /home/node/nanoclaw/scripts/shopping-db.py cached-urls <product_id>
   ```

   For each URL returned:
   ```bash
   curl -s -L -H "User-Agent: Mozilla/5.0" "<url>" | python3 -c "
   import sys, json, re
   html = sys.stdin.read()
   for m in re.finditer(r'<script[^>]*type=[\"'\''']application/ld\+json[\"'\'''][^>]*>(.*?)</script>', html, re.DOTALL):
       try:
           data = json.loads(m.group(1))
           items = data.get('@graph', [data]) if isinstance(data, dict) else [data]
           for item in items:
               if item.get('@type') == 'Product':
                   offers = item.get('offers', {})
                   if isinstance(offers, list): offers = offers[0] if offers else {}
                   price = offers.get('price')
                   avail = offers.get('availability', '')
                   if price:
                       print(json.dumps({'price': float(price), 'in_stock': 1 if 'InStock' in avail else 0}))
       except: pass
   "
   ```

   If a price is found, record a **verified** snapshot and mark success:
   ```bash
   python3 shopping-db.py snapshot '{"product_id":1, "source":"amazon", "price":189.99, "source_url":"<url>", "in_stock":1, "verified":1, "snapshot_source":"json-ld"}'
   python3 shopping-db.py cache-url '{"product_id":1, "source":"amazon", "canonical_url":"<url>", "success":1}'
   ```

   If fetch fails or no JSON-LD found, mark failure:
   ```bash
   python3 shopping-db.py cache-url '{"product_id":1, "source":"amazon", "canonical_url":"<url>", "success":0}'
   ```

   ### Phase 2 — Serper Shopping API (~1 min)

   Run **2-3 queries** to maximize retailer coverage:
   ```bash
   # Query 1: exact model number (catches niche retailers with SKU in title)
   python3 /home/node/nanoclaw/scripts/serper.py shopping "<model number>"
   # Query 2: product name (catches big-box retailers)
   python3 /home/node/nanoclaw/scripts/serper.py shopping "<brand> <product name>"
   # Query 3 (optional): long-tail
   python3 /home/node/nanoclaw/scripts/serper.py shopping "<product name> price"
   ```

   Collect all results from all queries, then **dedupe by retailer**.
   If the same retailer appears multiple times (at different prices),
   take the **lowest price** for that retailer.

   Use your judgment to identify which results match the product —
   fuzzy matching is fine. If the product has `match_tokens` set
   (e.g. `["NS-LGC05", "3 cup"]`), require at least one token to
   appear in the title. If `exclude_tokens` is set (e.g.
   `["5 cup", "10 cup"]`), skip results containing those.

   **Be inclusive, not exclusive.** Only skip results that are clearly wrong:
   - Obviously different product (e.g. a skillet when tracking a rice cooker)
   - Wrong size/capacity (e.g. 10-cup when tracking a 3-cup)
   - Used, refurbished, or "open box" (check the title)
   - Bundles with other products

   For each matching result:
   1. Extract `price` (strip the `$` prefix) and `source` (retailer name)
   2. Normalize source to lowercase: `amazon`, `walmart`, `target`,
      `bestbuy`, `ebay`, or `other`
   3. Skip if Phase 1 already found a verified price for the same retailer
   4. **Record immediately** as unverified with `snapshot_source=serper-shopping`.
      Serper links are Google redirects, not direct retailer links, so
      set `source_url` to null. Include `retailer_slug` and `retailer_display`:
      ```bash
      python3 shopping-db.py snapshot '{"product_id":1, "source":"walmart", "price":189.99, "source_url":null, "in_stock":1, "verified":0, "snapshot_source":"serper-shopping", "retailer_slug":"walmart", "retailer_display":"Walmart"}'
      ```
   5. For new retailers not yet in the URL cache, try to find their
      canonical product URL via the title and retailer name, then cache
      it for Phase 1 on the next run.

   ### Phase 3 — Reddit deals (~1 min, best-effort)

   ```bash
   curl -s -H "User-Agent: NanoClaw/1.0" \
     "https://www.reddit.com/r/buildapcsales/search.json?q=<product>&restrict_sr=1&sort=new&limit=10"
   ```

   Also check `r/deals` and `r/frugal`. Parse the JSON response.
   For posts from the last 7 days that mention a price in the title,
   record as `source=reddit`, `verified=0`, `snapshot_source=reddit`,
   with the Reddit post URL as `source_url`.

   ### Phase 4 — Browser fallback (ONLY if phases 1-3 found ZERO prices)

   If no snapshots were recorded from the phases above, use the
   browser to visit the product's original `source_url` and extract
   the price visually. Cap at 2 minutes. If it doesn't work, give up.

   **Do NOT use the browser if any prices were found above.**

3. **Update last_checked** after each product:
   ```bash
   python3 /home/node/nanoclaw/scripts/shopping-db.py update-checked <id>
   ```

4. **Report summary** to chat:
   - Products checked, best price per product (source + price)
   - How many verified vs unverified prices found
   - Any notable changes from previous check
