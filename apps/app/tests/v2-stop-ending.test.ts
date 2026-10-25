// A user Stop on the 2.x engine, read the way the desktop reads it after the turn: the 2.x history
// (createClientV2 messages) → the chat's UI messages (snapshotToUIMessages) → the Good session facts
// (messageFacts) → the automatic "continue" (autoRetryMessage) and the finish guard (finishGuardKind).
import { describe, expect, test } from "bun:test";
import type { OmniRushSessionStatus } from "@omnirush/types/desktop-ipc";

import { createClientV2 } from "../src/app/lib/opencode-v2-adapter";
import { unwrap } from "../src/app/lib/opencode";
import { autoRetryMessage, finishGuardKind, messageFacts } from "../src/app/lib/good-session";
import { snapshotToUIMessages } from "../src/react-app/domains/session/sync/usechat-adapter";

const MODEL = { id: "gpt-6-astra", providerID: "omnirush" };
const BASE = "http://127.0.0.1:4096/workspace/ws_1/opencode2";

/** One turn the user stopped mid-tool, oldest first as the engine stores it. `answer` is the stopped answer's own fields. */
function stoppedTurn(answer: Record<string, unknown>) {
  return [
    { id: "msg_switch", type: "model-switched", time: { created: 1 }, model: MODEL },
    { id: "msg_user", type: "user", time: { created: 2 }, text: "run the tests" },
    {
      id: "msg_answer", type: "assistant", time: { created: 3 }, agent: "build", model: MODEL,
      content: [{ type: "tool", id: "call_1", name: "shell", time: { created: 3, ran: 3 }, state: { status: "running", input: { command: "npm test" } } }],
      ...answer,
    },
    { id: "msg_idle", type: "idle", time: { created: 4 }, outcome: "interrupted" },
  ];
}

async function readBack(stored: Record<string, unknown>[]) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.pathname.endsWith("/api/session/ses_stop/message")) return Response.json({ data: [...stored].reverse() });
    throw new Error(`unexpected ${url.pathname}`);
  }) as typeof fetch;
  try {
    const client = createClientV2(BASE, "/w", { token: "t" });
    const messages = unwrap(await client.session.messages({ sessionID: "ses_stop" }));
    return messageFacts(snapshotToUIMessages({ messages } as never));
  } finally {
    globalThis.fetch = original;
  }
}

const server = {
  sessionId: "ses_stop", status: "on_track", reasons: [], message: null, dock: null, verdict: null, checklist: [],
  evaluatedAt: "2026-10-25T00:00:00Z", pollSeconds: 60,
  client: { autoRetry: { enabled: true, max: 1, message: "Continue." }, finishGuard: true, oneMoreTurn: true },
} as unknown as OmniRushSessionStatus;

describe("a user Stop on the 2.x engine", () => {
  for (const [name, answer] of [
    ["its answer carries the aborted error", { error: { type: "aborted", message: "Step interrupted" }, time: { created: 3, completed: 4 } }],
    ["its answer has no error, the turn's idle marker says interrupted", {}],
  ] as const) {
    test(`${name}: stopped, never retried, no finish guard`, async () => {
      const facts = await readBack(stoppedTurn(answer));
      expect(facts.ended).toBe("stopped");
      expect(facts.retryable).toBe(false);
      // Even before the Stop flag of this window is known (another window stopped it, or a restart).
      expect(autoRetryMessage({ turnRunning: false, ended: facts.ended, retryable: facts.retryable, userStopped: false, retriesInARow: 0, server })).toBeNull();
      expect(finishGuardKind({ turnRunning: false, ended: facts.ended, endedAt: facts.endedAt })).toBeNull();
    });
  }

  test("a turn cut by the engine (not stopped) is still retried once", async () => {
    const stored = stoppedTurn({});
    stored[3] = { id: "msg_idle", type: "idle", time: { created: 4 }, outcome: "failed", error: { type: "provider", message: "upstream_incomplete" } };
    const facts = await readBack(stored);
    expect(facts.ended).not.toBe("stopped");
  });
});
