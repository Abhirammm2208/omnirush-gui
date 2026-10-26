// A chat's model switch on the 2.x engine (POST /api/session/:id/model) to another provider is refused before the
// engine takes it, so the session keeps its own model and its compaction still runs (server.ts, the v2 mount).
import { expect, test } from "bun:test";

import { OmniRushGatewayBroker } from "./omnirush-gateway-broker.js";

const sse = "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"r1\",\"output\":[]}}\n\n";

function broker() {
  return new OmniRushGatewayBroker({
    credentials: { gatewayUrl: "https://gateway.example/omnirush/v1", accessToken: "access-token", refreshToken: "refresh-token" },
    engineToken: "local-engine-token",
    fetch: async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
    // One provider: the GPT models (the catalog's switch_group "openai").
    switchable: async (bound: string, asked: string) => bound === asked || (bound.startsWith("gpt-") && asked.startsWith("gpt-")),
  });
}

const turn = (session: string, model: string) => new Request("http://127.0.0.1/omnirush-gateway/v1/responses", {
  method: "POST",
  headers: { Authorization: "Bearer local-engine-token", "Content-Type": "application/json", "x-omnirush-session-id": session },
  body: JSON.stringify({ model: `omnirush/${model}`, input: [], stream: true }),
});

test("a pinned chat may switch within its provider; another provider is refused before the engine switches", async () => {
  const gateway = broker();
  expect(await gateway.modelSwitchRefusal("ses_new", "kimi-k3.1-pro")).toBeNull();
  await (await gateway.handle(turn("ses_a", "gpt-6-astra"), "responses")).text();
  expect(await gateway.modelSwitchRefusal("ses_a", "gpt-6-astra")).toBeNull();
  expect(await gateway.modelSwitchRefusal("ses_a", "omnirush/gpt-6.1-sol")).toBeNull();
  const refused = await gateway.modelSwitchRefusal("ses_a", "kimi-k3.1-pro");
  expect(refused?.status).toBe(400);
  expect(refused?.headers.get("x-should-retry")).toBe("false");
  expect(((await refused!.json()) as { error: { message: string } }).error.message).toBe("This chat runs on gpt-6-astra. Start a new chat to use kimi-k3.1-pro.");
});
