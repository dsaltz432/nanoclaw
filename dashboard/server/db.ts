import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const nanoclawRoot = process.env.NANOCLAW_ROOT || path.resolve(__dirname, "..");
const dbPath = path.join(nanoclawRoot, "store", "messages.db");

const db = new Database(dbPath, { readonly: true });
const dbWrite = new Database(dbPath);

export default db;

export function getTasks() {
  return db.prepare("SELECT * FROM scheduled_tasks ORDER BY COALESCE(last_run, created_at) DESC").all();
}

export function setTaskStatus(taskId: string, status: "active" | "paused") {
  dbWrite.prepare("UPDATE scheduled_tasks SET status = ? WHERE id = ?").run(status, taskId);
}

export function getTaskRuns(taskId: string, limit = 50) {
  return db
    .prepare(
      "SELECT * FROM task_run_logs WHERE task_id = ? ORDER BY run_at DESC LIMIT ?"
    )
    .all(taskId, limit);
}

export function triggerTaskNow(taskId: string): string {
  const task = db.prepare("SELECT * FROM scheduled_tasks WHERE id = ?").get(taskId) as Record<string, unknown> | undefined;
  if (!task) throw new Error("Task not found");
  const newId = `${taskId}-manual-${Date.now()}`;
  dbWrite.prepare(`
    INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, next_run, status, created_at, context_mode, name)
    VALUES (?, ?, ?, ?, 'once', ?, ?, 'active', ?, ?, ?)
  `).run(
    newId,
    task.group_folder,
    task.chat_jid,
    task.prompt,
    new Date().toISOString(),
    new Date().toISOString(),
    new Date().toISOString(),
    task.context_mode,
    task.name ? `${task.name} (manual)` : null,
  );
  return newId;
}

export function getGroups() {
  return db.prepare("SELECT * FROM registered_groups").all();
}

export function getSessions() {
  return db.prepare("SELECT * FROM sessions").all();
}
