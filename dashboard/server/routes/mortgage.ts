import { Router, Request, Response } from "express";
import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const nanoclawRoot = process.env.NANOCLAW_ROOT || path.resolve(__dirname, "../..");
const dbPath = path.join(nanoclawRoot, "store/messages.db");

const DAILY_TASK_ID = "task-1774321313812-tu4hfc";
const WEEKLY_TASK_ID = "task-1774321323925-cof6xm";
const TARGET_RATE = 5.8;

function getDb(): Database.Database | null {
  if (!fs.existsSync(dbPath)) return null;
  try {
    return new Database(dbPath, { readonly: true });
  } catch {
    return null;
  }
}

function parseRate(text: string | null): number | null {
  if (!text) return null;
  // Match bold rate: **6.37%** or **6.37 %**
  const bold = text.match(/\*\*(\d+\.\d+)\s*%\*\*/);
  if (bold) return parseFloat(bold[1]);
  // Match plain: "6.37%" or "6.37 percent"
  const plain = text.match(/\b(\d+\.\d+)\s*%/);
  if (plain) {
    const n = parseFloat(plain[1]);
    // Sanity check: mortgage rates are 3–12%
    if (n >= 3 && n <= 12) return n;
  }
  return null;
}

function formatDate(isoStr: string): string {
  return isoStr.split("T")[0];
}

const router = Router();

router.get("/api/mortgage", (_req: Request, res: Response) => {
  try {
    const db = getDb();
    if (!db) return void res.json({ rates: [], weekly_summary: null, target: TARGET_RATE });

    // Daily rate history
    const dailyRuns = db.prepare(`
      SELECT run_at, result FROM task_run_logs
      WHERE task_id = ? AND status = 'success'
      ORDER BY run_at ASC
    `).all(DAILY_TASK_ID) as { run_at: string; result: string | null }[];

    const rates: { date: string; rate: number }[] = [];
    for (const run of dailyRuns) {
      const rate = parseRate(run.result);
      if (rate !== null) {
        rates.push({ date: formatDate(run.run_at), rate });
      }
    }

    // Latest weekly report
    const weeklyRun = db.prepare(`
      SELECT run_at, result FROM task_run_logs
      WHERE task_id = ? AND status = 'success'
      ORDER BY run_at DESC LIMIT 1
    `).get(WEEKLY_TASK_ID) as { run_at: string; result: string } | undefined;

    const current = rates.length > 0 ? rates[rates.length - 1].rate : null;
    const previous = rates.length > 1 ? rates[rates.length - 2].rate : null;

    res.json({
      rates,
      current,
      previous,
      target: TARGET_RATE,
      weekly_summary: weeklyRun?.result ?? null,
      weekly_run_at: weeklyRun?.run_at ?? null,
    });
  } catch (err) {
    console.error("Mortgage API error:", err);
    res.json({ rates: [], weekly_summary: null, target: TARGET_RATE });
  }
});

export default router;
