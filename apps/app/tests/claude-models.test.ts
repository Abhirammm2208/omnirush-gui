import { describe, expect, test } from "bun:test";

import {
  claudeModelOptions,
  claudeSandboxStep,
  decideModelPick,
  isClaudeModel,
  newChatPrompt,
  parseClaudeStatus,
  setUpClaudeSandbox,
  type ClaudeModelsState,
} from "../src/react-app/domains/session/surface/claude-models";

const opus = { providerID: "omnirush", modelID: "claude-opus-5-5" };
const sonnet = { providerID: "omnirush", modelID: "claude-sonnet-5-5" };
const astra = { providerID: "omnirush", modelID: "gpt-6-astra" };
const sol = { providerID: "omnirush", modelID: "gpt-6.1-sol" };
const catalog = [{ id: opus.modelID, name: "Claude Opus 5.5" }, { id: sonnet.modelID, name: "Claude Sonnet 5.5" }];
const allowed: ClaudeModelsState = { workspaceId: "w", catalog, models: [opus.modelID, sonnet.modelID], reason: null };
const denied: ClaudeModelsState = { workspaceId: "w", catalog, models: [], reason: "not_allowed" };

describe("picker entries", () => {
  test("every catalog model is listed, allowed or not, under Claude", () => {
    for (const state of [allowed, denied]) {
      const options = claudeModelOptions(state);
      expect(options.map((option) => [option.providerID, option.modelID, option.title, option.group])).toEqual([
        ["omnirush", "claude-opus-5-5", "Claude Opus 5.5", "Claude"],
        ["omnirush", "claude-sonnet-5-5", "Claude Sonnet 5.5", "Claude"],
      ]);
    }
    expect(claudeModelOptions({ catalog: [] })).toEqual([]);
  });

  test("only omnirush Claude ids are Claude models", () => {
    expect(isClaudeModel(opus)).toBe(true);
    expect(isClaudeModel(astra)).toBe(false);
    expect(isClaudeModel({ providerID: "anthropic", modelID: "claude-opus-5-5" })).toBe(false);
  });

  test("the status answer is read defensively", () => {
    expect(parseClaudeStatus("w", { models: [opus.modelID, 7, "gpt-6-astra"], catalog: [...catalog, { id: "bad id" }, null], reason: null }))
      .toEqual({ workspaceId: "w", catalog, models: [opus.modelID], reason: null });
    expect(parseClaudeStatus("w", null)).toEqual({ workspaceId: "w", catalog: [], models: [], reason: null });
  });
});

describe("popup decision", () => {
  test("a fresh chat just switches, or opens Claude", () => {
    expect(decideModelPick({ next: sol, current: astra, started: false, claude: allowed })).toEqual({ kind: "switch" });
    expect(decideModelPick({ next: sonnet, current: astra, started: false, claude: allowed })).toEqual({ kind: "claude" });
    expect(decideModelPick({ next: opus, current: null, started: false, claude: allowed })).toEqual({ kind: "claude" });
  });

  test("a started chat on another model offers a new chat, Claude or not", () => {
    expect(decideModelPick({ next: sol, current: astra, started: true, claude: allowed })).toEqual({ kind: "new_chat" });
    expect(decideModelPick({ next: sonnet, current: astra, started: true, claude: allowed })).toEqual({ kind: "new_chat" });
    expect(decideModelPick({ next: astra, current: astra, started: true, claude: allowed })).toEqual({ kind: "same" });
  });

  test("an account without Claude is told plainly, wherever it picks, with no switch", () => {
    for (const started of [false, true]) {
      expect(decideModelPick({ next: sonnet, current: astra, started, claude: denied }))
        .toEqual({ kind: "unavailable", message: "Claude Sonnet 5.5 isn't available on your account yet." });
    }
    expect(decideModelPick({ next: opus, current: null, started: false, claude: { ...denied, reason: "client_outdated" } }))
      .toEqual({ kind: "unavailable", message: "Claude Opus 5.5 needs the latest OmniRush. Update the app to use it." });
    // A model the account may run alongside one it may not.
    expect(decideModelPick({ next: sonnet, current: null, started: false, claude: { ...allowed, models: [opus.modelID] } }).kind).toBe("unavailable");
  });

  test("the popup names both models", () => {
    expect(newChatPrompt("GPT 6 Astra", "Claude Sonnet 5.5").title).toBe("Start a new chat with Claude Sonnet 5.5?");
  });
});

describe("auto sandbox", () => {
  const box = (on: boolean, need: string = "none", declined = false) => ({ on, setup: { need, declined } }) as never;

  test("the next step: on, then this computer's setup, then nothing", () => {
    expect(claudeSandboxStep(null)).toBeNull();
    expect(claudeSandboxStep(box(false))).toBe("on");
    expect(claudeSandboxStep(box(true, "linux_allow"))).toBe("linux_allow");
    expect(claudeSandboxStep(box(true, "win_install"))).toBe("win_install");
    expect(claudeSandboxStep(box(true, "win_install", true))).toBeNull();
    expect(claudeSandboxStep(box(true, "mac_vm"))).toBeNull();
    expect(claudeSandboxStep(box(true, "cannot_run"))).toBeNull();
    expect(claudeSandboxStep(box(true))).toBeNull();
  });

  test("a native project is turned on and set up once, with no loop", async () => {
    const calls: string[] = [];
    const client = {
      getWorkspaceBox: async () => { calls.push("get"); return box(false); },
      setWorkspaceBox: async (_: string, mode: string | null) => { calls.push(`set:${mode}`); return box(true, "linux_allow"); },
      // The step did not take (the person closed the prompt): never asked again in a loop.
      setupWorkspaceBox: async (_: string, action: string) => { calls.push(`setup:${action}`); return box(true, "linux_allow"); },
    };
    const result = await setUpClaudeSandbox(client as never, "w");
    expect(calls).toEqual(["get", "set:on", "setup:linux_allow"]);
    expect((result as { on: boolean }).on).toBe(true);
  });

  test("a sandbox project already set up is left alone", async () => {
    const calls: string[] = [];
    const client = {
      getWorkspaceBox: async () => { calls.push("get"); return box(true); },
      setWorkspaceBox: async () => { throw new Error("must not change"); },
      setupWorkspaceBox: async () => { throw new Error("must not change"); },
    };
    await setUpClaudeSandbox(client as never, "w");
    expect(calls).toEqual(["get"]);
  });
});
