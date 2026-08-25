import { Router, Request, Response } from "express";
import { execFile } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import db from "../db.js";

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

// Endpoint -> cache TTL. The waiver board rebuilds the whole price table from six
// seasons of sealed bids and takes a few seconds; news is cheap but changes often.
const TTL_MS: Record<string, number> = {
  overview: 60_000,
  waivers: 300_000,
  trades: 300_000,
  assets: 600_000,
  news: 60_000,
  alerts: 30_000,
  now: 60_000,
  "trade-eval": 0, // never cached — it is a function of the user's own input
  // A full-league package search is seconds of CPU; the result only moves when
  // rosters or projections do, which is once a day.
  "trade-generate": 600_000,
};

type CacheEntry = { at: number; value: unknown };
const cache = new Map<string, CacheEntry>();

function ffAvailable(): boolean {
  return fs.existsSync(path.join(FF_ROOT, "ff", "cli.py"));
}

function runFf(endpoint: string, params: Record<string, string>): Promise<unknown> {
  const args = ["-m", "ff.cli", "api", endpoint];
  for (const [k, v] of Object.entries(params)) args.push(`${k}=${v}`);
  return new Promise((resolve, reject) => {
    execFile(
      PYTHON,
      args,
      { cwd: FF_ROOT, timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER },
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
  "topic",
  "only_mine",
  "scope",
  "side",
  "q",
  "give",
  "get",
  "pin_mine",
  "pin_theirs",
  "counterparty",
]);

function collectParams(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.query)) {
    if (!ALLOWED_PARAMS.has(k) || typeof v !== "string") continue;
    // Params are passed as argv, not through a shell, so there is no quoting
    // hazard — but keep them to a conservative character set anyway.
    if (!/^[A-Za-z0-9_,.\- ]{0,300}$/.test(v)) continue;
    out[k] = v;
  }
  return out;
}

async function serve(endpoint: string, req: Request, res: Response) {
  if (!ffAvailable()) {
    return res.status(503).json({
      error: "fantasy-football-agent not found",
      detail: `Looked in ${FF_ROOT}. Set FF_ROOT if the repo lives elsewhere.`,
    });
  }
  const params = collectParams(req);
  const key = `${endpoint}?${new URLSearchParams(params).toString()}`;
  const ttl = TTL_MS[endpoint] ?? 60_000;
  const hit = cache.get(key);
  const fresh = hit && Date.now() - hit.at < ttl;

  if (fresh && req.query.refresh !== "1") {
    return res.json({ ...(hit!.value as object), _cached_at: new Date(hit!.at).toISOString() });
  }
  try {
    const value = await runFf(endpoint, params);
    if (ttl > 0) cache.set(key, { at: Date.now(), value });
    res.json(value);
  } catch (e) {
    // Serve stale data rather than nothing — a waiver board from ten minutes ago
    // is far more useful at 11pm on a Tuesday than an error page.
    if (hit) {
      return res.json({
        ...(hit.value as object),
        _stale: true,
        _error: (e as Error).message,
        _cached_at: new Date(hit.at).toISOString(),
      });
    }
    res.status(500).json({ error: (e as Error).message });
  }
}

const router = Router();

router.get("/api/fantasy/overview", (req, res) => serve("overview", req, res));
router.get("/api/fantasy/waivers", (req, res) => serve("waivers", req, res));
router.get("/api/fantasy/trades", (req, res) => serve("trades", req, res));
router.get("/api/fantasy/trade-eval", (req, res) => serve("trade-eval", req, res));
router.get("/api/fantasy/assets", (req, res) => serve("assets", req, res));
router.get("/api/fantasy/news", (req, res) => serve("news", req, res));
router.get("/api/fantasy/trade-generate", (req, res) => serve("trade-generate", req, res));
router.get("/api/fantasy/now", (req, res) => serve("now", req, res));

/**
 * Alerts. Two owners, deliberately kept apart:
 *   - the alert CONTENT and its delivery log live in ff.db, which is the only
 *     thing that knows what "Jeanty sprained ankle" means
 *   - the JOB that would deliver it lives in NanoClaw's scheduled_tasks, which
 *     is the only thing that knows whether anything is running
 * Merging them here rather than teaching either side about the other keeps one
 * source of truth for each, and lets the page say "the rule exists but nothing
 * runs it" — which is the true state today and the most useful thing it can say.
 */
router.get("/api/fantasy/alerts", async (req, res) => {
  const inner: Record<string, unknown> = await new Promise((resolve) => {
    const fake = { ...req, query: { ...req.query } } as Request;
    const capture = {
      json: (v: unknown) => resolve(v as Record<string, unknown>),
      status: () => capture,
    } as unknown as Response;
    serve("alerts", fake, capture);
  });

  let tasks: unknown[] = [];
  try {
    tasks = db
      .prepare(
        "SELECT id, name, group_folder, chat_jid, schedule_type, schedule_value, " +
          "status, next_run, last_run, last_result FROM scheduled_tasks " +
          "WHERE status <> 'completed' AND (" +
          "  lower(IFNULL(name,'')) LIKE '%fantasy%' OR lower(group_folder) LIKE '%fantasy%'" +
          "  OR lower(IFNULL(name,'')) LIKE '%waiver%' OR lower(prompt) LIKE '%ff.cli%')"
      )
      .all();
  } catch {
    tasks = [];
  }

  res.json({
    ...inner,
    schedule: {
      tasks,
      configured: tasks.length > 0,
      note:
        tasks.length > 0
          ? "Job health lives in Admin → Tasks; this is only the fantasy subset."
          : "No scheduled job runs these rules yet. The alerts below are evaluated " +
            "when you open this page, which means nothing reaches you unless you look.",
    },
  });
});

export default router;
