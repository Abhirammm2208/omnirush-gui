// Per-model modes in the app: a sandbox (box) project shows and sends only the
// models that may run in the sandbox, a project without it only the ones that
// may run outside it. The server lists each catalog model's `modes`
// (GET /omnirush/subagent-model, normalized from the backend's catalog by the
// shared apps/server/src/model-modes/model-modes.mjs: no `modes` means both).
// The gateway broker sends X-OmniRush-Box for box chats and refuses a model
// outside the chat's mode before it leaves this computer.
import { useEffect, useMemo } from "react";
import { create } from "zustand";

import type { ModelRef } from "@/app/types";
import type { OmniRushSubagentModelState } from "@/app/lib/omnirush-server";
import { useLinuxSandbox, type LinuxSandboxClient } from "@/react-app/domains/settings/linux-sandbox";
import { useSubagentModel, type SubagentModelClient } from "@/react-app/domains/settings/subagent-model";

type CatalogModels = OmniRushSubagentModelState["models"];
type Mode = "native" | "box";

/** Whether `model` may run in `mode`: any other provider's, an unknown model, or one listing the mode. */
export function modeAllowsModel(models: CatalogModels | undefined, mode: Mode | null, model: ModelRef | null | undefined): boolean {
  if (!mode || !model || model.providerID !== "omnirush") return true;
  const entry = models?.find((candidate) => candidate.id === model.modelID);
  return !entry?.modes || entry.modes.includes(mode);
}

/** The model a project in `mode` uses instead of `model`: the catalog default among the allowed ones, else the first allowed. */
export function modeFallbackModel(models: CatalogModels | undefined, mode: Mode | null, model: ModelRef | null | undefined): ModelRef | null {
  if (modeAllowsModel(models, mode, model)) return model ?? null;
  const allowed = (models ?? []).filter((entry) => !entry.modes || entry.modes.includes(mode!));
  const pick = allowed.find((entry) => entry.default) ?? allowed[0];
  return pick ? { providerID: "omnirush", modelID: pick.id } : null;
}

/** "Kimi K3.1 Pro isn't available in sandbox projects. Using GPT 6 Astra here." */
export function modeSwitchNote(models: CatalogModels | undefined, mode: Mode, from: ModelRef, to: ModelRef): string {
  const name = (ref: ModelRef) => models?.find((entry) => entry.id === ref.modelID)?.name ?? ref.modelID;
  return `${name(from)} isn't available ${mode === "box" ? "in sandbox projects" : "outside the sandbox"}. Using ${name(to)} here.`;
}

/**
 * The open project's rule for every model list the app shows (the composer's
 * model menu, the model picker): set by the session route, all models while
 * no project mode is known.
 */
export const useModelModeFilter = create<{ allows: (model: ModelRef | null | undefined) => boolean }>(() => ({ allows: () => true }));

/**
 * The mode of the open project (or chat: one kept on this computer when the
 * sandbox became required stays native) and its model rules. `mode` is null
 * until the project's sandbox state is known: nothing is filtered meanwhile.
 */
export function useProjectModelModes(
  client: (LinuxSandboxClient & SubagentModelClient) | null,
  workspaceId: string | null,
  sessionId: string | null,
) {
  const sandbox = useLinuxSandbox(client, workspaceId, { fresh: false, sessionId });
  const { state } = useSubagentModel(client);
  const box = sandbox.box;
  const mode: Mode | null = box ? (box.on && !box.chatKept ? "box" : "native") : null;
  const models = state?.models;
  const rules = useMemo(() => ({
    mode,
    allows: (model: ModelRef | null | undefined) => modeAllowsModel(models, mode, model),
    fallback: (model: ModelRef | null | undefined) => modeFallbackModel(models, mode, model),
    note: (from: ModelRef, to: ModelRef) => modeSwitchNote(models, mode ?? "native", from, to),
  }), [mode, models]);
  useEffect(() => {
    useModelModeFilter.setState({ allows: rules.allows });
  }, [rules]);
  useEffect(() => () => useModelModeFilter.setState({ allows: () => true }), []);
  return rules;
}
