// The catalog's efforts reach the 2.x engine (as the CLI's engine-v2.js v2Model), and a mid-chat effort change goes as
// the request's own effort (supportsEffortUpdates false), which is what the gateway meters.
import { expect, test } from "bun:test";

import { engineModelsFromCatalog } from "./omnirush-model-catalog.js";
import { v2ModelConfig } from "./managed-opencode-v2.js";

test("a reasoning model lists the catalog efforts and turns effort updates off", () => {
  const config = {
    reasoning: true,
    variants: { low: { reasoningEffort: "low" }, high: { reasoningEffort: "high" }, medium: { disabled: true }, max: { reasoningEffort: "max" } },
    options: { reasoningEffort: "high" },
  };
  const entry = v2ModelConfig({ id: "gpt-6-astra", name: "GPT 6 Astra", config });
  expect(entry.capabilities).toMatchObject({ reasoning: { supported: true, effort: ["low", "high", "max"] } });
  expect(entry.compatibility).toEqual({ supportsEffortUpdates: false });
  expect(entry.settings).toEqual({ reasoningEffort: "high" });
});

test("a model without reasoning gets neither", () => {
  const entry = v2ModelConfig({ id: "plain", name: "Plain", config: { reasoning: false } });
  expect((entry.capabilities as Record<string, unknown>).reasoning).toBeUndefined();
  expect(entry.compatibility).toBeUndefined();
});

test("the app catalog's efforts come through in catalog order", () => {
  const catalog = engineModelsFromCatalog([{
    id: "gpt-6-astra", display_name: "GPT 6 Astra", reasoning_levels: ["low", "high", "xhigh", "max"],
    capabilities: { reasoning: true, tool_call: true, web_search: false, image_input: false, file_input: false },
    limits: { context: 400000, output: 128000 },
  } as never]);
  const entry = v2ModelConfig({ id: "gpt-6-astra", name: "GPT 6 Astra", config: catalog["gpt-6-astra"] });
  expect((entry.capabilities as { reasoning: unknown }).reasoning).toEqual({ supported: true, effort: ["low", "high", "xhigh", "max"] });
});

test("the window's model list keeps the efforts' names and never their settings", async () => {
  const { publicV2Model } = await import("./server.js");
  const model = publicV2Model({
    id: "gpt-6-astra", providerID: "omnirush", name: "GPT 6 Astra", settings: { apiKey: "secret" },
    variants: [{ id: "low", settings: { reasoningEffort: "low", apiKey: "secret" } }, { id: "max", settings: {} }],
  });
  expect(model).toEqual({ id: "gpt-6-astra", providerID: "omnirush", name: "GPT 6 Astra", variants: [{ id: "low" }, { id: "max" }] });
  expect(JSON.stringify(model)).not.toContain("secret");
  expect(publicV2Model({ id: "plain", providerID: "omnirush" })).toEqual({ id: "plain", providerID: "omnirush" });
});
