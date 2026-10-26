import { afterEach, describe, expect, test } from "bun:test";

import {
  createSessionObservers,
  observeUploadedSession,
  type EngineTarget,
  type ObservedUploader,
  type ObserverTiming,
} from "./session-upload-observer.js";
import type { UploadChildSession } from "./session-uploader.js";

/**
 * The turn observer against a fake 2.x engine: a chat's stored messages come
 * from GET /api/session/:id/message (newest first, cursor pages), never from
 * /context, which starts at the last compaction; its sub-agents are listed by
 * GET /api/session?parentID= and their own messages captured.
 */

const SESSION = "ses_v2_observed_01";
const CHILD = "ses_v2_child_0001";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

type V2Message = Record<string, unknown> & { id: string };

const user = (id: string, text: string): V2Message => ({ id, type: "user", text, time: { created: 1 } });
const answer = (id: string, content: unknown[] = [{ type: "text", text: `answer ${id}` }]): V2Message => ({
  id, type: "assistant", agent: "build", model: { id: "gpt-6-astra", providerID: "omnirush" }, content, finish: "stop", time: { created: 1, completed: 2 },
});

/** A fake 2.x engine: stored messages by session, children by parent; `/context` answers only what follows the last compaction. */
function startV2Engine() {
  const control = {
    messages: {} as Record<string, V2Message[]>,
    children: {} as Record<string, Array<{ id: string }>>,
    contextReads: 0,
    pageSize: 2,
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/api/session/active") return Response.json({ data: {} });
      if (url.pathname === "/api/session" && url.searchParams.has("parentID")) {
        return Response.json({ data: control.children[url.searchParams.get("parentID")!] ?? [], cursor: {} });
      }
      const route = /^\/api\/session\/([^/]+)(\/message|\/context)?$/.exec(url.pathname);
      const id = route ? decodeURIComponent(route[1]!) : null;
      if (!id || !(id in control.messages)) return Response.json({ code: "not_found" }, { status: 404 });
      const stored = control.messages[id]!;
      if (route![2] === "/context") {
        control.contextReads += 1;
        const cut = stored.map((message) => message.type).lastIndexOf("compaction");
        return Response.json({ data: cut < 0 ? stored : stored.slice(cut + 1) });
      }
      if (route![2] === "/message") {
        // Newest first, `pageSize` at a time; the cursor is the index the next page starts at.
        const newestFirst = [...stored].reverse();
        const start = url.searchParams.has("cursor") ? Number(url.searchParams.get("cursor")) : 0;
        const page = newestFirst.slice(start, start + control.pageSize);
        const next = start + control.pageSize < newestFirst.length ? String(start + control.pageSize) : undefined;
        return Response.json({ data: page, cursor: next ? { next } : {} });
      }
      return Response.json({ data: { id } });
    },
  });
  cleanups.push(() => server.stop(true));
  const target: EngineTarget = { baseUrl: `http://127.0.0.1:${server.port}`, headers: [["authorization", "Basic ZW5naW5l"]], search: "?directory=%2Ftmp%2Fproject", engine: "v2" };
  return { control, target };
}

const timing: Partial<ObserverTiming> = {
  now: () => Date.parse("2026-10-26T00:00:00.000Z"),
  sleep: async () => undefined,
  progressMs: 0,
};

/** What the observer hands the uploader: each turn's messages, the sub-agent sessions and the ids noted. */
class FakeUploader implements ObservedUploader {
  readonly enabled = true;
  checkpoint: string | undefined;
  readonly turns: unknown[][] = [];
  readonly children: UploadChildSession[] = [];

