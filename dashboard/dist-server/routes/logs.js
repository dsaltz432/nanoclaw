import { Router } from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const nanoclawRoot = process.env.NANOCLAW_ROOT || path.resolve(__dirname, "../..");
const router = Router();
function getLogsDir(groupFolder) {
    return path.join(nanoclawRoot, "groups", groupFolder, "logs");
}
router.get("/api/logs/:groupFolder", (req, res) => {
    try {
        const groupFolder = req.params.groupFolder;
        // Prevent path traversal
        if (groupFolder.includes("..") || groupFolder.includes("/")) {
            res.status(400).json({ error: "Invalid group folder name" });
            return;
        }
        const logsDir = getLogsDir(groupFolder);
        if (!fs.existsSync(logsDir)) {
            res.json([]);
            return;
        }
        const files = fs.readdirSync(logsDir);
        const logFiles = files
            .map((filename) => {
            const filePath = path.join(logsDir, filename);
            const stat = fs.statSync(filePath);
            return {
                filename,
                timestamp: stat.mtime.toISOString(),
                size: stat.size,
            };
        })
            .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
        res.json(logFiles);
    }
    catch (err) {
        console.error("Failed to list logs:", err);
        res.status(500).json({ error: "Failed to list logs" });
    }
});
router.get("/api/logs/:groupFolder/:filename", (req, res) => {
    try {
        const groupFolder = req.params.groupFolder;
        const filename = req.params.filename;
        // Prevent path traversal
        if (groupFolder.includes("..") ||
            groupFolder.includes("/") ||
            filename.includes("..") ||
            filename.includes("/")) {
            res.status(400).json({ error: "Invalid path" });
            return;
        }
        const filePath = path.join(getLogsDir(groupFolder), filename);
        if (!fs.existsSync(filePath)) {
            res.status(404).json({ error: "Log file not found" });
            return;
        }
        const content = fs.readFileSync(filePath, "utf-8");
        res.type("text/plain").send(content);
    }
    catch (err) {
        console.error("Failed to read log file:", err);
        res.status(500).json({ error: "Failed to read log file" });
    }
});
export default router;
