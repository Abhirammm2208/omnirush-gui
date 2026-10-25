import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { ALL_HELD_CHATS, answerCompleted, OmniRushGatewayBroker } from "./omnirush-gateway-broker.js";

const request = (sessionId: string) => new Request("http://127.0.0.1/omnirush-gateway/v1/responses", {
  method: "POST",
  headers: { authorization: "Bearer local-engine-token", "content-type": "application/json", "x-omnirush-session-id": sessionId },
  body: JSON.stringify({ model: "gpt-6-astra", tools: [{ type: "function", name: "bash" }] }),
});

const sse = (...events: string[]) => new Response(events.map((type) => `event: ${type}\ndata: {"type":"${type}"}\n\n`).join(""), { status: 200, headers: { "content-type": "text/event-stream" } });

/** A broker whose capabilities check always fails (the strict switch stays unknown); `answers` play the gateway. */
function unknownSwitch(answers: Array<() => Response>) {
  const dir = mkdtempSync(path.join(tmpdir(), "strict-unknown-hold-"));
  const order: string[] = [];
  const seqs: number[] = [];
  let next = 0;
  const broker = new OmniRushGatewayBroker({
    credentials: { gatewayUrl: "https://gateway.example/omnirush/v1", accessToken: "access-token", refreshToken: "refresh-token" },
    engineToken: "local-engine-token",
    strictStateFile: path.join(dir, "strict-sessions.json"),
    chatPin: () => ({ box: false, revision: null, capturePolicy: "client-v3" }),
    onUploadHold: (id, state, seq) => { order.push(`${state} ${id}`); seqs.push(seq); },
    fetch: async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/omnirush/collect/capabilities") return Response.json({ detail: "unavailable" }, { status: 503 });
      if (url.pathname === "/omnirush/device/session-binding") { order.push("bind"); return Response.json({}, { status: 500 }); }
      const answer = answers[Math.min(next, answers.length - 1)]!;
      next += 1;
      order.push(`upstream ${next}`);
      return answer();
    },
  });
  return { broker, order, seqs, ready: () => broker.sessionUploadCapabilities().catch(() => null), done: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("strict switch unknown: a chat's uploads wait for an answer that ran to its end", () => {
  test("the first request fails, the retry's answer completes: only then is the chat released", async () => {
    const { broker, order, seqs, ready, done } = unknownSwitch([
      () => Response.json({ error: { type: "server_error", message: "upstream unavailable" } }, { status: 502, headers: { "x-should-retry": "false" } }),
      () => sse("response.created", "response.completed"),
    ]);
    // The capabilities check fails: the switch is unknown.
    await ready();
    const first = await broker.handle(request("ses_unknown_hold"), "responses");
    expect(first.ok).toBe(false);
    await first.text();
    expect(order.filter((entry) => !entry.startsWith("upstream"))).toEqual(["pending ses_unknown_hold"]);
    const retry = await broker.handle(request("ses_unknown_hold"), "responses");
    expect(retry.status).toBe(200);
    // Not released before the answer has run to its end.
    expect(order.includes("confirmed ses_unknown_hold")).toBe(false);
    await retry.text();
    expect(order).toEqual(["pending ses_unknown_hold", "upstream 1", "pending ses_unknown_hold", "upstream 2", "confirmed ses_unknown_hold"]);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    done();
  }, 20_000);

  test("a 426, an answer ending in an error, or a stream cut short never release the chat", async () => {
    const cut = () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('event: response.created\ndata: {"type":"response.created"}\n\n'));
        controller.error(new Error("socket hang up"));
      },
    }), { status: 200, headers: { "content-type": "text/event-stream" } });
    const { broker, order, ready, done } = unknownSwitch([
      () => Response.json({ detail: "update_required" }, { status: 426 }),
      () => sse("response.created", "error"),
      cut,
    ]);
    await ready();
    for (let turn = 0; turn < 3; turn += 1) {
      const response = await broker.handle(request("ses_never_released"), "responses");
      await response.text().catch(() => undefined);
    }
    expect(order.some((entry) => entry.startsWith("confirmed"))).toBe(false);
    expect(order.filter((entry) => entry === "pending ses_never_released").length).toBe(3);
    done();
  }, 20_000);

  test("answerCompleted: a completed stream or a JSON body counts; an error or a missing end does not", () => {
    expect(answerCompleted('data: {"type":"response.completed"}\n', "text/event-stream")).toBe(true);
    expect(answerCompleted('data: {"type":"response.created"}\n', "text/event-stream")).toBe(false);
    expect(answerCompleted('data: {"type":"response.failed"}\n', "text/event-stream")).toBe(false);
    expect(answerCompleted('{"output":[]}', "application/json")).toBe(true);
    expect(answerCompleted("", "application/json")).toBe(false);
    expect(ALL_HELD_CHATS).toBe("*");
  });
});
