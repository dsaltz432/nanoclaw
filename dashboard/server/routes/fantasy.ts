import { Router, Request, Response } from "express";
import { execFile } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import zlib from "zlib";

/**
 * Fantasy Football routes.
 *
 * Every payload comes from `python3 -m ff.cli api <endpoint>` in the
 * fantasy-football-agent repo. Nothing is computed here on purpose: league-correct
 * scoring, the FAAB contest reconstruction and the untrusted-text boundary each
 * have exactly one implementation, in Python. A second one in TypeScript would be
 * a second set of conventions quietly producing a second set of answers — which is
 * the failure mode that repo's METHOD.md is entirely about.
 *
 * Consequence worth knowing: the strings in these payloads (player-news text, team
 * names, manager display names) are written by third parties and have already been
 * defanged by ff/sanitize.py. The frontend renders them as text, never as HTML.
 */

const FF_ROOT =
  process.env.FF_ROOT ||
  path.join(os.homedir(), "Documents/repositories/fantasy-football-agent");

const PYTHON = process.env.FF_PYTHON || "python3";
const TIMEOUT_MS = 90_000;
const MAX_BUFFER = 64 * 1024 * 1024;

// Endpoint -> cache TTL.
const TTL_MS: Record<string, number> = {
  overview: 30_000, // the audit inside it is cached daily in the data layer
  trades: 30_000,
  assets: 600_000,
  "trade-eval": 0, // never cached — it is a function of the user's own input
  // A full-league package search is seconds of CPU; the result only moves when
  // rosters or projections do, which is once a day.
  "trade-generate": 600_000,
  // Job health for the content layer; the underlying job runs every 15 min.
  "content-status": 30_000,
  // Layer 3: rankings x claims x projections. Inputs move hourly at most.
  consensus: 300_000,
  dossier: 120_000,
  // The news badge: one index for the page, headlines included. Notes land
  // every 15 min; the shade thresholds are 24h and 72h.
  "news-index": 120_000,
  // The landing digest is precomputed by the ff-news job into payload_cache
  // (served in ~0.2s), so the route cache only needs to absorb a burst of
  // tabs, not hide a slow build.
  today: 30_000,
  // Reading is cheap and changes every 15 min.
  reading: 60_000,
  "reading-read": 0,
  // lineup / moves / trade-intel / trades are precomputed per league by the
  // ff-news job (api.cached_tab, 20 min), so the CLI answers in ~0.2s and the
  // route cache only absorbs a burst of tabs.
  lineup: 30_000,
  moves: 30_000,
  "trade-intel": 30_000,
};

type CacheEntry = { at: number; value: unknown };
const cache = new Map<string, CacheEntry>();
/** One Python run per key at a time: a second identical request waits on the first. */
const inflight = new Map<string, Promise<unknown>>();

/**
 * How long an expired entry may still be served while it refreshes in the
 * background (stale-while-revalidate). Every payload here is at most a
 * 15-minute job behind anyway; waiting 0.3-1s for Python on each visit bought
 * nothing but latency. Past this age a request waits for fresh data.
 */
const MAX_STALE_MS = 60 * 60_000;

function ffAvailable(): boolean {
  return fs.existsSync(path.join(FF_ROOT, "ff", "cli.py"));
}

/**
 * `background` runs it under `nice`: the dossier warmer's batches are seconds
 * of CPU on a two-core machine, and a click's own Python run must not queue
 * behind them. `timeoutMs` overrides TIMEOUT_MS.
 */
function runFf(
  endpoint: string,
  params: Record<string, string>,
  { background = false, timeoutMs = TIMEOUT_MS }: { background?: boolean; timeoutMs?: number } = {},
): Promise<unknown> {
  const args = ["-m", "ff.cli", "api", endpoint];
  for (const [k, v] of Object.entries(params)) args.push(`${k}=${v}`);
  return new Promise((resolve, reject) => {
    execFile(
      background ? "nice" : PYTHON,
      background ? ["-n", "10", PYTHON, ...args] : args,
      { cwd: FF_ROOT, timeout: timeoutMs, maxBuffer: MAX_BUFFER },
      (err, stdout, stderr) => {
        // A non-zero exit still emits a JSON body for known errors, so parse first
        // and only fall back to the process error if there is nothing to read.
        const text = (stdout || "").trim();
        if (text) {
          try {
            return resolve(JSON.parse(text));
          } catch {
            /* fall through to the error path */
          }
        }
        reject(new Error(err ? err.message : stderr || "no output from ff.cli"));
      }
    );
  });
}

