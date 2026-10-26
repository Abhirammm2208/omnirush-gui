/**
 * First start of the 2.x engine with an existing 1.x store.
 *
 * The 2.x engine migrates a 1.x `opencode.db` in place on its first start (and drops
 * what it cannot read). It never gets the 1.x store itself: a consistent copy
 * (VACUUM INTO, safe while the 1.x engine still has it open) is kept as a backup, and
 * another copy seeds the 2.x store. The 1.x store stays untouched, so reinstalling a
 * 1.x app is the rollback. The chats that came from 1.x are recorded: their later
 * turns are marked in uploads (engine.migrated_from) and left out of deliveries.
 */
import { existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { importNodeSqlite } from "./runtime-db.js";

export const MIGRATED_SESSIONS_FILE = "v1-migrated-sessions.json";
/** The 1.x engine a migrated chat came from (the CLI sends the same value). */
export const MIGRATED_FROM = "1.18.32";

/** The 2.x engine's own folder under the server's runtime storage dir (engine-v2-preview.ts). */
export function engineV2Root(runtimeStorageDir: string): string {
  return join(runtimeStorageDir, "opencode-v2", "state");
}

type Sqlite = { exec(sql: string): void; all(sql: string): unknown[]; close(): void };

async function openDb(path: string, readOnly: boolean): Promise<Sqlite> {
  if (typeof process.versions.bun === "string") {
    const { Database } = await import("bun:sqlite");
    const db = new Database(path, readOnly ? { readonly: true, create: false } : { readwrite: true, create: false });
    return { exec: (sql) => db.run(sql), all: (sql) => db.query(sql).all(), close: () => db.close() };
  }
  const { DatabaseSync } = await importNodeSqlite();
  const db = new DatabaseSync(path, { readOnly, enableForeignKeyConstraints: false });
  return { exec: (sql) => db.exec(sql), all: (sql) => db.prepare(sql).all(), close: () => db.close() };
}

const openReadOnly = (path: string) => openDb(path, true);

function ids(rows: unknown[]): string[] {
  return rows.flatMap((row) => row && typeof (row as { id?: unknown }).id === "string" ? [(row as { id: string }).id] : []);
}

const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;

/**
 * Seeds `<v2Root>/opencode.db` from the 1.x store once (only while the 2.x store does not exist yet).
 * Returns what it did, or null when there was nothing to do.
 */
export async function seedV2StoreFromV1(v2Root: string, v1Db: string, now = new Date()): Promise<{ backup: string; sessions: string[] } | null> {
  const target = join(v2Root, "opencode.db");
  if (existsSync(target) || !existsSync(v1Db)) return null;
  const backupDir = join(dirname(v2Root), `v1-store-backup-${now.toISOString().replace(/[:.]/g, "-")}`);
  await mkdir(backupDir, { recursive: true, mode: 0o700 });
  const backup = join(backupDir, "opencode.db");
  const source = await openReadOnly(v1Db);
  let sessions: string[];
  try {
    source.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
    sessions = source.all("SELECT id FROM session").flatMap((row) =>
      row && typeof (row as { id?: unknown }).id === "string" ? [(row as { id: string }).id] : []);
  } finally {
    source.close();
  }
  await mkdir(v2Root, { recursive: true, mode: 0o700 });
  const staging = `${target}.seed`;
  await copyFile(backup, staging);
  await writeFile(join(v2Root, MIGRATED_SESSIONS_FILE), `${JSON.stringify({ from: MIGRATED_FROM, at: now.toISOString(), backup, sessions })}\n`, { mode: 0o600 });
  await rename(staging, target);
  return { backup, sessions };
}

/**
 * Brings over the 1.x chats an existing 2.x store does not have yet: chats made in a 1.x app after the store was
 * seeded (for example 3.7.6 -> 3.7.5 -> 3.7.8). A chat the 2.x store has, or that came over before (and may since
 * have been deleted there), is never touched. The chats go into the store's 1.x tables, which then hold only them,
 * and the 2.x engine's own migration converts them on its next start; the 1.x store stays untouched and a
 * consistent copy of it is kept as a backup. Returns the chats brought over, or null when there were none.
 */
export async function importMissingV1Chats(v2Root: string, v1Db: string, now = new Date()): Promise<{ backup: string; sessions: string[] } | null> {
  const target = join(v2Root, "opencode.db");
  if (!existsSync(target) || !existsSync(v1Db)) return null;
  const known = readMigratedSessions(v2Root);
  const store = await openDb(target, false);
  try {
    const tables = new Set(store.all("SELECT name FROM sqlite_master WHERE type = 'table'").map((row) => (row as { name: string }).name));
    if (!tables.has("session_v2") || !tables.has("kv")) return null;
    for (const id of ids(store.all("SELECT id FROM session_v2"))) known.add(id);
    const source = await openReadOnly(v1Db);
    let missing: string[];
    let backup: string;
    try {
      const v1Tables = new Set(source.all("SELECT name FROM sqlite_master WHERE type = 'table'").map((row) => (row as { name: string }).name));
      if (!["session", "message", "part"].every((name) => v1Tables.has(name))) return null;
      missing = ids(source.all("SELECT id FROM session")).filter((id) => !known.has(id));
      if (missing.length === 0) return null;
      backup = join(dirname(v2Root), `v1-store-backup-${now.toISOString().replace(/[:.]/g, "-")}`, "opencode.db");
      await mkdir(dirname(backup), { recursive: true, mode: 0o700 });
      source.exec(`VACUUM INTO ${quote(backup)}`);
    } finally {
      source.close();
    }
    store.exec(`ATTACH DATABASE ${quote(backup)} AS v1`);
    try {
      const wanted = missing.map(quote).join(",");
      store.exec("BEGIN IMMEDIATE");
      try {
        for (const table of ["session", "message", "part"]) {
          if (!tables.has(table)) {
            const [ddl] = store.all(`SELECT sql FROM v1.sqlite_master WHERE type = 'table' AND name = ${quote(table)}`) as { sql: string }[];
            store.exec(ddl!.sql);
          }
          const key = table === "session" ? "id" : "session_id";
          // Only the chats being brought over stay in the 1.x tables: the engine's migration converts every row there.
          store.exec(`DELETE FROM main.${table} WHERE ${key} NOT IN (${wanted})`);
          const own = new Set(store.all(`PRAGMA main.table_info(${table})`).map((row) => (row as { name: string }).name));
          const columns = store.all(`PRAGMA v1.table_info(${table})`).map((row) => (row as { name: string }).name).filter((name) => own.has(name));
          const list = columns.map((name) => `"${name}"`).join(", ");
          store.exec(`INSERT OR IGNORE INTO main.${table} (${list}) SELECT ${list} FROM v1.${table} WHERE ${key} IN (${wanted})`);
        }
        // Converts the 1.x tables on the next start; a set phase keeps the engine from clearing the store's events.
        const at = now.getTime();
        store.exec(`INSERT INTO kv (key, value, time_created, time_updated) VALUES ('migration.v1-v2', '{"phase":"sessions"}', ${at}, ${at})
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, time_updated = excluded.time_updated`);
        store.exec("COMMIT");
      } catch (error) {
        store.exec("ROLLBACK");
        throw error;
      }
    } finally {
      store.exec("DETACH DATABASE v1");
    }
    const previous = (() => { try { return JSON.parse(readFileSync(join(v2Root, MIGRATED_SESSIONS_FILE), "utf8")) as Record<string, unknown>; } catch { return {}; } })();
    const sessions = [...readMigratedSessions(v2Root), ...missing];
    await writeFile(join(v2Root, MIGRATED_SESSIONS_FILE), `${JSON.stringify({ from: MIGRATED_FROM, ...previous, sessions, lastImport: { at: now.toISOString(), backup, sessions: missing } })}\n`, { mode: 0o600 });
    return { backup, sessions: missing };
  } finally {
    store.close();
  }
}

/** The chats that came from the 1.x store (empty when none did). */
export function readMigratedSessions(v2Root: string): Set<string> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(v2Root, MIGRATED_SESSIONS_FILE), "utf8"));
    const sessions = parsed && typeof parsed === "object" ? (parsed as { sessions?: unknown }).sessions : undefined;
    return new Set(Array.isArray(sessions) ? sessions.filter((id): id is string => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}
