import { describe, expect, test } from "bun:test";

import type { ModelRef } from "../src/app/types";
import { projectModelPrefs, splitProjectModelUpdate } from "../src/react-app/shell/project-model-prefs";

const appDefault = { providerID: "omnirush", modelID: "gpt-6-astra" };
const pickInA = { providerID: "omnirush", modelID: "gpt-6.1-sol" };
const ownOfB = { providerID: "omnirush", modelID: "kimi-k3.1-pro" };

function prefs(): { showThinking: boolean; modelVariant: string | null; defaultModel: ModelRef | null } {
  return { showThinking: false, modelVariant: null, defaultModel: appDefault };
}

describe("project model picks", () => {
  test("a pick in project A stays A's: a new chat in project B gets the app default, or B's own pick", () => {
    const app = prefs();
    // Picking in A, as the route's model handlers do through setPrefs.
    const seenInA = projectModelPrefs(app, null);
    const split = splitProjectModelUpdate(seenInA, { ...seenInA, defaultModel: pickInA, modelVariant: "high" }, app);
    expect(split.own).toEqual({ model: pickInA, variant: "high" });
    expect(split.app.defaultModel).toEqual(appDefault);
    expect(split.app.modelVariant).toBeNull();

    expect(projectModelPrefs(split.app, split.own).defaultModel).toEqual(pickInA);
    expect(projectModelPrefs(split.app, null).defaultModel).toEqual(appDefault);
    expect(projectModelPrefs(split.app, { model: ownOfB, variant: null }).defaultModel).toEqual(ownOfB);
  });

  test("other preference changes pass through and leave the project's pick alone", () => {
    const app = prefs();
    const seen = projectModelPrefs(app, { model: ownOfB, variant: "low" });
    const split = splitProjectModelUpdate(seen, { ...seen, showThinking: true }, app);
    expect(split.own).toBeNull();
    expect(split.app.showThinking).toBe(true);
    expect(split.app.defaultModel).toEqual(appDefault);
  });
});
