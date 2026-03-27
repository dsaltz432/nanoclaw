import { Router } from "express";
import fs from "fs";
import path from "path";
import { getTasks, getTaskRuns } from "../db.js";
const router = Router();
const nanoclawRoot = process.env.NANOCLAW_ROOT || path.resolve(import.meta.dirname, "..");
function findLogForRun(groupFolder, runAt) {
    const logsDir = path.join(nanoclawRoot, "groups", groupFolder, "logs");
    try {
        const files = fs.readdirSync(logsDir).filter((f) => f.startsWith("container-") && f.endsWith(".log"));
        const runTime = new Date(runAt).getTime();
        let bestFile = null;
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
    }
    catch {
        return null;
    }
}
function readLogFile(groupFolder, filename) {
    try {
        const filePath = path.join(nanoclawRoot, "groups", groupFolder, "logs", filename);
        return fs.readFileSync(filePath, "utf-8");
    }
    catch {
        return null;
    }
}
router.get("/api/tasks", (_req, res) => {
    try {
        const tasks = getTasks();
        const parsed = tasks.map((task) => {
            if (typeof task.container_config === "string") {
                try {
                    task.container_config = JSON.parse(task.container_config);
                }
                catch {
                    // leave as string if not valid JSON
                }
            }
            return task;
        });
        res.json(parsed);
    }
    catch (err) {
        console.error("Failed to fetch tasks:", err);
        res.status(500).json({ error: "Failed to fetch tasks" });
    }
});
router.get("/api/tasks/:id/runs", (req, res) => {
    try {
        const id = req.params.id;
        const limit = parseInt(req.query.limit) || 50;
        const runs = getTaskRuns(id, limit);
        // Find the group_folder for this task
        const tasks = getTasks();
        const task = tasks.find((t) => t.id === id);
        const groupFolder = task?.group_folder;
        const enriched = runs.map((run) => {
            if (groupFolder && run.run_at) {
                const logFile = findLogForRun(groupFolder, run.run_at);
                if (logFile) {
                    run.log_file = logFile;
                    run.log_content = readLogFile(groupFolder, logFile);
                }
            }
            return run;
        });
        res.json(enriched);
    }
    catch (err) {
        console.error("Failed to fetch task runs:", err);
        res.status(500).json({ error: "Failed to fetch task runs" });
    }
});
export default router;