/** Only these keys are ever forwarded to the CLI. */
const ALLOWED_PARAMS = new Set([
  "league",
  "limit",
  "hours",
  "scope",
  "side",
  "q",
  "give",
  "get",
  "pin_mine",
  "pin_theirs",
  "counterparty",
  "source",
  "kind",
  "player",
  "horizon",
  "position",
  "include",
  // Rankings: pin the consensus board to an earlier snapshot date.
  "snapshot",
  // Rankings: a later week's projections (the week picker).
  "week",
]);

/**
 * Params set server side, whatever the query says. `slim=1` trims a payload to
 * what its tab renders (today: counts in place of the trade and crowd lists,
 * flagged roster rows only; consensus: no buzz lists, claims cut to the counts
 * and one quote). The CLI and the Telegram agent call without it and get the
 * whole payload.
 */
const FIXED_PARAMS: Record<string, Record<string, string>> = {
  today: { slim: "1" },
  consensus: { slim: "1" },
};

function collectParams(req: Request, endpoint: string): Record<string, string> {
  const out: Record<string, string> = { ...(FIXED_PARAMS[endpoint] ?? {}) };
  for (const [k, v] of Object.entries(req.query)) {
    if (!ALLOWED_PARAMS.has(k) || k in out || typeof v !== "string") continue;
    // Params are passed as argv, not through a shell, so there is no quoting
    // hazard — but keep them to a conservative character set anyway.
    if (!/^[A-Za-z0-9_,.\- ]{0,300}$/.test(v)) continue;
    out[k] = v;
  }
  return out;
}

/** The cache key: params sorted, so the same request is one entry whatever its order. */
function cacheKey(endpoint: string, params: Record<string, string>): string {
  const sorted = Object.keys(params)
    .sort()
    .map((k) => [k, params[k]!]);
  return `${endpoint}?${new URLSearchParams(sorted).toString()}`;
}

