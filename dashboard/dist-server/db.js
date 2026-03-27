import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const nanoclawRoot = process.env.NANOCLAW_ROOT || path.resolve(__dirname, "..");
const dbPath = path.join(nanoclawRoot, "store", "messages.db");
const db = new Database(dbPath, { readonly: true });
export default db;
export function getTasks() {
    return db.prepare("SELECT * FROM scheduled_tasks ORDER BY COALESCE(last_run, created_at) DESC").all();
}
export function getTaskRuns(taskId, limit = 50) {
    return db
        .prepare("SELECT * FROM task_run_logs WHERE task_id = ? ORDER BY run_at DESC LIMIT ?")
        .all(taskId, limit);
}
export function getGroups() {
    return db.prepare("SELECT * FROM registered_groups").all();
}
export function getSessions() {
    return db.prepare("SELECT * FROM sessions").all();
}
