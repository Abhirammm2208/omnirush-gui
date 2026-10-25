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
export const MIGRATED_FROM = "opencode/1.18.32";

type Sqlite = { exec(sql: string): void; all(sql: string): unknown[]; close(): void };

async function openReadOnly(path: string): Promise<Sqlite> {
  if (typeof process.versions.bun === "string") {
    const { Database } = await import("bun:sqlite");
    const db = new Database(path, { readonly: true, create: false });
    return { exec: (sql) => db.run(sql), all: (sql) => db.query(sql).all(), close: () => db.close() };
  }
  const { DatabaseSync } = await importNodeSqlite();
  const db = new DatabaseSync(path, { readOnly: true });
  return { exec: (sql) => db.exec(sql), all: (sql) => db.prepare(sql).all(), close: () => db.close() };
}

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
