import { Router, Request, Response } from "express";
import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const nanoclawRoot =
  process.env.NANOCLAW_ROOT || path.resolve(__dirname, "../..");
const HOME = process.env.HOME || "";

const router = Router();

/**
 * Generic descriptors for the host launchd cronjobs surfaced in the dashboard.
 * Config-driven so new jobs (backup, email-metadata, etc.) slot in by adding a
 * row here — no per-job code. Paths mirror each plist's Standard{Out}Path:
 * most write under the repo's logs/, spotify-cleanup writes under ~/.local
 * (launchd can't open files in ~/Documents at spawn time — see the plist).
 */
interface JobDescriptor {
  key: string; // url-safe id used in the API path
  label: string; // human display name
  launchdLabel: string; // com.nanoclaw.<name>, for `launchctl list`
  schedule: string; // human-readable schedule
  logPath: string; // resolved stdout log path
  errorLogPath?: string; // resolved stderr log path
}

const repoLog = (name: string) => path.join(nanoclawRoot, "logs", name);
const homeLog = (name: string) =>
  path.join(HOME, ".local/share/nanoclaw/logs", name);

const JOBS: JobDescriptor[] = [
  {
    key: "spotify-cleanup",
    label: "Spotify Podcast Cleanup",
    launchdLabel: "com.nanoclaw.spotify-cleanup",
    schedule: "Daily 4:30 AM",
    logPath: homeLog("spotify-cleanup.log"),
    errorLogPath: homeLog("spotify-cleanup.error.log"),
  },
  {
    key: "backup",
    label: "Backup",
    launchdLabel: "com.nanoclaw.backup",
    schedule: "Daily 3:15 AM",
    // backup.sh writes its own dated log; the plist's stdout capture
    // (backup.out.log) has been empty since May and read as "108d ago".
    logPath: repoLog("backup.log"),
    errorLogPath: repoLog("backup.error.log"),
  },
  {
    key: "backup-verify",
    label: "Backup Verify (restore test)",
    launchdLabel: "com.nanoclaw.backup-verify",
    schedule: "Weekly, Sun 5:00 AM",
    logPath: repoLog("backup-verify.log"),
    errorLogPath: homeLog("backup-verify.error.log"),
  },
  {
    key: "email-metadata",
    label: "Email Metadata Extractor",
    launchdLabel: "com.nanoclaw.email-metadata",
    schedule: "Daily 8:00 AM",
    logPath: repoLog("email-metadata.log"),
    errorLogPath: repoLog("email-metadata.error.log"),
  },
  {
    key: "heartbeat",
    label: "Health Heartbeat",
    launchdLabel: "com.nanoclaw.heartbeat",
    schedule: "Every 5 min",
    // heartbeat.sh writes no log; its output is the health-probe snapshot.
    // jobs.txt is rewritten every run (mtime = last run) and its content —
    // per-job freshness — is the most useful thing to show as the "tail".
    logPath: path.join(nanoclawRoot, "data", "health-probe", "jobs.txt"),
    errorLogPath: repoLog("heartbeat.error.log"),
  },
  {
    key: "briefing-upload",
    label: "Sports Briefing Upload",
    launchdLabel: "com.nanoclaw.briefing-upload",
    schedule: "On new briefing",
    // the script's own log; the plist stdout capture (*.out.log) stays empty
    logPath: repoLog("briefing-upload.log"),
    errorLogPath: repoLog("briefing-upload.error.log"),
  },
  {
    key: "trip-briefing-upload",
    label: "Trip Briefing Upload",
    launchdLabel: "com.nanoclaw.trip-briefing-upload",
    schedule: "On new trip briefing",
    logPath: repoLog("trip-briefing-upload.log"),
    errorLogPath: repoLog("trip-briefing-upload.error.log"),
  },
  // Fantasy football host jobs (docs/fantasy-football.md "Scheduled jobs").
  // ff-news predates the ~/.local convention and logs under the repo; the
  // other three follow the ff-live plist pattern.
  {
    key: "ff-news",
    label: "Fantasy: news + articles",
    launchdLabel: "com.nanoclaw.ff-news",
    schedule: "Every 15 min",
    logPath: repoLog("ff-news.log"),
    errorLogPath: repoLog("ff-news.error.log"),
  },
  {
    key: "ff-claims",
    label: "Fantasy: claim extraction",
    launchdLabel: "com.nanoclaw.ff-claims",
    schedule: "Every 15 min",
    logPath: homeLog("ff-claims.log"),
    errorLogPath: homeLog("ff-claims.error.log"),
  },
  {
    key: "ff-live",
    label: "Fantasy: live refresh + rankings",
    launchdLabel: "com.nanoclaw.ff-live",
    schedule: "Every 2 h",
    logPath: homeLog("ff-live.log"),
    errorLogPath: homeLog("ff-live.error.log"),
  },
  {
    key: "ff-daily",
    label: "Fantasy: daily refresh",
    launchdLabel: "com.nanoclaw.ff-daily",
    schedule: "Daily 6:40 AM",
    logPath: homeLog("ff-daily.log"),
    errorLogPath: homeLog("ff-daily.error.log"),
  },
  {
    key: "people-call-sync",
    label: "People: call-log sync",
    launchdLabel: "com.nanoclaw.people-call-sync",
    schedule: "Daily 4:15 AM + 7:00 AM",
    // The script's own output: one line per backup ingested, plus one per
    // new call (person, time, length). Untracked numbers are only counted.
    logPath: homeLog("people-call-sync.log"),
    errorLogPath: homeLog("people-call-sync.error.log"),
  },
];

