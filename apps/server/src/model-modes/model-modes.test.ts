// Per-model modes on the desktop: the shared rules (PARITY.sha256, the same
// files in omnirush-cli src/model-modes/), the catalog keeping `modes`, and
// the gateway broker's X-OmniRush-Box, local refusal, plain message and
// sub-agent fallback for model_not_in_mode.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { OmniRushGatewayBroker } from "../omnirush-gateway-broker.js";
import { sanitizeOmniRushModelCatalog } from "../omnirush-model-catalog.js";
import { modelAllowedIn, modelForMode, modelModes, notInModeMessage, projectMode } from "./model-modes.mjs";

const CATALOG = sanitizeOmniRushModelCatalog({
  data: [
    { id: "gpt-6-astra", display_name: "GPT 6 Astra", default: true },
    { id: "kimi-k3.1-pro", display_name: "Kimi K3.1 Pro", family: "Kimi", modes: ["native"] },
  ],
})!;
const REFUSAL = { detail: "model_not_in_mode", error: { type: "invalid_request_error", code: "model_not_in_mode", message: "This model isn't available in sandbox projects.", omnirush: { code: "model_not_in_mode", retry: false } } };

type Call = { model: unknown; box: string | null; path: string };

function broker(calls: Call[], answer: (call: Call) => Response = () => Response.json({ output: [] }), modeCheck = true) {
  return new OmniRushGatewayBroker({
    credentials: { gatewayUrl: "https://gateway.example/omnirush/v1", accessToken: "access-token", refreshToken: "refresh-token" },
    engineToken: "local-engine-token",
    ...(modeCheck ? { modelInMode: (model: string, box: boolean) => { const entry = CATALOG.find((m) => m.id === model); return !entry || modelAllowedIn(entry, projectMode(box)); } } : {}),
    subagentRetryDelayMs: 1,
    fetch: async (input, init) => {
      const raw = init?.body;
      const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw as ArrayBuffer);
      const call = { model: JSON.parse(text).model, box: new Headers(init?.headers).get("x-omnirush-box"), path: new URL(String(input)).pathname };
      calls.push(call);
      return answer(call);
    },
  });
}

const request = (body: Record<string, unknown>, headers: Record<string, string> = {}, route = "responses") => new Request(`http://127.0.0.1/omnirush-gateway/v1/${route}`, {
  method: "POST",
  headers: { Authorization: "Bearer local-engine-token", "Content-Type": "application/json", ...headers },
  body: JSON.stringify(body),
});

