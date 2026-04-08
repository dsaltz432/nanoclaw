import { Router, Request, Response } from "express";
import fs from "fs";
import path from "path";
import { getTasks, getTaskRuns, setTaskStatus } from "../db.js";

const router = Router();
const nanoclawRoot = process.env.NANOCLAW_ROOT || path.resolve(import.meta.dirname, "..");

function findLogForRun(groupFolder: string, runAt: string): string | null {
  const logsDir = path.join(nanoclawRoot, "groups", groupFolder, "logs");
  try {
    const files = fs.readdirSync(logsDir).filter((f) => f.startsWith("container-") && f.endsWith(".log"));
    const runTime = new Date(runAt).getTime();
    let bestFile: string | null = null;
    let bestDiff = Infinity;
    for (const file of files) {
      // container-2026-03-27T09-01-32-306Z.log -> 2026-03-27T09:01:32.306Z
      const ts = file.replace("container-", "").replace(".log", "").replace(/-(\d{2})-(\d{2})-(\d{3})Z/, ":$1:$2.$3Z").replace(/T(\d{2})-/, "T$1:");
      const fileTime = new Date(ts).getTime();
      const diff = Math.abs(fileTime - runTime);
      if (diff < bestDiff && diff < 120000) { // within 2 minutes
        bestDiff = diff;
        bestFile = file;
      }
    }
    return bestFile;
  } catch {
    return null;
  }
}

function readLogFile(groupFolder: string, filename: string): string | null {
  try {
    const filePath = path.join(nanoclawRoot, "groups", groupFolder, "logs", filename);
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

router.get("/api/tasks", (_req: Request, res: Response) => {
  try {
    const tasks = getTasks() as Record<string, unknown>[];
    const parsed = tasks.map((task) => {
      if (typeof task.container_config === "string") {
        try {
          task.container_config = JSON.parse(task.container_config);
        } catch {
          // leave as string if not valid JSON
        }
      }
      return task;
    });
    res.json(parsed);
  } catch (err) {
    console.error("Failed to fetch tasks:", err);
    res.status(500).json({ error: "Failed to fetch tasks" });
  }
});

router.get("/api/tasks/:id/runs", (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const limit = parseInt(req.query.limit as string) || 50;
    const runs = getTaskRuns(id, limit) as Record<string, unknown>[];

    // Find the group_folder for this task
    const tasks = getTasks() as Record<string, unknown>[];
    const task = tasks.find((t) => t.id === id);
    const groupFolder = task?.group_folder as string | undefined;

    const enriched = runs.map((run) => {
      if (groupFolder && run.run_at) {
        const logFile = findLogForRun(groupFolder, run.run_at as string);
        if (logFile) {
          run.log_file = logFile;
          run.log_content = readLogFile(groupFolder, logFile);
        }
      }
      return run;
    });

    res.json(enriched);
  } catch (err) {
    console.error("Failed to fetch task runs:", err);
    res.status(500).json({ error: "Failed to fetch task runs" });
  }
});

router.patch("/api/tasks/:id/status", (req: Request, res: Response) => {
  try {
    const { status } = req.body as { status: string };
    if (status !== "active" && status !== "paused") {
      res.status(400).json({ error: "status must be 'active' or 'paused'" });
      return;
    }
    setTaskStatus(req.params.id as string, status);
    res.json({ ok: true, status });
  } catch (err) {
    console.error("Failed to update task status:", err);
    res.status(500).json({ error: "Failed to update task status" });
  }
});

export default router;