  async sessionCheckpoint(): Promise<{ resumed: boolean; lastMessageId?: string }> {
    return { resumed: false, ...(this.checkpoint ? { lastMessageId: this.checkpoint } : {}) };
  }
  async setSessionCheckpoint(_sessionId: string, messageId: string): Promise<void> {
    this.checkpoint = messageId;
  }
  recordTrace(): void {}
  recordSessionModel(): void {}
  async childCheckpoints(): Promise<Record<string, string>> {
    return {};
  }
  async childSessionIds(): Promise<string[]> {
    return [];
  }
  recordChildSession(_sessionId: string, child: UploadChildSession): void {
    this.children.push(child);
  }
  noteChildSessionIds(_sessionId: string, ids: readonly string[]): number {
    return ids.length;
  }
  captureSnapshot(): void {}
  flushTrace(_sessionId: string, finalTrace?: unknown): void {
    const messages = (finalTrace as { messages?: unknown[] } | undefined)?.messages;
    if (messages) this.turns.push(messages);
  }
}

const archive = { turnFollowed: () => undefined, turnCompleted: () => undefined, turnIncomplete: () => undefined };
const idsOf = (messages: readonly unknown[]) => messages.map((message) => String((message as { id?: unknown }).id));

function observe(uploader: FakeUploader, target: EngineTarget) {
  return observeUploadedSession({ sessionUploader: uploader, archive, observers: createSessionObservers(), target, timing, sessionId: SESSION, recovered: true });
}

describe("the 2.x engine's chats", () => {
  test("a sub-agent's own session is listed by parentID and captured with its messages", async () => {
    const { control, target } = startV2Engine();
    const call = { type: "tool", id: "call_1", name: "subagent", state: { status: "completed", input: { prompt: "look" }, metadata: { sessionID: CHILD }, content: [{ type: "text", text: "found it" }] } };
    control.messages[SESSION] = [user("msg_u1", "Split the work"), answer("msg_a1", [call]), answer("msg_a2")];
    control.messages[CHILD] = [user("msg_cu1", "look"), answer("msg_ca1", [{ type: "text", text: "the child's own answer" }])];
    control.children[SESSION] = [{ id: CHILD }];
    const uploader = new FakeUploader();

    await observe(uploader, target);

    expect(uploader.children.map((child) => child.childSessionId)).toEqual([CHILD]);
    expect(uploader.children[0]).toMatchObject({ parentSessionId: SESSION, depth: 1 });
    expect(idsOf(uploader.children[0]!.messages)).toEqual(["msg_cu1", "msg_ca1"]);
  });

  test("a compaction does not cut the history: the turn after it reads on from its checkpoint, the compaction and its summary included", async () => {
    const { control, target } = startV2Engine();
    const compaction = { id: "msg_c1", type: "compaction", reason: "manual", status: "completed", summary: "## Goal\nthe summary", time: { created: 3, completed: 4 } };
    control.messages[SESSION] = [user("msg_u1", "First"), answer("msg_a1"), compaction, user("msg_u2", "Second"), answer("msg_a2")];
    const uploader = new FakeUploader();
    uploader.checkpoint = "msg_a1";

    await observe(uploader, target);

    expect(control.contextReads).toBe(0);
    expect(uploader.turns).toHaveLength(1);
    expect(idsOf(uploader.turns[0]!)).toEqual(["msg_c1", "msg_u2", "msg_a2"]);
    expect(uploader.turns[0]![0]).toMatchObject({ type: "compaction", summary: "## Goal\nthe summary" });
    expect(uploader.checkpoint).toBe("msg_a2");
  });
});

test("a compaction the app starts (Compact context) is a turn the capture follows, as 1.x summarize was", async () => {
  const { isUploadV2PromptDispatch } = await import("./server.js");
  expect(isUploadV2PromptDispatch("POST", "/api/session/ses_a/compact")).toBe(true);
  expect(isUploadV2PromptDispatch("POST", "/api/session/ses_a/prompt")).toBe(true);
  expect(isUploadV2PromptDispatch("GET", "/api/session/ses_a/compact")).toBe(false);
  expect(isUploadV2PromptDispatch("POST", "/api/session/ses_a/interrupt")).toBe(false);
});
