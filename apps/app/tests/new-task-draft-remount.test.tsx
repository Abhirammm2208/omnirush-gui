/** @jsxImportSource react */
import { expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { createRequire } from "node:module";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";

import type { NewTaskComposerContext } from "../src/react-app/domains/session/chat/new-task-composer";

function context(workspaceId: string): NewTaskComposerContext {
  return {
    client: null,
    workspaceId,
    draftOwnerKey: `owner:${workspaceId}`,
    draftScope: "local",
    selectedModel: { providerID: "test", modelID: "test-model" },
    modelPickerOpen: false,
    onModelPickerOpenChange: () => {},
    onModelChange: () => {},
    modelVariantLabel: "Default",
    modelVariant: null,
    onModelVariantChange: () => {},
    agentLabel: "OmniRush.ai",
    selectedAgent: null,
    listAgents: async () => [],
    onSelectAgent: () => {},
    listCommands: async () => [],
    searchFiles: async () => [],
    isRemoteWorkspace: false,
    isSandboxWorkspace: false,
  };
}

test("the new-task draft survives a remount of the composer and a send that fails after it", async () => {
  const require = createRequire(import.meta.url);
  // Bun's isolated test loader cycles Lexical's ESM entries; use their real CJS entries (composer-focus-continuity.test.tsx).
  for (const moduleId of [
    "lexical",
    "@lexical/react/LexicalComposer.js",
    "@lexical/react/LexicalPlainTextPlugin.js",
    "@lexical/react/LexicalContentEditable.js",
    "@lexical/react/LexicalErrorBoundary.js",
    "@lexical/react/LexicalOnChangePlugin.js",
    "@lexical/react/LexicalHistoryPlugin.js",
    "@lexical/react/LexicalComposerContext.js",
  ]) {
    const moduleExports = require(moduleId);
    mock.module(moduleId, () => moduleExports);
  }
  const registeredDom = typeof globalThis.window === "undefined" || typeof globalThis.document === "undefined";
  if (registeredDom) GlobalRegistrator.register({ url: "http://localhost/" });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  mock.module("@/components/model-select", () => ({ ModelSelect: () => null }));
  mock.module("@/react-app/domains/session/surface/composer/workspace-run-mode-menu", () => ({ WorkspaceRunModeMenu: () => null }));
  mock.module("@/react-app/domains/session/surface/composer/full-permissions-toggle", () => ({ FullPermissionsToggle: () => null }));
  mock.module("@/react-app/domains/session/surface/composer/subagent-model-menu", () => ({ SubagentModelMenu: () => null }));
  window.localStorage.clear();
  const [{ LocalProvider }, { ShellConfigProvider }, { NewTaskComposer }] = await Promise.all([
    import("../src/react-app/kernel/local-provider"),
    import("../src/react-app/shell/shell-config"),
    import("../src/react-app/domains/session/chat/new-task-composer"),
  ]);

  let creation = Promise.withResolvers<void>();
  let typeDraft = (_text: string) => {};
  let openWorkspace = (_id: string) => {};
  function Hero() {
    // Like SessionEmptyHero: the draft is plain component state, gone when it remounts.
    const [text, setText] = useState("");
    const [workspaceId, setWorkspaceId] = useState("ws-b");
    typeDraft = setText;
    openWorkspace = setWorkspaceId;
    return <NewTaskComposer draft={text} onDraftChange={setText} busy={false} context={context(workspaceId)} onRunTask={() => creation.promise} />;
  }
  const container = document.createElement("div");
  document.body.append(container);
  let root: Root = createRoot(container);
  const editorText = () => container.querySelector('[data-lexical-editor="true"]')?.textContent ?? null;
  const remount = async () => {
    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => root.render(<LocalProvider><ShellConfigProvider><Hero /></ShellConfigProvider></LocalProvider>));
  };
  try {
    await act(async () => root.render(<LocalProvider><ShellConfigProvider><Hero /></ShellConfigProvider></LocalProvider>));
    await act(async () => typeDraft("Half typed prompt"));
    // The sandbox card (or a restart) swaps the tree the composer sits in.
    await remount();
    expect(editorText()).toBe("Half typed prompt");

    // Another project starts empty and does not take this draft; coming back brings it again.
    await act(async () => openWorkspace("ws-c"));
    expect(editorText()).toBe("");
    await act(async () => openWorkspace("ws-b"));
    expect(editorText()).toBe("Half typed prompt");

    // Sent, the composer is replaced while the chat is being created, and the creation fails: the prompt is not lost.
    await act(async () => {
      const button = container.querySelector<HTMLButtonElement>('button[aria-label="Run task"]');
      if (!button || button.disabled) throw new Error(`Expected an enabled send button: ${container.textContent}`);
      button.click();
    });
    expect(editorText()).toBe("");
    await remount();
    await act(async () => creation.reject(new Error("engine restarting")));
    expect(editorText()).toBe("Half typed prompt");

    // A send that creates its chat clears the stored draft.
    creation = Promise.withResolvers<void>();
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Run task"]')?.click();
    });
    await act(async () => creation.resolve());
    await remount();
    expect(editorText()).toBe("");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    window.localStorage.clear();
    mock.restore();
    if (registeredDom) await GlobalRegistrator.unregister();
  }
});
