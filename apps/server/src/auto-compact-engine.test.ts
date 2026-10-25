// Automatic compaction on the 2.x engine (auto-compact-engine.ts opencodeV2AutoCompactEngine + the shared
// auto-compact.ts): a 2.x prompt body names no model, so the chat's model comes from its stored messages.
import { expect, test } from "bun:test";

import { desktopAutoCompactEngine } from "./auto-compact-engine.js";
import { AutoCompactor } from "./session-archive/auto-compact.js";

const MODEL = { id: "gpt-6-astra", providerID: "omnirush" };

/** A 2.x engine for one chat: its stored messages (GET /api/session/:id/context) and the compact call. */
function v2Engine() {
  const stored: Record<string, unknown>[] = [{ id: "msg_switch", type: "model-switched", time: { created: 1 }, model: MODEL }];
  const compacts: string[] = [];
  let at = 10;
  const turn = (text: string) => {
    stored.push({ id: `msg_u${at}`, type: "user", time: { created: at }, text });
    stored.push({ id: `msg_a${at}`, type: "assistant", time: { created: at + 1, completed: at + 2 }, agent: "build", model: MODEL, finish: "stop", content: [{ type: "text", text: "done" }] });
    at += 10;
  };
  const engineCompacted = () => {
    stored.push({ id: `cmp_engine${at}`, type: "compaction", reason: "auto", status: "completed", time: { created: at, completed: at + 1 } });
    at += 10;
  };
  const fetchImpl = async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const path = url.pathname;
    if (path.endsWith("/api/session/active")) return Response.json({ data: {} });
    if (path.endsWith("/context")) return Response.json({ data: stored });
    if (path.endsWith("/compact") && init.method === "POST") {
      const id = `cmp_${compacts.length + 1}`;
      compacts.push(id);
      stored.push({ id, type: "compaction", reason: "manual", status: "completed", time: { created: at, completed: at + 1 } });
      at += 10;
      return Response.json({ data: { id } });
    }
    if (path.endsWith("/message") && url.searchParams.get("type") === "compaction") return Response.json({ data: stored.filter((item) => item.type === "compaction").reverse() });
    if (/\/api\/session\/ses_v2$/.test(path)) return Response.json({ data: { id: "ses_v2", model: MODEL } });
    throw new Error(`unexpected ${init.method ?? "GET"} ${path}`);
  };
  const engine = desktopAutoCompactEngine({ baseUrl: "http://127.0.0.1:4096", headers: [["authorization", "Basic x"]], search: "?location%5Bdirectory%5D=%2Fw", engine: "v2" }, "ses_v2", fetchImpl as never);
  return { engine, turn, engineCompacted, compacts, fetchImpl };
}

/** The chat's reads go through the server's loopback fetch (session-upload-observer.ts): the same stub serves them. */
async function withFetch<T>(fetchImpl: (input: string | URL | Request, init?: RequestInit) => Promise<Response>, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = fetchImpl as typeof fetch;
  try { return await run(); } finally { globalThis.fetch = original; }
}

const policy = async () => ({ enabled: true, afterTurns: 2, minContextTokens: 0 });
/** A 2.x prompt body: text only, its model was set on the session before (POST /api/session/:id/model). */
const body = (text: string) => JSON.stringify({ text });

test("v2: no compaction under the threshold, exactly one past it, on the chat's model", async () => {
  const chat = v2Engine();
  const compactor = new AutoCompactor({ policy, holdMs: 5_000 });
  const actions: string[] = [];
  await withFetch(chat.fetchImpl, async () => {
    for (const [index, text] of ["first", "second", "third", "fourth"].entries()) {
      const outcome = await compactor.beforePrompt("ses_v2", chat.engine, body(text));
      actions.push(outcome.action);
      chat.turn(text);
      if (index === 1) expect(chat.compacts).toEqual([]);
    }
  });
  expect(actions).toEqual(["none", "none", "compacted", "none"]);
  expect(chat.compacts).toEqual(["cmp_1"]);
});

test("v2: a chat the engine compacted itself is not compacted again by us", async () => {
  const chat = v2Engine();
  const compactor = new AutoCompactor({ policy, holdMs: 5_000 });
  const actions: string[] = [];
  await withFetch(chat.fetchImpl, async () => {
    for (const text of ["first", "second", "third"]) {
      if (text === "third") chat.engineCompacted();
      actions.push((await compactor.beforePrompt("ses_v2", chat.engine, body(text))).action);
      chat.turn(text);
    }
  });
  expect(actions).toEqual(["none", "none", "none"]);
  expect(chat.compacts).toEqual([]);
});