describe("model modes", () => {
  test("CLI/desktop parity: model-modes/PARITY.sha256 matches its files", () => {
    const rows = readFileSync(path.join(import.meta.dir, "PARITY.sha256"), "utf8").split("\n").filter((line) => line && !line.startsWith("#"));
    expect(rows.map((row) => row.split(/\s+/)[1])).toEqual(["model-modes.mjs", "model-modes.d.mts"]);
    for (const row of rows) {
      const [hash, name] = row.split(/\s+/);
      const actual = createHash("sha256").update(readFileSync(path.join(import.meta.dir, name ?? ""))).digest("hex");
      expect(`${name} ${actual}`).toBe(`${name} ${hash}`);
    }
  });

  test("rules: absent means both; a list names what it allows; a refused pick moves to the allowed default", () => {
    expect(modelModes({ id: "a" })).toEqual(["native", "box"]);
    expect(modelModes({ id: "a", modes: ["native"] })).toEqual(["native"]);
    expect(modelForMode(CATALOG, "box", "kimi-k3.1-pro")).toMatchObject({ model: "gpt-6-astra", note: "Kimi K3.1 Pro isn't available in sandbox projects. Using GPT 6 Astra here." });
    expect(modelForMode(CATALOG, "native", "kimi-k3.1-pro")).toMatchObject({ model: "kimi-k3.1-pro", note: null });
  });

  test("the catalog keeps modes only when the backend lists them", () => {
    expect("modes" in CATALOG[0]!).toBe(false);
    expect(CATALOG[1]!.modes).toEqual(["native"]);
  });

  test("broker: a box chat's requests say so, its later unmarked ones too; native ones never", async () => {
    const calls: Call[] = [];
    const b = broker(calls);
    await b.handle(request({ model: "gpt-6-astra" }, { "x-omnirush-session-id": "ses_box", "x-omnirush-box": "1" }), "responses");
    // The same chat's compaction without the mark (and a sub-agent naming it as its main chat).
    await b.handle(request({ model: "gpt-6-astra" }, { "x-omnirush-session-id": "ses_box" }, "responses/compact"), "responses/compact");
    await b.handle(request({ model: "gpt-6-astra" }, { "x-omnirush-session-id": "ses_child", "x-parent-session-id": "ses_box" }), "responses");
    await b.handle(request({ model: "gpt-6-astra" }, { "x-omnirush-session-id": "ses_native" }), "responses");
    expect(calls.map((c) => [c.path, c.box])).toEqual([
      ["/omnirush/v1/responses", "1"],
      ["/omnirush/v1/responses/compact", "1"],
      ["/omnirush/v1/responses", "1"],
      ["/omnirush/v1/responses", null],
    ]);
  });

  test("broker: a model outside the chat's mode is refused here, never sent, in plain words", async () => {
    const calls: Call[] = [];
    const response = await broker(calls).handle(request({ model: "kimi-k3.1-pro" }, { "x-omnirush-session-id": "ses_box", "x-omnirush-box": "1" }), "responses");
    expect(calls).toEqual([]);
    expect(response.status).toBe(400);
    const body = await response.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe("model_not_in_mode");
    expect(body.error.message).toBe(notInModeMessage("box"));
    // Native: Kimi goes out.
    expect((await broker(calls).handle(request({ model: "kimi-k3.1-pro" }, { "x-omnirush-session-id": "ses_n" }), "responses")).status).toBe(200);
  });

  test("broker: the gateway's model_not_in_mode keeps its words", async () => {
    const calls: Call[] = [];
    const response = await broker(calls, () => Response.json(REFUSAL, { status: 400, headers: { "x-should-retry": "false" } }), false)
      .handle(request({ model: "kimi-k3.1-pro" }, { "x-omnirush-box": "1" }), "responses");
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { message: string } }).error.message).toBe("This model isn't available in sandbox projects.");
  });

  test("broker: one model per chat; titles (no tools), sub-agents and other chats pass", async () => {
    const calls: Call[] = [];
    const b = broker(calls, undefined, false);
    const tools = [{ type: "function", name: "bash" }];
    expect((await b.handle(request({ model: "kimi-k3.1-pro", tools }, { "x-omnirush-session-id": "ses_one" }), "responses")).status).toBe(200);
    const refused = await b.handle(request({ model: "gpt-6-astra", tools }, { "x-omnirush-session-id": "ses_one" }), "responses");
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: { code: string; message: string } }).error).toMatchObject({ code: "session_model_fixed", message: "This chat runs on kimi-k3.1-pro. Start a new chat to use gpt-6-astra." });
    expect((await b.handle(request({ model: "gpt-6-astra" }, { "x-omnirush-session-id": "ses_one" }), "responses")).status).toBe(200);
    expect((await b.handle(request({ model: "gpt-6-astra", tools }, { "x-omnirush-session-id": "ses_two" }), "responses")).status).toBe(200);
    expect(calls.map((c) => c.model)).toEqual(["kimi-k3.1-pro", "gpt-6-astra", "gpt-6-astra"]);
  });

  test("broker: a sub-agent's picked model refused for the mode runs on the main model", async () => {
    const calls: Call[] = [];
    const response = await broker(calls, (call) => call.model === "kimi-k3.1-pro" ? Response.json(REFUSAL, { status: 400, headers: { "x-should-retry": "false" } }) : Response.json({ output: [] }), false)
      .handle(request({ model: "kimi-k3.1-pro" }, { "x-omnirush-box": "1", "x-omnirush-session-id": "ses_sub", "x-omnirush-subagent-fallback-model": "gpt-6-astra" }), "responses");
    expect(response.status).toBe(200);
    expect(calls.map((c) => c.model)).toEqual(["kimi-k3.1-pro", "gpt-6-astra"]);
  });
});
