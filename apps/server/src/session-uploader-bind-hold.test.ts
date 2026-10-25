import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionUploader } from "./session-uploader.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const until = async (check: () => boolean | Promise<boolean>, ms = 5_000) => {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

describe("strict sessions under enforce: an unbound chat's uploads wait for its binding", () => {
  test("bind fails, the server comes back: the spool flush is held, the retry binds, then the upload goes out", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnirush-bind-hold-"));
    roots.push(root);
    await writeFile(join(root, "app.txt"), "hello\n");
    const events: string[] = [];
    let reachable = false;
    const uploader = new SessionUploader({
      stateDir: join(root, "state"),
      upload: async (sessionId) => {
        if (!reachable) throw new Error("connect ECONNREFUSED");
        events.push(`upload ${sessionId}`);
        return Response.json({ ok: true }, { status: 201 });
      },
      changeDebounceMs: 10,
      fallbackScanMs: 60_000,
      retryBaseMs: 20,
    });
    // The broker held the chat at its first bind, which got no answer (origin unreachable).
    uploader.holdUploads("ses-held", "pending");
    uploader.holdUploads("ses-held", "refused");
    uploader.startSession("ses-held", "ws", root);
    uploader.recordTrace("ses-held", "tool.call", { name: "x" });
    uploader.flushTrace("ses-held");
    await until(async () => (await uploader.spoolStatus()).entries > 0);
    // The server is reachable again: the spool drains, but the held chat's upload stays spooled.
    reachable = true;
    await uploader.drainSpool();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(events).toEqual([]);
    expect((await uploader.spoolStatus()).entries).toBeGreaterThan(0);
    // The retry's bind is confirmed: the hold is released and the upload goes out after it.
    events.push("bind ses-held");
    uploader.holdUploads("ses-held", "confirmed");
    await until(() => events.includes("upload ses-held"));
    expect(events[0]).toBe("bind ses-held");
    expect(events.filter((event) => event.startsWith("upload")).every((event) => event === "upload ses-held")).toBe(true);
    await uploader.stop();
  });

  test("a chat that is not held uploads at once", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnirush-bind-hold-"));
    roots.push(root);
    await writeFile(join(root, "app.txt"), "hello\n");
    const events: string[] = [];
    const uploader = new SessionUploader({
      stateDir: join(root, "state"),
      upload: async (sessionId) => {
        events.push(`upload ${sessionId}`);
        return Response.json({ ok: true }, { status: 201 });
      },
      changeDebounceMs: 10,
      fallbackScanMs: 60_000,
    });
    uploader.holdUploads("ses-other", "pending");
    uploader.startSession("ses-free", "ws", root);
    uploader.recordTrace("ses-free", "tool.call", { name: "x" });
    uploader.flushTrace("ses-free");
    await until(() => events.includes("upload ses-free"));
    await uploader.stop();
  });

  test("bind refused, the app restarts: the new process keeps the chat held until a confirmed bind, then uploads", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnirush-bind-hold-"));
    roots.push(root);
    await writeFile(join(root, "app.txt"), "hello\n");
    const stateDir = join(root, "state");
    const events: string[] = [];
    let reachable = false;
    const make = () => new SessionUploader({
      stateDir,
      upload: async (sessionId) => {
        if (!reachable) throw new Error("connect ECONNREFUSED");
        events.push(`upload ${sessionId}`);
        return Response.json({ ok: true }, { status: 201 });
      },
      changeDebounceMs: 10,
      fallbackScanMs: 60_000,
      retryBaseMs: 20,
    });
    const first = make();
    first.holdUploads("ses-restart", "pending");
    first.holdUploads("ses-restart", "refused");
    first.startSession("ses-restart", "ws", root);
    first.recordTrace("ses-restart", "tool.call", { name: "x" });
    first.flushTrace("ses-restart");
    await until(async () => (await first.spoolStatus()).entries > 0);
    await first.stop();
    // A new process (no bind yet in it), and the server is back: its startup drain sends nothing for the chat.
    reachable = true;
    const second = make();
    await second.drainSpool();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(events).toEqual([]);
    expect((await second.spoolStatus()).entries).toBeGreaterThan(0);
    // The retry's bind in the new process is confirmed: the upload goes out after it.
    events.push("bind ses-restart");
    second.holdUploads("ses-restart", "pending");
    second.holdUploads("ses-restart", "confirmed");
    await until(() => events.includes("upload ses-restart"));
    expect(events[0]).toBe("bind ses-restart");
    await second.stop();
  });

  test("bind confirmed, then the app restarts: the chat's spooled upload is not held", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnirush-bind-hold-"));
    roots.push(root);
    await writeFile(join(root, "app.txt"), "hello\n");
    const stateDir = join(root, "state");
    const events: string[] = [];
    let reachable = false;
    const make = () => new SessionUploader({
      stateDir,
      upload: async (sessionId) => {
        if (!reachable) throw new Error("connect ECONNREFUSED");
        events.push(`upload ${sessionId}`);
        return Response.json({ ok: true }, { status: 201 });
      },
      changeDebounceMs: 10,
      fallbackScanMs: 60_000,
      retryBaseMs: 20,
    });
    const first = make();
    // Refused (kept on disk), its upload spooled, then confirmed while the server is still down: nothing is kept.
    first.holdUploads("ses-confirmed", "pending");
    first.holdUploads("ses-confirmed", "refused");
    first.startSession("ses-confirmed", "ws", root);
    first.recordTrace("ses-confirmed", "tool.call", { name: "x" });
    first.flushTrace("ses-confirmed");
    await until(async () => (await first.spoolStatus()).entries > 0);
    first.holdUploads("ses-confirmed", "confirmed");
    await first.stop();
    expect(events).toEqual([]);
    // A new process and the server is back: the startup drain sends the chat's upload, no bind needed.
    reachable = true;
    const second = make();
    await until(() => events.includes("upload ses-confirmed"));
    await second.stop();
  });

  async function spooledWhileHeld(stateDir: string, root: string, sessionId: string, holds: Array<[string, "pending" | "refused" | "confirmed", number]>) {
    const first = new SessionUploader({
      stateDir,
      upload: async () => { throw new Error("connect ECONNREFUSED"); },
      changeDebounceMs: 10,
      fallbackScanMs: 60_000,
      retryBaseMs: 20,
    });
    for (const [id, state, seq] of holds) first.holdUploads(id, state, seq);
    first.startSession(sessionId, "ws", root);
    first.recordTrace(sessionId, "tool.call", { name: "x" });
    first.flushTrace(sessionId);
    await until(async () => (await first.spoolStatus()).entries > 0);
    return first;
  }

  test("the app quits while the bind is pending: the restarted process keeps the chat held until it is confirmed", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnirush-bind-hold-"));
    roots.push(root);
    await writeFile(join(root, "app.txt"), "hello\n");
    const stateDir = join(root, "state");
    const first = await spooledWhileHeld(stateDir, root, "ses-pending-quit", [["ses-pending-quit", "pending", 1]]);
    await first.stop();
    const events: string[] = [];
    const second = new SessionUploader({
      stateDir,
      upload: async (sessionId) => { events.push(`upload ${sessionId}`); return Response.json({ ok: true }, { status: 201 }); },
      changeDebounceMs: 10,
      fallbackScanMs: 60_000,
      retryBaseMs: 20,
    });
    await second.drainSpool();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(events).toEqual([]);
    events.push("bind ses-pending-quit");
    second.holdUploads("ses-pending-quit", "pending", 1);
    second.holdUploads("ses-pending-quit", "confirmed", 2);
    await until(() => events.includes("upload ses-pending-quit"));
    expect(events[0]).toBe("bind ses-pending-quit");
    await second.stop();
  });

  test("a late, older hold call never undoes a confirmed binding", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnirush-bind-hold-"));
    roots.push(root);
    await writeFile(join(root, "app.txt"), "hello\n");
    const stateDir = join(root, "state");
    // Confirmed (seq 2) arrives before the pending of its bind (seq 1): the chat stays released.
    const first = await spooledWhileHeld(stateDir, root, "ses-reordered", [["ses-reordered", "pending", 3], ["ses-reordered", "confirmed", 5], ["ses-reordered", "pending", 4]]);
    await first.stop();
    const events: string[] = [];
    const second = new SessionUploader({
      stateDir,
      upload: async (sessionId) => { events.push(`upload ${sessionId}`); return Response.json({ ok: true }, { status: 201 }); },
      changeDebounceMs: 10,
      fallbackScanMs: 60_000,
      retryBaseMs: 20,
    });
    await until(() => events.includes("upload ses-reordered"));
    await second.stop();
  });

  test("a switch known not to enforce releases every held chat, on disk too", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnirush-bind-hold-"));
    roots.push(root);
    await writeFile(join(root, "app.txt"), "hello\n");
    const stateDir = join(root, "state");
    const first = await spooledWhileHeld(stateDir, root, "ses-switch-off", [["ses-switch-off", "refused", 1]]);
    first.holdUploads("*", "confirmed", 2);
    await first.stop();
    const events: string[] = [];
    const second = new SessionUploader({
      stateDir,
      upload: async (sessionId) => { events.push(`upload ${sessionId}`); return Response.json({ ok: true }, { status: 201 }); },
      changeDebounceMs: 10,
      fallbackScanMs: 60_000,
      retryBaseMs: 20,
    });
    await until(() => events.includes("upload ses-switch-off"));
    await second.stop();
  });
});
