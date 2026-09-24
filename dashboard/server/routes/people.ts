/**
 * People — close contacts and when you last actually spoke.
 *
 * Backed by data/sessions/people/.claude/contacts.db, which belongs to the
 * `people` group, not to NanoClaw: this route reads and writes a domain DB the
 * same way the Strava route works on strava.db.
 *
 * There is no config file. contacts.db is the only store, and this route is
 * what creates it — the People page is where people are added, edited and
 * removed. The agent (scripts/people-log.py) and the nightly sheet sync only
 * ever append interactions; they never invent a person.
 *
 * The schema here mirrors scripts/people_common.py's SCHEMA, and the
 * qualifying/overdue logic mirrors its `qualifies` / `person_status`. Both are
 * CREATE TABLE IF NOT EXISTS, so whichever side runs first wins harmlessly —
 * but if you change one, change the other.
 */
import { Router, Request, Response } from "express";
import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import { execFile } from "child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const nanoclawRoot =
  process.env.NANOCLAW_ROOT || path.resolve(__dirname, "../..");
const dbPath =
  process.env.PEOPLE_DB ||
  path.join(nanoclawRoot, "data/sessions/people/.claude/contacts.db");

const STRIP_DAYS = 90;
const DUE_SOON_DAYS = 3;
/**
 * Sources anything may write. 'whatsapp_message' is retired — WhatsApp messages
 * are out of scope — and stays in the schema's CHECK lists only so the table
 * needn't be rebuilt. Mirrors people_common.SOURCES.
 */
const SOURCES = ["phone", "whatsapp", "in_person", "manual"];
const DIRECTIONS = ["in", "out", "n/a"];
const IDENTIFIER_KINDS = ["phone_number", "whatsapp_name"];
/** Numbers with no country code are assumed to be here. Matches people_common.py. */
const DEFAULT_COUNTRY_CODE = process.env.PEOPLE_COUNTRY_CODE || "1";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS people (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT NOT NULL UNIQUE,
  threshold_days INTEGER NOT NULL,
  notes          TEXT,
  sort_order     INTEGER
);
CREATE TABLE IF NOT EXISTS identifiers (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  kind      TEXT NOT NULL CHECK (kind IN ('phone_number','whatsapp_name')),
  value     TEXT NOT NULL,
  UNIQUE (kind, value)
);
CREATE TABLE IF NOT EXISTS rules (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id      INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  source         TEXT NOT NULL CHECK (
                   source IN ('phone','whatsapp','whatsapp_message','in_person','manual')),
  min_duration_s INTEGER,
  UNIQUE (person_id, source)
);
CREATE TABLE IF NOT EXISTS interactions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id  INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  ts         TEXT NOT NULL,
  source     TEXT NOT NULL CHECK (
               source IN ('phone','whatsapp','whatsapp_message','in_person','manual')),
  direction  TEXT NOT NULL CHECK (direction IN ('in','out','n/a')),
  duration_s INTEGER,
  note       TEXT,
  origin     TEXT NOT NULL CHECK (origin IN ('sheet','telegram','dashboard','backfill')),
  origin_ref TEXT UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_interactions_person_ts
  ON interactions(person_id, ts DESC);