/** Run (or join the run already going for) one endpoint + params, and cache it. */
function fetchFresh(endpoint: string, params: Record<string, string>, key: string, ttl: number): Promise<unknown> {
  let p = inflight.get(key);
  if (!p) {
    p = runFf(endpoint, params)
      .then((value) => {
        if (ttl > 0) cache.set(key, { at: Date.now(), value });
        return value;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  return p;
}

/**
 * JSON, gzipped when it is big enough to matter and the client takes it: the
 * Moves payload is ~200KB and content-status ~110KB of very repetitive JSON.
 */
function sendJson(req: Request, res: Response, body: unknown, status = 200) {
  const text = JSON.stringify(body);
  res.status(status);
  if (text.length > 2048 && /\bgzip\b/.test(String(req.headers["accept-encoding"] ?? ""))) {
    res.set({ "Content-Type": "application/json; charset=utf-8", "Content-Encoding": "gzip", Vary: "Accept-Encoding" });
    return res.send(zlib.gzipSync(text, { level: 6 }));
  }
  res.type("application/json").send(text);
}

async function serve(endpoint: string, req: Request, res: Response) {
  if (!ffAvailable()) {
    return res.status(503).json({
      error: "fantasy-football-agent not found",
      detail: `Looked in ${FF_ROOT}. Set FF_ROOT if the repo lives elsewhere.`,
    });
  }
  const params = collectParams(req, endpoint);
  const key = cacheKey(endpoint, params);
  const ttl = TTL_MS[endpoint] ?? 60_000;
  const hit = cache.get(key);
  const age = hit ? Date.now() - hit.at : Infinity;
  const forced = req.query.refresh === "1";

  if (hit && !forced && age < ttl) {
    return sendJson(req, res, { ...(hit.value as object), _cached_at: new Date(hit.at).toISOString() });
  }
  // Expired but recent: answer now, refresh behind it. The next visit gets
  // the new copy. `refresh=1` (Admin's button) always waits for fresh data.
  if (hit && !forced && ttl > 0 && age < MAX_STALE_MS) {
    fetchFresh(endpoint, params, key, ttl).catch(() => {});
    return sendJson(req, res, { ...(hit.value as object), _cached_at: new Date(hit.at).toISOString() });
  }
  try {
    sendJson(req, res, await fetchFresh(endpoint, params, key, ttl));
  } catch (e) {
    // Serve stale data rather than nothing — a Moves board from ten minutes ago
    // is far more useful at 11pm on a Tuesday than an error page.
    if (hit) {
      return sendJson(req, res, {
        ...(hit.value as object),
        _stale: true,
        _error: (e as Error).message,
        _cached_at: new Date(hit.at).toISOString(),
      });
    }
    sendJson(req, res, { error: (e as Error).message }, 500);
  }
}

/**
 * Keep every tab's default view warm, so the first visit after a quiet spell
 * does not pay for Python either: each league's precomputed tabs, its Rankings
 * views (QB, the default, plus All, RB, WR and TE) and default Reading view,
 * and the page-wide overview, news index and Admin status. Runs one request
 * at a time, every WARM_EVERY_MS, and skips anything still fresh. The params mirror what each tab asks for by default;
 * keys are order-independent (cacheKey), so they land on the same entries.
 */
const WARM_EVERY_MS = 10 * 60_000;

async function warm() {
  if (!ffAvailable()) return;
  const jobs: [string, Record<string, string>][] = [
    ["overview", {}],
    ["news-index", {}],
    ["content-status", { limit: "120" }],
  ];
  try {
    const key = cacheKey("overview", {});
    const ov = (cache.get(key)?.value ?? (await fetchFresh("overview", {}, key, TTL_MS.overview ?? 60_000))) as {
      leagues?: { league_key: string }[];
    };
    for (const { league_key: league } of ov.leagues ?? []) {
      for (const ep of ["today", "lineup", "moves", "trade-intel", "trades"]) jobs.push([ep, { league }]);
      // Rankings opens on QB; All, RB, WR and TE are the next clicks.
      const scope = league === "dynasty" ? "dynasty" : "weekly";
      for (const position of ["QB", "RB", "WR", "TE"])
        jobs.push(["consensus", { league, scope, hours: "168", limit: "200", position }]);
      jobs.push(["consensus", { league, scope, hours: "168", limit: "120" }]);
      jobs.push(["reading", { league, scope: "mine", kind: "all", hours: "72", limit: "200" }]);
      // "Find trades across the league" with nothing pinned: a 5s search
      // whose answer only moves when rosters or projections do.
      jobs.push(["trade-generate", { league, limit: "12" }]);
    }
  } catch {
    /* no overview, no league list: warm the page-wide ones only */
  }
  for (const [ep, q] of jobs) {
    const params = { ...(FIXED_PARAMS[ep] ?? {}), ...q };
    const key = cacheKey(ep, params);
    const ttl = TTL_MS[ep] ?? 60_000;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < ttl) continue;
    await fetchFresh(ep, params, key, ttl).catch(() => {});
  }
}
// The dossier sweep reads the tab payloads this fills, so it follows the first run.
setTimeout(() => void warm().then(warmDossiers).catch(() => {}), 5_000);
setInterval(() => void warm(), WARM_EVERY_MS).unref();

/**
 * The dossier of every player a tab shows, so a click on any name opens the
 * popup at once, phone taps included (a phone has no hover to prefetch on).
 *
 * A cold dossier is its own Python process: ~0.35-0.5 s on this machine when
 * it is quiet and 1-3 s while the news, claims and warm jobs are busy. So every
 * 30 min this collects, per league, every `player_id` in the cached default
 * views (Lineup first, so your own players go first; then Today, Moves, Trade
 * intel, Trades, which carries every rostered player, Rankings and Reading),
 * ~350-700 players a league, and computes them in `dossiers` batches: one
 * process per DOSSIER_BATCH players, ~30-40 ms a player, so a full sweep is
 * ~1 min of niced CPU. Each lands under the same key a click asks for, and
 * `serve` answers from it for up to MAX_STALE_MS (the sweep keeps every entry
 * under ~35 min old).
 */
const WARM_DOSSIERS_EVERY_MS = 30 * 60_000;
const DOSSIER_BATCH = 150;
/** Cached payloads whose players get their dossiers warmed; Lineup first. */
const DOSSIER_SOURCES = ["lineup", "today", "moves", "trade-intel", "trades", "consensus", "reading"];
/** An entry a click or hover refreshed this recently is left alone. */
const DOSSIER_FRESH_MS = 10 * 60_000;
/** A dossier not refreshed in this long (no tab shows him, nobody opened him) is dropped. */
const DOSSIER_EVICT_MS = 6 * 60 * 60_000;
/**
 * Guards, so a regression in the Python cannot turn the sweep into minutes of
 * CPU on this two-core machine (a slow per-player query once made it ~0.55 s a
 * player and the sweep ran for 8+ min). A full sweep is ~1-2 min: past the
 * budget no new batch starts; a batch past its timeout is killed; and a batch
 * averaging more than DOSSIER_SLOW_MS_PER_PLAYER stops the sweep, since
 * batching has then stopped paying and the hover prefetch covers clicks. Each
 * sweep logs one line with its size and speed (logs/stdout.log; a stopped one
 * to logs/stderr.log), so a slowdown shows before it hurts.
 */
const DOSSIER_SWEEP_BUDGET_MS = 4 * 60_000;
const DOSSIER_BATCH_TIMEOUT_MS = 60_000;
const DOSSIER_SLOW_MS_PER_PLAYER = 250;

/** Every `player_id` string anywhere in a payload. */
function collectPlayerIds(v: unknown, out: Set<string>) {
  if (Array.isArray(v)) {
    for (const x of v) collectPlayerIds(x, out);
  } else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      if (k === "player_id" && (typeof x === "string" || typeof x === "number") && x !== "") out.add(String(x));
      else if (x && typeof x === "object") collectPlayerIds(x, out);
    }
  }
}

