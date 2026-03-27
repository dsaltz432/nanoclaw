import { Router } from "express";
import { execFile } from "child_process";
import { promisify } from "util";
const execFileAsync = promisify(execFile);
const router = Router();
router.get("/api/containers", async (_req, res) => {
    try {
        const { stdout } = await execFileAsync("docker", [
            "ps",
            "--filter",
            "name=nanoclaw",
            "--format",
            "json",
        ]);
        const lines = stdout.trim().split("\n").filter(Boolean);
        const containers = lines.map((line) => {
            const raw = JSON.parse(line);
            return {
                id: raw.ID,
                name: raw.Names,
                image: raw.Image,
                status: raw.Status,
                created: raw.CreatedAt,
                ports: raw.Ports,
            };
        });
        res.json(containers);
    }
    catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        if (message.includes("ENOENT") ||
            message.includes("not found") ||
            message.includes("command not found")) {
            res.json({ error: "Docker is not available", containers: [] });
            return;
        }
        console.error("Failed to list containers:", err);
        res.status(500).json({ error: "Failed to list containers" });
    }
});
router.get("/api/containers/:name/logs", async (req, res) => {
    try {
        const name = req.params.name;
        // Validate container name to prevent injection
        if (!/^nanoclaw-[\w-]+$/.test(name)) {
            res.status(400).json({ error: "Invalid container name" });
            return;
        }
        const tail = parseInt(req.query.tail) || 200;
        const { stderr } = await execFileAsync("docker", [
            "logs",
            "--tail",
            String(tail),
            name,
        ], { maxBuffer: 1024 * 1024 * 5 });
        // agent-runner logs go to stderr
        res.json({ logs: stderr });
    }
    catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        if (message.includes("No such container")) {
            res.status(404).json({ error: "Container not found" });
            return;
        }
        console.error("Failed to fetch container logs:", err);
        res.status(500).json({ error: "Failed to fetch container logs" });
    }
});
export default router;