CREATE TABLE IF NOT EXISTS mutes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id  INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  until      TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mutes_person ON mutes(person_id, until DESC);
CREATE TABLE IF NOT EXISTS nudges (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  run_date  TEXT NOT NULL,
  streak    INTEGER NOT NULL,
  UNIQUE (person_id, run_date)
);
`;

interface PersonRow {
  id: number;
  name: string;
  threshold_days: number;
  notes: string | null;
}

interface InteractionRow {
  id: number;
  person_id: number;
  ts: string;
  source: string;
  direction: string;
  duration_s: number | null;
  note: string | null;
  origin: string;
  origin_ref: string | null;
}

interface IdentifierInput {
  kind: string;
  value: string;
}

/**
 * Bring an older contacts.db up to SCHEMA. Mirrors people_common.migrate.
 * Needs a writable handle, so the read path calls it once per process.
 */
function migrate(db: Database.Database) {
  const cols = (db.prepare("PRAGMA table_info(people)").all() as { name: string }[]).map(
    (c) => c.name
  );
  if (!cols.length) return;
  if (!cols.includes("sort_order")) {
    db.exec("ALTER TABLE people ADD COLUMN sort_order INTEGER");
  }
  // Anyone without a position goes after everyone placed, alphabetically — so
  // the order is always total and a new person lands at the bottom. Row by row
  // on purpose: a single UPDATE would read its own half-done writes. Mirrors
  // people_common.migrate.
  const { top } = db.prepare("SELECT COALESCE(MAX(sort_order), -1) AS top FROM people").get() as {
    top: number;
  };
  const unplaced = db
    .prepare("SELECT id FROM people WHERE sort_order IS NULL ORDER BY name COLLATE NOCASE, id")
    .all() as { id: number }[];
  const place = db.prepare("UPDATE people SET sort_order = ? WHERE id = ?");
  unplaced.forEach((r, i) => place.run(top + 1 + i, r.id));
}

let migrated = false;

/** Read-only handle, or null when nothing has ever been written. */
function openDb(): Database.Database | null {
  if (!fs.existsSync(dbPath)) return null;
  if (!migrated) {
    const w = new Database(dbPath);
    try {
      migrate(w);
      migrated = true;
    } finally {
      w.close();
    }
  }
  try {
    return new Database(dbPath, { readonly: true });
  } catch {
    return null;
  }
}

/** Writable handle. Creates the file and the schema on first use. */
function openDbWrite(): Database.Database {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

// ── Dates ─────────────────────────────────────────────────────────────────────
// Timestamps are stored as local naive ISO ("2026-09-21T18:30:00"), so `new
// Date(ts)` parses them in the server's zone, which is the zone they were
// written in. Day arithmetic is done on YYYY-MM-DD to stay DST-proof.

function dayOf(ts: string): string {
  return ts.slice(0, 10);
}

function todayStr(): string {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 10);
}

function nowStamp(): string {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 19);
}

function daysBetween(fromDay: string, toDay: string): number {
  const a = Date.parse(fromDay + "T00:00:00Z");
  const b = Date.parse(toDay + "T00:00:00Z");
  return Math.round((b - a) / 86_400_000);
}

function shiftDay(day: string, delta: number): string {
  return new Date(Date.parse(day + "T00:00:00Z") + delta * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

// ── Phone numbers ─────────────────────────────────────────────────────────────

/** Best-effort E.164. Mirrors people_common.normalize_phone. */
function normalizePhone(raw: string): string | null {
  const text = (raw ?? "").trim();
  if (!text) return null;
  if (["unknown", "private", "restricted", "blocked", "-1", "-2"].includes(text.toLowerCase())) {
    return null;
  }
  const plus = text.startsWith("+");
  const digits = text.replace(/\D/g, "");
  if (!digits) return null;
  if (plus) return "+" + digits;
  if (digits.startsWith("00")) return "+" + digits.slice(2);
  if (digits.startsWith("011") && digits.length > 11) return "+" + digits.slice(3);
  if (digits.length === 10) return "+" + DEFAULT_COUNTRY_CODE + digits;
  if (digits.length === 11 && digits.startsWith(DEFAULT_COUNTRY_CODE)) return "+" + digits;
  return "+" + digits;
}

// ── Rules ─────────────────────────────────────────────────────────────────────

type Rules = Map<string, number | null>;

function rulesByPerson(db: Database.Database): Map<number, Rules> {
  const out = new Map<number, Rules>();
  const rows = db
    .prepare("SELECT person_id, source, min_duration_s FROM rules")
    .all() as { person_id: number; source: string; min_duration_s: number | null }[];
  for (const r of rows) {
    if (!out.has(r.person_id)) out.set(r.person_id, new Map());
    out.get(r.person_id)!.set(r.source, r.min_duration_s);
  }
  return out;
}

/**
 * Display only: calls shorter than this are left off the page (strip, history,
 * counts) — pocket dials, voicemail pickups, "call you back". They are still
 * stored, and still go through the rules like everything else; a short call
 * that *does* count (a rule minimum under a minute) is always shown, so the
 * page never hides the thing that reset the clock.
 */
const MIN_SHOWN_S = 60;

function shown(rules: Rules | undefined, source: string, durationS: number | null): boolean {
  return durationS === null || durationS >= MIN_SHOWN_S || qualifies(rules, source, durationS);
}

/** Mirrors people_common.qualifies. No rule for the source = never counts. */
function qualifies(rules: Rules | undefined, source: string, durationS: number | null): boolean {
  if (!rules || !rules.has(source)) return false;
  const min = rules.get(source) ?? null;
  if (min === null || min <= 0) return true;
  return durationS !== null && durationS >= min;
}

function activeMute(db: Database.Database, personId: number): string | null {
  const row = db
    .prepare(
      "SELECT until FROM mutes WHERE person_id = ? AND until > ? ORDER BY until DESC LIMIT 1"
    )
    .get(personId, nowStamp()) as { until: string } | undefined;
  return row?.until ?? null;
}

// ── Validation ────────────────────────────────────────────────────────────────

class BadRequest extends Error {}

function cleanName(value: unknown): string {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name) throw new BadRequest("name is required");
  if (name.length > 80) throw new BadRequest("name is too long");
  return name;
}

function cleanThreshold(value: unknown): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0 || n > 3650) {
    throw new BadRequest("threshold_days must be a whole number of days between 1 and 3650");
  }
  return n;
}

