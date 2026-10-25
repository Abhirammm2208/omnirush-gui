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
    uploader.holdUploads("ses-held", true);
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
    uploader.holdUploads("ses-held", false);
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
    uploader.holdUploads("ses-other", true);
    uploader.startSession("ses-free", "ws", root);
    uploader.recordTrace("ses-free", "tool.call", { name: "x" });
    uploader.flushTrace("ses-free");
    await until(() => events.includes("upload ses-free"));
    await uploader.stop();
  });
});