let dossierSweep = false;

async function warmDossiers() {
  if (dossierSweep || !ffAvailable()) return;
  dossierSweep = true;
  try {
    const now = Date.now();
    for (const [key, entry] of cache)
      if (key.startsWith("dossier?") && now - entry.at > DOSSIER_EVICT_MS) cache.delete(key);
    // The dossier is per league (its ranking scopes, trade-value format and
    // scoring), so each league's players are warmed under that league.
    const byLeague = new Map<string, Set<string>>();
    for (const ep of DOSSIER_SOURCES)
      for (const [key, entry] of cache) {
        if (!key.startsWith(`${ep}?`)) continue;
        const league = new URLSearchParams(key.slice(ep.length + 1)).get("league");
        if (!league) continue;
        if (!byLeague.has(league)) byLeague.set(league, new Set());
        collectPlayerIds(entry.value, byLeague.get(league)!);
      }
    const sweepStart = Date.now();
    const done: string[] = [];
    let warmed = 0;
    let stopped = "";
    sweep: for (const [league, ids] of byLeague) {
      const todo = [...ids].filter((player) => {
        const hit = cache.get(cacheKey("dossier", { league, player }));
        return !hit || Date.now() - hit.at > DOSSIER_FRESH_MS;
      });
      let n = 0;
      for (let i = 0; i < todo.length; i += DOSSIER_BATCH) {
        if (Date.now() - sweepStart > DOSSIER_SWEEP_BUDGET_MS) {
          stopped = `over the ${DOSSIER_SWEEP_BUDGET_MS / 60_000} min budget at ${league}`;
          warmed += n;
          done.push(`${league} ${n}/${todo.length}`);
          break sweep;
        }
        const batch = todo.slice(i, i + DOSSIER_BATCH);
        const started = Date.now();
        const out = (await runFf(
          "dossiers",
          { league, players: batch.join(",") },
          { background: true, timeoutMs: DOSSIER_BATCH_TIMEOUT_MS },
        ).catch((e: Error) => {
          stopped = `${league} batch failed: ${e.message.slice(0, 120)}`;
          return null;
        })) as { dossiers?: Record<string, { error?: string }> } | null;
        for (const [player, value] of Object.entries(out?.dossiers ?? {})) {
          if (!value || value.error) continue;
          const key = cacheKey("dossier", { league, player });
          // A click refreshed it while this batch ran: that copy is newer.
          if ((cache.get(key)?.at ?? 0) > started) continue;
          cache.set(key, { at: Date.now(), value });
          n++;
        }
        const perPlayer = (Date.now() - started) / batch.length;
        // A short tail batch is mostly the ~1 s process start: judge full ones.
        if (!out || (batch.length >= 50 && perPlayer > DOSSIER_SLOW_MS_PER_PLAYER)) {
          stopped ||= `${league} batch at ${Math.round(perPlayer)} ms/player (limit ${DOSSIER_SLOW_MS_PER_PLAYER})`;
          warmed += n;
          done.push(`${league} ${n}/${todo.length}`);
          break sweep;
        }
      }
      warmed += n;
      done.push(`${league} ${n}/${todo.length}`);
    }
    const secs = (Date.now() - sweepStart) / 1000;
    const line = `[fantasy] dossier sweep: ${done.join(", ") || "nothing to warm"} in ${secs.toFixed(1)} s${
      warmed ? ` (${Math.round((secs * 1000) / warmed)} ms/player)` : ""
    }`;
    if (stopped) console.warn(`${line}; STOPPED: ${stopped}`);
    else console.log(line);
  } finally {
    dossierSweep = false;
  }
}
setInterval(() => void warmDossiers().catch(() => {}), WARM_DOSSIERS_EVERY_MS).unref();

