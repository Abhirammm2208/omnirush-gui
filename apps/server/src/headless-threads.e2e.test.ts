import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { createHeadlessThreadClient } from "@omnirush/headless-threads";

import { createManagedOpencodeV2Server, type ManagedOpencodeV2Server } from "./managed-opencode-v2.js";

// The headless client (automations) against the real bundled 2.x engine, through a stand-in for the
// server's `/workspace/:id/opencode2` mount (the mount itself: opencode-proxy and session-uploader tests).
const triple = process.arch === "arm64" ? "aarch64-unknown-linux-gnu" : "x86_64-unknown-linux-gnu";
const engineBin = process.env.OMNIRUSH_OPENCODE2_BIN?.trim()
  || join(resolve(import.meta.dir, "../../.."), `apps/desktop/resources/sidecars/opencode2-${triple}`);
const realEngine = process.platform === "linux" && existsSync(engineBin) ? test : test.skip;

let root = "";
let engine: ManagedOpencodeV2Server | undefined;
let model: ReturnType<typeof Bun.serve> | undefined;
let mount: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  if (!existsSync(engineBin) || process.platform !== "linux") return;
  root = await mkdtemp(join(tmpdir(), "headless-v2-"));
  await mkdir(join(root, "project"), { recursive: true });
  // A model that answers every request with "ok" (chat completions, streamed).
  model = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => {
      const chunk = (delta: unknown, finish: string | null) => `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta, finish_reason: finish }], ...(finish ? { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } } : {}) })}\n\n`;
      return new Response(`${chunk({ role: "assistant", content: "ok" }, null)}${chunk({}, "stop")}data: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
    },
  });
  engine = await createManagedOpencodeV2Server({ bin: engineBin, rootDir: join(root, "engine"), bootTimeoutMs: 90_000, env: { HOME: join(root, "home") } });
  await engine.setProviders([{ id: "omnirush", name: "OmniRush", baseUrl: `http://127.0.0.1:${model.port}/v1`, package: "@opencode-ai/ai/providers/openai-compatible", apiKey: "x", models: [{ id: "test-model", name: "test-model", config: { tool_call: true } }] }]);
  for (let i = 0; i < 120 && !JSON.stringify((await engine.fetchJson("/api/model", { directory: join(root, "project") })).json).includes("test-model"); i += 1) await Bun.sleep(250);
  const active = engine;
  mount = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (request) => {
      const url = new URL(request.url);
      const target = new URL(active.url);
      target.pathname = url.pathname.replace(/^\/workspace\/ws_1\/opencode2/, "");
      target.search = url.search;
      target.searchParams.set("location[directory]", join(root, "project"));
      const body = request.method === "GET" ? undefined : await request.text();
      const forwarded = url.pathname.endsWith("/api/session") && request.method === "POST"
        ? JSON.stringify({ ...JSON.parse(body || "{}"), location: { directory: join(root, "project") } })
        : body;
      const answer = await fetch(target, { method: request.method, headers: { authorization: `Basic ${Buffer.from(`opencode:${active.password}`).toString("base64")}`, "content-type": "application/json" }, body: forwarded });
      return new Response(await answer.arrayBuffer(), { status: answer.status, headers: { "content-type": answer.headers.get("content-type") ?? "application/json" } });
    },
  });
}, 120_000);

afterAll(async () => {
  await mount?.stop(true);
  await engine?.close();
  await model?.stop(true);
  if (root) await rm(root, { recursive: true, force: true });
});

realEngine("drives two headless turns on a native 2.x thread", async () => {
  const client = createHeadlessThreadClient({
    baseUrl: `http://127.0.0.1:${mount!.port}`,
    workspaceId: "ws_1",
    token: "owt_test",
    defaultModel: { providerId: "omnirush", modelId: "test-model" },
  });
  const thread = await client.createThread({ title: "Headless", prompt: "Say ok." });
  expect(thread.started).toBe(true);
  const first = await client.waitForThread(thread.id, { timeoutMs: 60_000, since: { messageCountBefore: 0, messageId: null } });
  expect(first.outcome).toBe("settled");

  const accepted = await client.sendTurn(thread.id, { prompt: "Again.", messageId: "msg_headless_2" });
  const second = await client.waitForThread(thread.id, { timeoutMs: 60_000, since: accepted });
  expect(second.outcome).toBe("settled");
  // Sending the same message id again is not a second turn.
  expect((await client.sendTurn(thread.id, { prompt: "Again.", messageId: "msg_headless_2" })).alreadyPresent).toBe(true);

  const transcript = await client.exportTranscript(thread.id);
  expect(JSON.stringify(transcript)).toContain("ok");
  expect((await client.abortThread(thread.id)).threadId).toBe(thread.id);
}, 180_000);
