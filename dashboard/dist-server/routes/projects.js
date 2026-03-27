import { Router } from "express";
import { execFile } from "child_process";
import { promisify } from "util";
const execFileAsync = promisify(execFile);
const router = Router();
async function getProjectInfo(name, projectPath) {
    const project = {
        name,
        path: projectPath,
        branch: null,
        lastCommits: [],
        status: [],
        openPRs: [],
        ahead: 0,
        behind: 0,
        mainBranch: null,
    };
    try {
        const { stdout: branch } = await execFileAsync("git", ["branch", "--show-current"], { cwd: projectPath });
        project.branch = branch.trim();
    }
    catch {
        // git not available or not a repo
    }
    try {
        const { stdout: log } = await execFileAsync("git", ["log", "--oneline", "-10"], { cwd: projectPath });
        project.lastCommits = log.trim().split("\n").filter(Boolean);
    }
    catch {
        // ignore
    }
    try {
        const { stdout: status } = await execFileAsync("git", ["status", "--short"], { cwd: projectPath });
        project.status = status.trim().split("\n").filter(Boolean);
    }
    catch {
        // ignore
    }
    // Fetch latest remote refs before comparing
    try {
        await execFileAsync("git", ["fetch", "--quiet", "origin"], { cwd: projectPath, timeout: 10000 });
    }
    catch {
        // ignore fetch failures (offline, etc.)
    }
    // Check ahead/behind relative to main/master
    try {
        let mainBranch = "main";
        try {
            await execFileAsync("git", ["rev-parse", "--verify", "origin/main"], { cwd: projectPath });
        }
        catch {
            mainBranch = "master";
        }
        const { stdout: revList } = await execFileAsync("git", ["rev-list", "--left-right", "--count", `origin/${mainBranch}...HEAD`], { cwd: projectPath });
        const parts = revList.trim().split(/\s+/).map(Number);
        project.behind = parts[0] ?? 0;
        project.ahead = parts[1] ?? 0;
        project.mainBranch = mainBranch;
    }
    catch (err) {
        console.error("ahead/behind check failed:", err instanceof Error ? err.message : err);
    }
    try {
        const { stdout: prs } = await execFileAsync("gh", [
            "pr",
            "list",
            "--state",
            "open",
            "--json",
            "number,title,url,createdAt,headRefName",
            "--limit",
            "10",
        ], { cwd: projectPath });
        project.openPRs = JSON.parse(prs);
    }
    catch {
        // gh CLI not available
    }
    return project;
}
router.get("/api/projects", async (_req, res) => {
    try {
        const projects = await Promise.all([
            getProjectInfo("recipe-club", "/Users/danielsaltz/Documents/repositories/recipe-club"),
        ]);
        res.json(projects);
    }
    catch (err) {
        console.error("Failed to fetch projects:", err);
        res.status(500).json({ error: "Failed to fetch projects" });
    }
});
export default router;