/**
 * Identifiers arrive as [{kind, value}]. Phone numbers are normalised here so
 * the DB only ever holds E.164 — that is what captured rows are matched
 * against, and matching a raw "212-555-0143" would silently never fire.
 */
function cleanIdentifiers(value: unknown): IdentifierInput[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new BadRequest("identifiers must be a list");
  const out: IdentifierInput[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    const kind = String(raw?.kind ?? "");
    const text = String(raw?.value ?? "").trim();
    if (!text) continue;
    if (!IDENTIFIER_KINDS.includes(kind)) {
      throw new BadRequest(`identifier kind must be one of ${IDENTIFIER_KINDS.join(", ")}`);
    }
    let finalValue = text;
    if (kind === "phone_number") {
      const normalized = normalizePhone(text);
      if (!normalized) throw new BadRequest(`cannot read a phone number from "${text}"`);
      finalValue = normalized;
    }
    const key = `${kind}:${finalValue.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind, value: finalValue });
  }
  return out;
}

/** Rules arrive as {source: minimumSeconds | null}. */
function cleanRules(value: unknown): [string, number | null][] {
  if (value === undefined || value === null) return [];
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new BadRequest("rules must be an object of source → minimum seconds");
  }
  const out: [string, number | null][] = [];
  for (const [source, min] of Object.entries(value as Record<string, unknown>)) {
    if (!SOURCES.includes(source)) {
      throw new BadRequest(`rule source must be one of ${SOURCES.join(", ")}`);
    }
    if (min === null || min === undefined || min === "" || min === true) {
      out.push([source, null]);
      continue;
    }
    const n = Number(min);
    if (!Number.isFinite(n) || n < 0 || n > 86_400) {
      throw new BadRequest(`rule "${source}" must be a number of seconds, or null for no minimum`);
    }
    out.push([source, n > 0 ? Math.round(n) : null]);
  }
  if (out.length === 0) {
    throw new BadRequest("pick at least one thing that counts as an interaction");
  }
  return out;
}

/**
 * Names are matched case-insensitively everywhere (people_common.find_person_by_name),
 * so "Mom" and "mom" would make every "saw Mom" ambiguous. The column's UNIQUE is
 * case-sensitive; this is the check that actually matters.
 */
function assertNameFree(db: Database.Database, name: string, personId: number | null) {
  const clash = db
    .prepare("SELECT id, name FROM people WHERE name = ? COLLATE NOCASE")
    .get(name) as { id: number; name: string } | undefined;
  if (clash && clash.id !== personId) {
    throw new BadRequest(`${clash.name} already exists`);
  }
}

/** Identifiers are globally unique: one number cannot be two people. */
function assertIdentifiersFree(
  db: Database.Database,
  identifiers: IdentifierInput[],
  personId: number | null
) {
  for (const { kind, value } of identifiers) {
    const clash = db
      .prepare(
        "SELECT p.id, p.name FROM identifiers i JOIN people p ON p.id = i.person_id " +
          "WHERE i.kind = ? AND i.value = ?"
      )
      .get(kind, value) as { id: number; name: string } | undefined;
    if (clash && clash.id !== personId) {
      throw new BadRequest(`${value} is already ${clash.name}'s`);
    }
  }
}

