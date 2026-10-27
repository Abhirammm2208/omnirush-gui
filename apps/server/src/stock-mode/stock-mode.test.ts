import { expect, test } from "bun:test";

import { engineV2SpawnEnv } from "../managed-opencode-v2.js";
import { applyStockSwitches, STOCK_SWITCHES, stockMode, stockProviders } from "./stock-mode.mjs";

const base = { PATH: "/usr/bin", OMNIRUSH_NO_SYSTEM_CONFIG: "1" };

test("stock mode is on only when asked, and sets the CLI's switches", () => {
  expect(stockMode({})).toBe(false);
  expect(stockMode({ OMNIRUSH_FARM: "0" })).toBe(false);
  for (const value of ["1", "true", " ON ", "yes"]) expect(stockMode({ OMNIRUSH_FARM: value })).toBe(true);
  const off: Record<string, string> = {};
  expect(applyStockSwitches(off)).toBe(false);
  expect(off).toEqual({});
  const on: Record<string, string> = { OMNIRUSH_FARM: "true" };
  expect(applyStockSwitches(on)).toBe(true);
  expect(on).toEqual({ ...STOCK_SWITCHES });
  expect(on.OMNIRUSH_FARM).toBe("1");
  expect(on.OMNIRUSH_INSTALL_LOG).toBe("0");
  expect(on.OMNIRUSH_COMPUTER_USE).toBe("0");
});

test("the engine gets the gateway's GPT 6 Astra only, without our web search option", () => {
  const astra = { id: "gpt-6-astra", name: "GPT 6 Astra", config: { reasoning: true, options: { reasoningEffort: "high", hostedWebSearch: { searchContextSize: "low" } } } };
  const specs = [
    { id: "omnirush", name: "OmniRush", apiKey: "k", models: [astra, { id: "kimi-k3.1-pro", name: "Kimi", config: {} }] },
    { id: "omnirush-claude", name: "Claude", apiKey: "k", models: [{ id: "opus", name: "Opus", config: {} }] },
  ];
  const out = stockProviders(specs);
  expect(out.map((spec) => spec.id)).toEqual(["omnirush"]);
  expect(out[0]!.models.map((model) => model.id)).toEqual(["gpt-6-astra"]);
  expect(out[0]!.models[0]!.config).toEqual({ reasoning: true, options: { reasoningEffort: "high" } });
  expect(astra.config.options.hostedWebSearch).toBeDefined();
  expect(stockProviders([{ ...specs[0]!, models: [specs[0]!.models[1]!] }])).toEqual([]);
});

test("the engine gate lets only the gateway and no MCP server through in stock mode", () => {
  const normal = engineV2SpawnEnv({ ...base }, ["computer"]);
  expect(normal.OMNIRUSH_GATE_PROVIDERS).toBe("omnirush,omnirush-claude");
  expect(normal.OMNIRUSH_GATE_MCP).toContain("computer");
  const stock = engineV2SpawnEnv({ ...base, OMNIRUSH_FARM: "1" }, ["computer"]);
  expect(stock.OMNIRUSH_GATE_PROVIDERS).toBe("omnirush");
  expect(stock.OMNIRUSH_GATE_MCP).toBe("");
});
