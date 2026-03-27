import { Router, Request, Response } from "express";
import { getGroups, getSessions } from "../db.js";

const router = Router();

router.get("/api/groups", (_req: Request, res: Response) => {
  try {
    const groups = getGroups() as Record<string, unknown>[];
    const sessions = getSessions() as { group_folder: string; session_id: string }[];

    const sessionMap = new Map(
      sessions.map((s) => [s.group_folder, s.session_id])
    );

    const parsed = groups.map((group) => {
      if (typeof group.container_config === "string") {
        try {
          group.container_config = JSON.parse(group.container_config);
        } catch {
          // leave as string if not valid JSON
        }
      }
      group.session_id = sessionMap.get(group.folder as string) || null;
      group.is_main = group.is_main === 1;
      group.requires_trigger = group.requires_trigger === 1;
      return group;
    });

    res.json(parsed);
  } catch (err) {
    console.error("Failed to fetch groups:", err);
    res.status(500).json({ error: "Failed to fetch groups" });
  }
});

export default router;
