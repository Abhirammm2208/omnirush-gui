// A model picked in a project stays that project's: a new chat in another
// project starts on that project's own pick, else on the app default
// (Settings), never on the pick last made elsewhere.
import { useCallback, useMemo } from "react";

import type { LocalPreferences, useLocal } from "@/react-app/kernel/local-provider";
import { useSessionModelStore, type SessionModelSelection } from "@/react-app/domains/session/surface/session-model-store";

type LocalValue = ReturnType<typeof useLocal>;

/** The project's pick lives in the per-chat model memory under this stand-in id. */
export function projectModelKey(workspaceId: string): string {
  return `project:${workspaceId}`;
}

/** Remember `selection` as the project's own pick. */
export function rememberProjectModel(workspaceId: string, selection: SessionModelSelection): void {
  const store = useSessionModelStore.getState();
  store.setModel(projectModelKey(workspaceId), selection.model, selection.variant);
  store.setVariant(projectModelKey(workspaceId), selection.variant);
}

/** The app preferences as a project sees them: its own pick over the app default. */
type ModelPrefs = Pick<LocalPreferences, "defaultModel" | "modelVariant">;

export function projectModelPrefs<P extends ModelPrefs>(prefs: P, own: SessionModelSelection | null): P {
  return own ? { ...prefs, defaultModel: own.model, modelVariant: own.variant } : prefs;
}

/** A route update split in two: a model or effort change is the project's own pick, everything else the app's. */
export function splitProjectModelUpdate<P extends ModelPrefs>(
  seen: P,
  next: P,
  app: P,
): { app: P; own: SessionModelSelection | null } {
  const sameModel = next.defaultModel?.providerID === seen.defaultModel?.providerID
    && next.defaultModel?.modelID === seen.defaultModel?.modelID;
  const changed = !sameModel || (next.modelVariant ?? null) !== (seen.modelVariant ?? null);
  return {
    app: { ...next, defaultModel: app.defaultModel, modelVariant: app.modelVariant },
    own: changed && next.defaultModel ? { model: next.defaultModel, variant: next.modelVariant ?? null } : null,
  };
}

/** `useLocal()` for the session route, scoped to the open project's model pick. */
export function useProjectModelLocal(app: LocalValue, workspaceId: string): LocalValue {
  const key = workspaceId ? projectModelKey(workspaceId) : "";
  const own = useSessionModelStore((state) => (key ? state.bySessionId[key] ?? null : null));
  const prefs = useMemo(() => projectModelPrefs(app.prefs, own), [app.prefs, own]);
  const setAppPrefs = app.setPrefs;
  const setPrefs = useCallback((updater: (previous: LocalPreferences) => LocalPreferences) => {
    if (!key) {
      setAppPrefs(updater);
      return;
    }
    setAppPrefs((previous) => {
      const seen = projectModelPrefs(previous, useSessionModelStore.getState().bySessionId[key] ?? null);
      const split = splitProjectModelUpdate(seen, updater(seen), previous);
      // Not inside React's state update: the model store is another store.
      const own = split.own;
      if (own) queueMicrotask(() => rememberProjectModel(workspaceId, own));
      return split.app;
    });
  }, [key, setAppPrefs, workspaceId]);
  return useMemo(() => ({ ...app, prefs, setPrefs }), [app, prefs, setPrefs]);
}