function writeIdentifiersAndRules(
  db: Database.Database,
  personId: number,
  identifiers: IdentifierInput[],
  rules: [string, number | null][]
) {
  db.prepare("DELETE FROM identifiers WHERE person_id = ?").run(personId);
  const insertId = db.prepare(
    "INSERT INTO identifiers (person_id, kind, value) VALUES (?, ?, ?)"
  );
  for (const { kind, value } of identifiers) insertId.run(personId, kind, value);

  db.prepare("DELETE FROM rules WHERE person_id = ?").run(personId);
  const insertRule = db.prepare(
    "INSERT INTO rules (person_id, source, min_duration_s) VALUES (?, ?, ?)"
  );
  for (const [source, min] of rules) insertRule.run(personId, source, min);
}

function fail(res: Response, err: unknown) {
  if (err instanceof BadRequest) {
    res.status(400).json({ error: err.message });
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  if (/UNIQUE constraint failed: people\.name/.test(message)) {
    res.status(400).json({ error: "Someone with that name already exists" });
    return;
  }
  res.status(500).json({ error: message });
}

const router = Router();

// ── List ──────────────────────────────────────────────────────────────────────

router.get("/api/people", (_req: Request, res: Response) => {
  const today = todayStr();
  const stripStart = shiftDay(today, -(STRIP_DAYS - 1));
  const db = openDb();
  // Nothing written yet is an empty list, not an error: the People page is
  // where the first person gets added, and it has to render to do that.
  if (!db) {
    return res.json({ people: [], strip_days: STRIP_DAYS, strip_start: stripStart, today });
  }
  try {
    const people = db
      .prepare(
        "SELECT * FROM people ORDER BY sort_order IS NULL, sort_order, name COLLATE NOCASE"
      )
      .all() as PersonRow[];
    const rules = rulesByPerson(db);

    const identifiers = db
      .prepare("SELECT person_id, kind, value FROM identifiers ORDER BY kind, value")
      .all() as { person_id: number; kind: string; value: string }[];

    const recent = db
      .prepare(
        "SELECT person_id, ts, source, duration_s FROM interactions WHERE ts >= ? ORDER BY ts"
      )
      .all(stripStart + "T00:00:00") as Pick<
      InteractionRow,
      "person_id" | "ts" | "source" | "duration_s"
    >[];

    const out = people.map((person) => {
      const personRules = rules.get(person.id);

      // Last qualifying interaction: walk back until one passes the rules.
      const history = db
        .prepare("SELECT * FROM interactions WHERE person_id = ? ORDER BY ts DESC")
        .all(person.id) as InteractionRow[];
      const last = history.find((i) => qualifies(personRules, i.source, i.duration_s)) ?? null;
      const daysSince = last ? daysBetween(dayOf(last.ts), today) : null;

      const mutedUntil = activeMute(db, person.id);
      const overdue = last === null || daysSince! > person.threshold_days;
      const status = mutedUntil
        ? "muted"
        : overdue
          ? "overdue"
          : daysSince! > person.threshold_days - DUE_SOON_DAYS
            ? "due_soon"
            : "ok";

      // 90-day strip: one entry per day that has any interaction at all.
      // Days where nothing qualified are still shown — they happened.
      const byDay = new Map<string, { sources: string[]; qualifies: boolean }>();
      for (const i of recent) {
        if (i.person_id !== person.id) continue;
        if (!shown(personRules, i.source, i.duration_s)) continue;
        const day = dayOf(i.ts);
        const entry = byDay.get(day) ?? { sources: [], qualifies: false };
        if (!entry.sources.includes(i.source)) entry.sources.push(i.source);
        entry.qualifies ||= qualifies(personRules, i.source, i.duration_s);
        byDay.set(day, entry);
      }

      return {
        id: person.id,
        name: person.name,
        threshold_days: person.threshold_days,
        notes: person.notes,
        last_ts: last?.ts ?? null,
        last_source: last?.source ?? null,
        last_duration_s: last?.duration_s ?? null,
        days_since: daysSince,
        muted_until: mutedUntil,
        status,
        rules: Object.fromEntries(personRules ?? []),
        identifiers: identifiers
          .filter((i) => i.person_id === person.id)
          .map(({ kind, value }) => ({ kind, value })),
        // Everything stored, which is what removing the person deletes…
        interaction_count: history.length,
        // …and what the page shows.
        shown_count: history.filter((i) => shown(personRules, i.source, i.duration_s)).length,
        days: [...byDay.entries()]
          .map(([date, v]) => ({ date, ...v }))
          .sort((a, b) => (a.date < b.date ? -1 : 1)),
      };
    });

    res.json({ people: out, strip_days: STRIP_DAYS, strip_start: stripStart, today });
  } catch (err) {
    fail(res, err);
  } finally {
    db.close();
  }
});

// ── Rescan saved exports ──────────────────────────────────────────────────────
//
// When someone is added, or their phone numbers change, their past
// calls may already be sitting in the saved exports (~/.config/nanoclaw/
// people-exports, outside the repo — see scripts/people-backfill.py). Replaying
// them is idempotent, so this just runs `people-backfill.py rescan` and reports
// what it found. It never fails the save that triggered it.

const backfillScript = path.join(nanoclawRoot, "scripts/people-backfill.py");
// The call-sync venv (Python 3.13 + wa-crypt-tools) can also read the saved
// WhatsApp backup; the system python3 (3.9) can't, and would skip it with a note.
const syncVenvPython = path.join(
  process.env.HOME || "",
  ".local/share/nanoclaw/people-call-sync-venv/bin/python"
);
const python = fs.existsSync(syncVenvPython)
  ? syncVenvPython
  : fs.existsSync("/usr/bin/python3")
    ? "/usr/bin/python3"
    : "python3";

type RescanResult = { added: Record<string, number> } | { error: string };

function rescanExports(): Promise<RescanResult> {
  return new Promise((resolve) => {
    execFile(
      python,
      [backfillScript, "--db", dbPath, "rescan", "--json"],
      { timeout: 60_000, maxBuffer: 1 << 20 },
      (err, stdout, stderr) => {
        if (err) {
          resolve({ error: (stderr || err.message).trim().split("\n").pop() || "rescan failed" });
          return;
        }
        try {
          const parsed = JSON.parse(stdout.trim().split("\n").pop() || "{}");
          resolve({ added: parsed.added ?? {} });
        } catch {
          resolve({ error: "rescan printed something unexpected" });
        }
      }
    );
  });
}

// ── Create ────────────────────────────────────────────────────────────────────

router.post("/api/people", async (req: Request, res: Response) => {
  const db = openDbWrite();
  let created: { id: number; name: string; threshold_days: number; notes: string | null } | null =
    null;
  try {
    const name = cleanName(req.body?.name);
    const threshold = cleanThreshold(req.body?.threshold_days);
    const notes = typeof req.body?.notes === "string" ? req.body.notes.trim() || null : null;
    const identifiers = cleanIdentifiers(req.body?.identifiers);
    const rules = cleanRules(req.body?.rules);
    assertNameFree(db, name, null);
    assertIdentifiersFree(db, identifiers, null);

    const id = db.transaction(() => {
      const info = db
        .prepare(
          "INSERT INTO people (name, threshold_days, notes, sort_order) VALUES (?, ?, ?, " +
            "(SELECT COALESCE(MAX(sort_order), -1) + 1 FROM people))"
        )
        .run(name, threshold, notes);
      const personId = Number(info.lastInsertRowid);
      writeIdentifiersAndRules(db, personId, identifiers, rules);
      return personId;
    })();

    created = { id, name, threshold_days: threshold, notes };
  } catch (err) {
    fail(res, err);
  } finally {
    db.close();
  }
  if (!created) return;
  const backfill = await rescanExports();
  res.json({ ...created, backfill });
});

// ── Reorder ───────────────────────────────────────────────────────────────────

/** Body: {ids: [3, 1, 2]} — every person, in the order they should appear. */
router.put("/api/people/order", (req: Request, res: Response) => {
  const db = openDbWrite();
  try {
    const ids = req.body?.ids;
    if (!Array.isArray(ids) || !ids.every((i) => Number.isInteger(i))) {
      throw new BadRequest("ids must be a list of person ids");
    }
    const existing = (db.prepare("SELECT id FROM people").all() as { id: number }[]).map(
      (r) => r.id
    );
    // A partial list would leave the others' positions colliding with the new
    // ones; insist on the whole set so the order is always total.
    const given = new Set<number>(ids);
    if (given.size !== ids.length || given.size !== existing.length ||
        !existing.every((id) => given.has(id))) {
      throw new BadRequest("ids must list every person exactly once — reload and try again");
    }
    const set = db.prepare("UPDATE people SET sort_order = ? WHERE id = ?");
    db.transaction(() => ids.forEach((id: number, pos: number) => set.run(pos, id)))();
    res.json({ ok: true });
  } catch (err) {
    fail(res, err);
  } finally {
    db.close();
  }
});

// ── Update ────────────────────────────────────────────────────────────────────

router.patch("/api/people/:id", async (req: Request, res: Response) => {
  const db = openDbWrite();
  let updated: { id: number; name: string; threshold_days: number; notes: string | null } | null =
    null;
  let identifiersChanged = false;
  try {
    const personId = parseInt(req.params.id, 10);
    const person = db.prepare("SELECT * FROM people WHERE id = ?").get(personId) as
      | PersonRow
      | undefined;
    if (!person) return res.status(404).json({ error: "No such person" });

    const name = req.body?.name === undefined ? person.name : cleanName(req.body.name);
    const threshold =
      req.body?.threshold_days === undefined
        ? person.threshold_days
        : cleanThreshold(req.body.threshold_days);
    const notes =
      req.body?.notes === undefined
        ? person.notes
        : typeof req.body.notes === "string"
          ? req.body.notes.trim() || null
          : null;

    // Identifiers and rules are replaced wholesale when present, left alone
    // when the field is omitted — so a rename does not silently wipe rules.
    const identifiers =
      req.body?.identifiers === undefined ? null : cleanIdentifiers(req.body.identifiers);
    const rules = req.body?.rules === undefined ? null : cleanRules(req.body.rules);
    assertNameFree(db, name, personId);
    if (identifiers) assertIdentifiersFree(db, identifiers, personId);
    if (identifiers) {
      const key = (list: IdentifierInput[]) =>
        list.map((i) => `${i.kind}:${i.value}`).sort().join("|");
      const before = db
        .prepare("SELECT kind, value FROM identifiers WHERE person_id = ?")
        .all(personId) as IdentifierInput[];
      identifiersChanged = key(before) !== key(identifiers);
    }

    db.transaction(() => {
      db.prepare("UPDATE people SET name = ?, threshold_days = ?, notes = ? WHERE id = ?").run(
        name,
        threshold,
        notes,
        personId
      );
      if (identifiers || rules) {
        const existingRules = [...(rulesByPerson(db).get(personId) ?? [])] as [
          string,
          number | null,
        ][];
        const existingIds = db
          .prepare("SELECT kind, value FROM identifiers WHERE person_id = ?")
          .all(personId) as IdentifierInput[];
        writeIdentifiersAndRules(
          db,
          personId,
          identifiers ?? existingIds,
          rules ?? existingRules
        );
      }
    })();

    updated = { id: personId, name, threshold_days: threshold, notes };
  } catch (err) {
    fail(res, err);
  } finally {
    db.close();
  }
  if (!updated) return;
  // Rules are applied at read time, so only a change in who someone *is*
  // (their phone numbers) can surface new history.
  const backfill = identifiersChanged ? await rescanExports() : null;
  res.json({ ...updated, backfill });
});

// ── Delete ────────────────────────────────────────────────────────────────────

router.delete("/api/people/:id", (req: Request, res: Response) => {
  const db = openDbWrite();
  try {
    const personId = parseInt(req.params.id, 10);
    const person = db.prepare("SELECT * FROM people WHERE id = ?").get(personId) as
      | PersonRow
      | undefined;
    if (!person) return res.status(404).json({ error: "No such person" });

    // Removing a person removes their history with them — the cascade is the
    // point. Nothing here is worth keeping once you have stopped tracking
    // someone, and a half-deleted person would still show up in matching.
    const { n } = db
      .prepare("SELECT COUNT(*) AS n FROM interactions WHERE person_id = ?")
      .get(personId) as { n: number };
    db.prepare("DELETE FROM people WHERE id = ?").run(personId);

    res.json({ deleted: person.name, interactions_deleted: n });
  } catch (err) {
    fail(res, err);
  } finally {
    db.close();
  }
});

// ── One person's history ──────────────────────────────────────────────────────

router.get("/api/people/:id/interactions", (req: Request, res: Response) => {
  const db = openDb();
  if (!db) return res.json({ interactions: [] });
  try {
    const personId = parseInt(req.params.id, 10);
    // The chart asks for everything; the history list asks for 20.
    const limit = Math.min(parseInt(String(req.query.limit ?? "20"), 10) || 20, 5000);
    // ?short=1 includes the calls under MIN_SHOWN_S the page hides by default.
    const includeShort = req.query.short === "1";
    const rules = rulesByPerson(db).get(personId);
    const rows = (
      db
        .prepare("SELECT * FROM interactions WHERE person_id = ? ORDER BY ts DESC")
        .all(personId) as InteractionRow[]
    )
      .filter((r) => includeShort || shown(rules, r.source, r.duration_s))
      .slice(0, limit);
    res.json({
      interactions: rows.map((r) => ({
        ...r,
        qualifies: qualifies(rules, r.source, r.duration_s),
      })),
    });
  } catch (err) {
    fail(res, err);
  } finally {
    db.close();
  }
});

// ── Log an interaction ────────────────────────────────────────────────────────

router.post("/api/people/:id/interactions", (req: Request, res: Response) => {
  const db = openDbWrite();
  try {
    const personId = parseInt(req.params.id, 10);
    const person = db.prepare("SELECT * FROM people WHERE id = ?").get(personId) as
      | PersonRow
      | undefined;
    if (!person) return res.status(404).json({ error: "No such person" });

    const { source, date, note, duration_s, direction } = req.body ?? {};
    if (!SOURCES.includes(source)) {
      throw new BadRequest(`source must be one of ${SOURCES.join(", ")}`);
    }
    const dir = direction ?? "n/a";
    if (!DIRECTIONS.includes(dir)) {
      throw new BadRequest(`direction must be one of ${DIRECTIONS.join(", ")}`);
    }
    if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new BadRequest("date must be YYYY-MM-DD");
    }
    if (date > todayStr()) throw new BadRequest("date is in the future");

    const duration =
      duration_s === undefined || duration_s === null || duration_s === ""
        ? null
        : Number(duration_s);
    if (duration !== null && (!Number.isFinite(duration) || duration < 0)) {
      throw new BadRequest("duration_s must be a non-negative number");
    }

    // Noon local, matching people-log.py: a bare date should not drift across a
    // day boundary when it is read back.
    const ts = `${date}T12:00:00`;
    const info = db
      .prepare(
        "INSERT INTO interactions (person_id, ts, source, direction, duration_s, note, origin, " +
          "origin_ref) VALUES (?, ?, ?, ?, ?, ?, 'dashboard', NULL)"
      )
      .run(personId, ts, source, dir, duration, note?.trim() || null);

    const rules = rulesByPerson(db).get(personId);
    res.json({
      id: info.lastInsertRowid,
      person: person.name,
      ts,
      source,
      qualifies: qualifies(rules, source, duration),
    });
  } catch (err) {
    fail(res, err);
  } finally {
    db.close();
  }
});

// ── Remove a mis-logged interaction ───────────────────────────────────────────

router.delete("/api/people/:id/interactions/:interactionId", (req: Request, res: Response) => {
  const db = openDbWrite();
  try {
    const info = db
      .prepare("DELETE FROM interactions WHERE id = ? AND person_id = ?")
      .run(parseInt(req.params.interactionId, 10), parseInt(req.params.id, 10));
    if (info.changes === 0) return res.status(404).json({ error: "No such interaction" });
    res.json({ deleted: info.changes });
  } catch (err) {
    fail(res, err);
  } finally {
    db.close();
  }
});

export default router;
