import { Router } from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const nanoclawRoot = process.env.NANOCLAW_ROOT || path.resolve(__dirname, "../..");
const router = Router();
function readJsonSafe(filePath, fallback) {
    if (!fs.existsSync(filePath))
        return fallback;
    try {
        return JSON.parse(fs.readFileSync(filePath, "utf-8"));
    }
    catch {
        return fallback;
    }
}
router.get("/api/email-unsubscribe", (_req, res) => {
    try {
        // Read history from both possible locations
        const historyPaths = [
            path.join(nanoclawRoot, "groups", "telegram_main", "unsubscribe-history.json"),
            path.join(nanoclawRoot, "groups", "main", "unsubscribe-history.json"),
        ];
        let allHistory = [];
        for (const p of historyPaths) {
            const data = readJsonSafe(p, { history: [] });
            allHistory = allHistory.concat(data.history);
        }
        // Sort newest first
        allHistory.sort((a, b) => b.date.localeCompare(a.date));
        // Read latest scan metadata
        const metadataPath = path.join(nanoclawRoot, "data", "email-unsubscribe", "sanitized_metadata.json");
        const metadata = readJsonSafe(metadataPath, {
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
        const byDate = new Map();
        for (const entry of allHistory) {
            const existing = byDate.get(entry.date) || { success: 0, failed: 0 };
            if (entry.result === "success")
                existing.success++;
            else
                existing.failed++;
            byDate.set(entry.date, existing);
        }
        const timeline = [...byDate.entries()]
            .map(([date, counts]) => ({ date, ...counts }))
            .sort((a, b) => a.date.localeCompare(b.date));
        // Unique senders unsubscribed
        const unsubscribedSenders = new Set(allHistory
            .filter((h) => h.result === "success")
            .map((h) => h.senderEmail));
        // Top domains from history
        const domainCounts = new Map();
        for (const entry of allHistory.filter((h) => h.result === "success")) {
            try {
                const domain = new URL(entry.url).hostname;
                domainCounts.set(domain, (domainCounts.get(domain) || 0) + 1);
            }
            catch {
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
    }
    catch (err) {
        console.error("Email unsubscribe API error:", err);
        res.json({
            stats: { totalAttempts: 0, successful: 0, failed: 0, successRate: 0, uniqueSendersUnsubscribed: 0 },
            timeline: [],
            history: [],
            topDomains: [],
            lastScan: { date: "", scannedAt: "", totalMessages: 0, candidateCount: 0 },
            pendingCandidates: [],
        });
    }
});
export default router;
