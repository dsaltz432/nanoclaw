import { Router, Request, Response } from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const nanoclawRoot =
  process.env.NANOCLAW_ROOT || path.resolve(__dirname, "../..");

const router = Router();

interface HistoryEntry {
  unsubscribedAt?: string;
  date?: string; // legacy
  senderName: string;
  senderEmail: string;
  result: string;
  url?: string;
  method?: string;
  lastSeen?: string | null;
}

interface Candidate {
  senderName: string;
  senderEmail: string;
  subject: string;
  frequency: number;
  hasUnsubscribeHeader: boolean;
  unsubscribeUrl: string | null;
  hasOneClickUnsubscribe: boolean;
  labelIds: string[];
}

function readJsonSafe<T>(filePath: string, fallback: T): T {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return fallback;
  }
}

router.get("/api/email-unsubscribe", (_req: Request, res: Response) => {
  try {
    // Read history from both possible locations
    const historyPaths = [
      path.join(nanoclawRoot, "groups", "email", "unsubscribe-history.json"),
    ];

    let allHistory: HistoryEntry[] = [];
    for (const p of historyPaths) {
      const data = readJsonSafe<{ history: HistoryEntry[] }>(p, { history: [] });
      allHistory = allHistory.concat(data.history);
    }

    // Sort newest first (support both unsubscribedAt and legacy date)
    allHistory.sort((a, b) => {
      const aDate = a.unsubscribedAt || a.date || "";
      const bDate = b.unsubscribedAt || b.date || "";
      return bDate.localeCompare(aDate);
    });

    // Read latest scan metadata
    const metadataPath = path.join(
      nanoclawRoot,
      "data",
      "email-unsubscribe",
      "sanitized_metadata.json",
    );
    const metadata = readJsonSafe<{
      scanDate: string;
      scannedAt: string;
      totalMessagesScanned: number;
      candidates: Candidate[];
    }>(metadataPath, {
      scanDate: "",
      scannedAt: "",
      totalMessagesScanned: 0,
      candidates: [],
    });

    // Compute stats
    const totalAttempts = allHistory.length;
    const successful = allHistory.filter((h) => h.result === "success").length;
    const failed = allHistory.filter((h) => h.result === "failed").length;

    // Group by date for the timeline chart
    const byDate = new Map<string, { success: number; failed: number }>();
    for (const entry of allHistory) {
      const dateKey = (entry.unsubscribedAt || entry.date || "").split("T")[0];
      if (!dateKey) continue;
      const existing = byDate.get(dateKey) || { success: 0, failed: 0 };
      if (entry.result === "success") existing.success++;
      else existing.failed++;
      byDate.set(dateKey, existing);
    }

    const timeline = [...byDate.entries()]
      .map(([date, counts]) => ({ date, ...counts }))
      .sort((a, b) => a.date.localeCompare(b.date));

    // Unique senders unsubscribed
    const unsubscribedSenders = new Set(
      allHistory
        .filter((h) => h.result === "success")
        .map((h) => h.senderEmail),
    );

    // Senders still emailing after unsubscribe (3-day grace period)
    const GRACE_PERIOD_MS = 3 * 24 * 60 * 60 * 1000;
    const now = Date.now();
    const stillEmailing = allHistory
      .filter((h) => {
        if (h.result !== "success" || !h.lastSeen) return false;
        const unsubTime = new Date(h.unsubscribedAt || h.date || "").getTime();
        return now - unsubTime >= GRACE_PERIOD_MS;
      })
      .map((h) => ({
        senderName: h.senderName,
        senderEmail: h.senderEmail,
        unsubscribedAt: h.unsubscribedAt || h.date,
        lastSeen: h.lastSeen,
      }));

    // Top domains from history
    const domainCounts = new Map<string, number>();
    for (const entry of allHistory.filter((h) => h.result === "success")) {
      if (!entry.url) continue;
      try {
        const domain = new URL(entry.url).hostname;
        domainCounts.set(domain, (domainCounts.get(domain) || 0) + 1);
      } catch {
        // skip malformed URLs
      }
    }
    const topDomains = [...domainCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([domain, count]) => ({ domain, count }));

    res.json({
      stats: {
        totalAttempts,
        successful,
        failed,
        successRate: totalAttempts > 0 ? Math.round((successful / totalAttempts) * 100) : 0,
        uniqueSendersUnsubscribed: unsubscribedSenders.size,
      },
      timeline,
      history: allHistory,
      topDomains,
      stillEmailing,
      lastScan: {
        date: metadata.scanDate,
        scannedAt: metadata.scannedAt,
        totalMessages: metadata.totalMessagesScanned,
        candidateCount: metadata.candidates.length,
      },
      pendingCandidates: metadata.candidates.slice(0, 15).map((c) => ({
        senderName: c.senderName,
        senderEmail: c.senderEmail,
        subject: c.subject,
        frequency: c.frequency,
        hasUnsubscribeHeader: c.hasUnsubscribeHeader,
        hasOneClickUnsubscribe: c.hasOneClickUnsubscribe,
      })),
    });
  } catch (err) {
    console.error("Email unsubscribe API error:", err);
    res.json({
      stats: { totalAttempts: 0, successful: 0, failed: 0, successRate: 0, uniqueSendersUnsubscribed: 0 },
      timeline: [],
      history: [],
      topDomains: [],
      stillEmailing: [],
      lastScan: { date: "", scannedAt: "", totalMessages: 0, candidateCount: 0 },
      pendingCandidates: [],
    });
  }
});

export default router;
