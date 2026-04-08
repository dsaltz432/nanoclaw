import { Router, Request, Response } from "express";
import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const nanoclawRoot = process.env.NANOCLAW_ROOT || path.resolve(__dirname, "../..");
const messagesDbPath = path.join(nanoclawRoot, "store/messages.db");
const ratesDbPath = path.join(
  nanoclawRoot,
  "data/sessions/finance/.claude/mortgage-rates.db",
);

// Hard-coded task ID for the weekly report's free-text summary, still pulled
// from task_run_logs. The rate history itself now comes from mortgage-rates.db.
const WEEKLY_TASK_ID = "task-1774321323925-cof6xm";
const TARGET_RATE = 5.8;

function openReadonly(p: string): Database.Database | null {
  if (!fs.existsSync(p)) return null;
  try {
    return new Database(p, { readonly: true });
  } catch {
    return null;
  }
}

const router = Router();

router.get("/api/mortgage", (_req: Request, res: Response) => {
  try {
    // Rate history: canonical source is mortgage-rates.db in the finance
    // group's per-group .claude/ directory. Populated by the daily tracker
    // task (task-1774321313812-tu4hfc) via INSERT OR REPLACE.
    const ratesDb = openReadonly(ratesDbPath);
    const rates: { date: string; rate: number }[] = [];
    if (ratesDb) {
      try {
        const rows = ratesDb
          .prepare(
            `SELECT date, rate_30yr FROM rates ORDER BY date ASC`,
          )
          .all() as { date: string; rate_30yr: number }[];
        for (const row of rows) {
          rates.push({ date: row.date, rate: row.rate_30yr });
        }
      } finally {
        ratesDb.close();
      }
    }

    // Weekly report summary: still lives in task_run_logs.result as free-text
    // output from the weekly task. Kept here unchanged so the dashboard can
    // render the latest narrative summary beneath the chart.
    let weekly_summary: string | null = null;
    let weekly_run_at: string | null = null;
    const messagesDb = openReadonly(messagesDbPath);
    if (messagesDb) {
      try {
        const weeklyRun = messagesDb
          .prepare(
            `SELECT run_at, result FROM task_run_logs
             WHERE task_id = ? AND status = 'success'
             ORDER BY run_at DESC LIMIT 1`,
          )
          .get(WEEKLY_TASK_ID) as
          | { run_at: string; result: string }
          | undefined;
        if (weeklyRun) {
          weekly_summary = weeklyRun.result ?? null;
          weekly_run_at = weeklyRun.run_at ?? null;
        }
      } finally {
        messagesDb.close();
      }
    }

    const current = rates.length > 0 ? rates[rates.length - 1].rate : null;
    const previous = rates.length > 1 ? rates[rates.length - 2].rate : null;

    res.json({
      rates,
      current,
      previous,
      target: TARGET_RATE,
      weekly_summary,
      weekly_run_at,
    });
  } catch (err) {
    console.error("Mortgage API error:", err);
    res.json({ rates: [], weekly_summary: null, target: TARGET_RATE });
  }
});

export default router;
