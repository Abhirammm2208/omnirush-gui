/**
 * Archived chats on the 2.x engine: the app's own flag (the engine has no way to set it). Kept in the server's
 * runtime storage only; it never reaches the engine or an upload. The engine's v2 mount (server.ts) applies it:
 * a session PATCH's `archived` sets or clears it, and session reads carry it as `time.archived`.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const FILE = "archived-chats.json";
const MAX = 20_000;

function read(dir: string): Record<string, number> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, FILE), "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, number] => typeof entry[1] === "number" && entry[1] > 0));
  } catch {
    return {};
  }
}

/** When `sessionId` was archived, or undefined. */
export function archivedAt(dir: string, sessionId: string): number | undefined {
  return read(dir)[sessionId];
}

/** Sets (a time) or clears (null) a chat's archived flag. */
export function setArchived(dir: string, sessionId: string, at: number | null): void {
  const all = read(dir);
  if (at) all[sessionId] = at;
  else delete all[sessionId];
  const entries = Object.entries(all).slice(-MAX);
  const file = join(dir, FILE);
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(Object.fromEntries(entries)), { mode: 0o600 });
  renameSync(temp, file);
}

/** A session record (2.x `{id, time}`) with the app's archived flag applied. */
export function withArchived(dir: string, session: unknown, flags = read(dir)): unknown {
  if (!session || typeof session !== "object" || Array.isArray(session)) return session;
  const record = session as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id : null;
  if (!id) return session;
  const time = record.time && typeof record.time === "object" && !Array.isArray(record.time) ? { ...(record.time as Record<string, unknown>) } : {};
  if (flags[id]) time.archived = flags[id];
  else delete time.archived;
  return { ...record, time };
}

export const readArchivedChats = read;