const router = Router();

router.get("/api/fantasy/overview", (req, res) => serve("overview", req, res));
router.get("/api/fantasy/trades", (req, res) => serve("trades", req, res));
router.get("/api/fantasy/trade-eval", (req, res) => serve("trade-eval", req, res));
router.get("/api/fantasy/assets", (req, res) => serve("assets", req, res));
router.get("/api/fantasy/trade-generate", (req, res) => serve("trade-generate", req, res));
router.get("/api/fantasy/content-status", (req, res) => serve("content-status", req, res));
router.get("/api/fantasy/today", (req, res) => serve("today", req, res));
router.get("/api/fantasy/reading", (req, res) => serve("reading", req, res));
router.get("/api/fantasy/lineup", (req, res) => serve("lineup", req, res));
router.get("/api/fantasy/moves", (req, res) => serve("moves", req, res));
router.get("/api/fantasy/trade-intel", (req, res) => serve("trade-intel", req, res));

/**
 * Mark Reading items (articles or notes) read — the one write in this file.
 *
 * POST rather than a parameter on the reading GET, for a boring but fatal
 * reason: GET payloads here are cached for a minute, so a mark folded into the
 * read path would be served from cache and silently dropped. Marking also
 * invalidates the cached payloads that carry read state.
 */
router.post("/api/fantasy/reading/read", async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const ids = Array.isArray(body.ids)
    ? body.ids.filter((x): x is string => typeof x === "string" && /^[a-f0-9]{40}$/.test(x))
    : [];
  if (!ids.length) return res.status(400).json({ error: "no ids" });
  try {
    const value = await runFf("reading-read", { ids: ids.slice(0, 200).join(",") });
    for (const k of [...cache.keys()]) if (k.startsWith("reading?")) cache.delete(k);
    sendJson(req, res, value);
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});
router.get("/api/fantasy/consensus", (req, res) => serve("consensus", req, res));
router.get("/api/fantasy/dossier", (req, res) => serve("dossier", req, res));
router.get("/api/fantasy/news-index", (req, res) => serve("news-index", req, res));

export default router;
