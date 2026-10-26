// A chat migrated from 1.x keeps its 1.x agent ("omnirush"), which the 2.x engine does not have: before its turn the
// server switches it to the engine's "build" agent (server.ts ensureMigratedChatAgent), once per chat.
import { expect, test } from "bun:test";

import { ensureMigratedChatAgent } from "./server.js";

function engine(agent: string | null) {
  const calls: string[] = [];
  const fetchImpl = async (path: string, init: RequestInit = {}) => {
    calls.push(`${init.method ?? "GET"} ${path}${init.body ? ` ${String(init.body)}` : ""}`);
    if (path === "/api/agent") return Response.json({ data: [{ id: "build", mode: "primary" }, { id: "plan", mode: "primary" }] });
    if (path.endsWith("/agent")) return new Response(null, { status: 204 });
    return Response.json({ data: { id: "ses_m", ...(agent ? { agent } : {}) } });
  };
  return { calls, fetchImpl };
}

test("a migrated chat on the 1.x agent goes on with build; a known agent is left alone; one look per chat", async () => {
  const old = engine("omnirush");
  const checked = new Set<string>();
  expect(await ensureMigratedChatAgent(old.fetchImpl, "ses_m", checked)).toBe("omnirush");
  expect(old.calls).toContain('POST /api/session/ses_m/agent {"agent":"build"}');
  expect(await ensureMigratedChatAgent(old.fetchImpl, "ses_m", checked)).toBeNull();
  expect(old.calls.filter((call) => call.startsWith("POST"))).toHaveLength(1);

  const fine = engine("plan");
  expect(await ensureMigratedChatAgent(fine.fetchImpl, "ses_m", new Set())).toBeNull();
  expect(fine.calls.some((call) => call.startsWith("POST"))).toBe(false);
});