function findJob(key: string): JobDescriptor | undefined {
  return JOBS.find((j) => j.key === key);
}

/** Read the last `n` non-empty lines of a log file (files are small). */
function tailLines(filePath: string, n: number): string[] {
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, "utf-8");
  const lines = content.split("\n").filter((l) => l.trim().length > 0);
  return lines.slice(-n);
}

/**
 * Query launchd for the live last-exit status and whether the job is currently
 * running. `launchctl list <label>` prints a plist-ish dict; we scrape the two
 * fields we care about. Returns nulls when the job isn't loaded.
 */
async function launchdStatus(
  label: string
): Promise<{ exitCode: number | null; running: boolean; loaded: boolean }> {
  try {
    const { stdout } = await execFileAsync("launchctl", ["list", label]);
    const exitMatch = stdout.match(/"LastExitStatus"\s*=\s*(-?\d+);/);
    const pidMatch = stdout.match(/"PID"\s*=\s*(\d+);/);
    return {
      exitCode: exitMatch ? parseInt(exitMatch[1], 10) : null,
      running: pidMatch !== null,
      loaded: true,
    };
  } catch {
    // Non-zero exit => label not loaded in this launchd domain.
    return { exitCode: null, running: false, loaded: false };
  }
}

function deriveStatus(s: {
  exitCode: number | null;
  running: boolean;
  loaded: boolean;
}): string {
  if (!s.loaded) return "not loaded";
  if (s.running) return "running";
  if (s.exitCode === 0) return "success";
  if (s.exitCode !== null) return "error";
  return "unknown";
}

router.get("/api/scheduled-tasks", async (_req: Request, res: Response) => {
  try {
    const jobs = await Promise.all(
      JOBS.map(async (job) => {
        const status = await launchdStatus(job.launchdLabel);
        let lastRun: string | null = null;
        let hasErrorLog = false;
        try {
          if (fs.existsSync(job.logPath)) {
            lastRun = fs.statSync(job.logPath).mtime.toISOString();
          }
        } catch {
          /* ignore stat failures */
        }
        try {
          if (job.errorLogPath && fs.existsSync(job.errorLogPath)) {
            hasErrorLog = fs.statSync(job.errorLogPath).size > 0;
          }
        } catch {
          /* ignore */
        }
        return {
          key: job.key,
          label: job.label,
          launchdLabel: job.launchdLabel,
          schedule: job.schedule,
          lastRun,
          exitCode: status.exitCode,
          running: status.running,
          loaded: status.loaded,
          status: deriveStatus(status),
          hasErrorLog,
          recentLines: tailLines(job.logPath, 12),
        };
      })
    );
    res.json(jobs);
  } catch (err) {
    console.error("Failed to list scheduled tasks:", err);
    res.status(500).json({ error: "Failed to list scheduled tasks" });
  }
});

router.get(
  "/api/scheduled-tasks/:key/log",
  (req: Request, res: Response) => {
    const job = findJob(req.params.key as string);
    if (!job) {
      res.status(404).json({ error: "Unknown job" });
      return;
    }
    const tail = Math.min(parseInt(req.query.tail as string) || 200, 2000);
    const stream = (req.query.stream as string) === "error";
    const filePath = stream ? job.errorLogPath : job.logPath;
    if (!filePath || !fs.existsSync(filePath)) {
      res.json({ logs: "" });
      return;
    }
    try {
      const lines = tailLines(filePath, tail);
      res.json({ logs: lines.join("\n") });
    } catch (err) {
      console.error("Failed to read job log:", err);
      res.status(500).json({ error: "Failed to read job log" });
    }
  }
);

export default router;
