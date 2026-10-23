/** @jsxImportSource react */
// Computer use, findable: the Settings card (status, "Use my own screen", the account's yes) and the hint above
// the composer when a draft asks for something on a screen. The agent's own display needs nothing from the
// person; their own screen needs this computer's switch AND the account's yes, which only the web console sets.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, MousePointer2, X } from "lucide-react";

import type { ComputerUseRealScreen } from "@omnirush/types/desktop-ipc";

import { desktopBridge, openDesktopUrl } from "@/app/lib/desktop";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";

import { useComputerUseStatus } from "./status-store";

/** Mirrors ACCOUNT_REAL_SCREEN_URL in apps/server/src/computer-use/shared/policy.mjs. */
export const ACCOUNT_REAL_SCREEN_URL = "https://omnirush.ai/console/account#computer-use";
/** Mirrors SCREEN_INTENT in apps/server/src/computer-use/shared/policy.mjs (setup.test.ts compares them). */
export const SCREEN_INTENT = /(?:^|[.,;!]\s*|\b(?:and|then|please|to)\s+)(?:double[- ])?click\b|\b(?:my (?:browser|screen|desktop|mouse|computer)|(?:use|open|launch|start) (?:the |a |my )?(?:browser|chrome|firefox|edge|safari|app|application|program)|screenshot|computer use|take over my|fill (?:in|out) (?:the |this )?form)\b/i;
export const screenIntent = (text: string) => SCREEN_INTENT.test(text);

export const COMPUTER_USE_TITLE = "Computer use";
export const COMPUTER_USE_ON = "On. The agent works on its own display, with its own cursor and browser, and never asks for approval there.";
export const OWN_SCREEN_HELP = "Off by default. When on, the agent can also click and type in the apps on your screen, without asking. Stop it any time with Stop.";
export const ACCOUNT_NEEDED = "Your account must allow it too. The app can't turn that on: it opens your account page, where you switch on “Let the agent use my real screen”, then come back here.";

const REAL_SCREEN_KEY = ["computer-use", "real-screen"];

/** The status, this computer's own-screen switch and the account's yes, and the one-click way to turn both on. */
export function useComputerUseSetup(active = true) {
  const status = useComputerUseStatus();
  const queryClient = useQueryClient();
  const enabled = status?.enabled === true;
  const realScreen = useQuery({
    queryKey: REAL_SCREEN_KEY,
    queryFn: async (): Promise<ComputerUseRealScreen> => desktopBridge.getComputerUseRealScreen(),
    enabled: active && enabled,
    retry: false,
    staleTime: 30_000,
    // Back from the account page: read the account's yes again.
    refetchOnWindowFocus: true,
  });
  const setOn = useMutation({
    mutationFn: async (on: boolean) => desktopBridge.setComputerUseRealScreen(on),
    onSuccess: (next) => queryClient.setQueryData(REAL_SCREEN_KEY, next),
  });
  /** This computer's switch on, then the account page when the account has not said yes. */
  const turnOn = async () => {
    let now = realScreen.data ?? (await desktopBridge.getComputerUseRealScreen());
    if (!now.on && !now.forced) now = await setOn.mutateAsync(true);
    if (!now.allowed) await openDesktopUrl(ACCOUNT_REAL_SCREEN_URL);
  };
  const ownScreenReady = realScreen.data?.on === true && realScreen.data.allowed;
  return { status, enabled, realScreen, setOn, turnOn, ownScreenReady };
}

function statusLine(status: ReturnType<typeof useComputerUseStatus>) {
  if (!status) return "Checking…";
  if (status.enabled) return COMPUTER_USE_ON;
  return status.message ?? "Computer use is not turned on for your account yet.";
}

function modelsLine(models: string[] | null | undefined) {
  return models?.length ? `Works with ${models.join(", ")}. Pick one of them in the chat.` : null;
}

/** Settings > General > Computer use. */
export function ComputerUseSettingsCard() {
  const setup = useComputerUseSetup();
  const data = setup.realScreen.data;
  const [error, setError] = useState<string | null>(null);
  const run = (action: () => Promise<unknown>) => { setError(null); action().catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "That did not work. Try again.")); };
  return (
    <div className="space-y-3" data-computer-use-settings>
      <div className="text-[11px] font-semibold uppercase tracking-[0.15em] text-dls-secondary">{COMPUTER_USE_TITLE}</div>
      <div className="space-y-3 rounded-2xl border border-dls-border bg-dls-surface p-4">
        <div className="flex items-center gap-4">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-dls-border bg-dls-hover">
            <MousePointer2 size={17} className="text-dls-secondary" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-medium text-dls-text">{COMPUTER_USE_TITLE}</div>
            <div className="text-[11px] text-dls-secondary" role="status" data-computer-use-status>{statusLine(setup.status)}</div>
            {setup.enabled && modelsLine(setup.status?.models) ? <div className="text-[11px] text-dls-secondary">{modelsLine(setup.status?.models)}</div> : null}
          </div>
        </div>
        {setup.enabled ? (
          <div className="flex items-start gap-4 border-t border-dls-border pt-3">
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-medium text-dls-text">Use my own screen</div>
              <div id="computer-use-own-screen-help" className="text-[11px] text-dls-secondary">
                {data?.forced ? "Set by the OMNIRUSH_COMPUTER_USE_REAL_SCREEN environment variable." : OWN_SCREEN_HELP}
              </div>
              {data && !data.allowed ? (
                <div className="mt-2 space-y-2">
                  <div className="text-[11px] text-dls-secondary" data-computer-use-account>{ACCOUNT_NEEDED}</div>
                  <Button type="button" variant="outline" size="xs" onClick={() => run(setup.turnOn)} data-computer-use-allow>
                    <ExternalLink data-icon="inline-start" />
                    Allow in my account
                  </Button>
                </div>
              ) : null}
              {error ? <div className="mt-1 text-[11px] text-red-11" role="alert">{error}</div> : null}
            </div>
            <Switch
              aria-label="Use my own screen"
              aria-describedby="computer-use-own-screen-help"
              checked={data?.on === true}
              disabled={!data || data.forced || setup.setOn.isPending}
              onCheckedChange={(on: boolean) => run(() => setup.setOn.mutateAsync(on))}
              data-computer-use-real-screen
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}

// "Not now": hidden for the rest of this launch.
let hintDismissed = false;

/** Above the composer, while the draft asks for something on a screen and the person's own screen is not ready. */
export function useComputerUseHint(draft: string) {
  const intent = !hintDismissed && screenIntent(draft);
  const setup = useComputerUseSetup(intent);
  const [, rerender] = useState(0);
  if (!intent || !setup.status || setup.ownScreenReady) return null;
  if (setup.enabled && !setup.realScreen.data) return null;
  const dismiss = () => { hintDismissed = true; rerender((n) => n + 1); };
  const data = setup.realScreen.data;
  const message = !setup.enabled
    ? statusLine(setup.status)
    : "The agent can already do this on its own display, with its own browser and cursor. To let it use your screen and apps, turn on your own screen.";
  const action = setup.enabled ? (data?.allowed ? "Use my own screen" : "Allow in my account") : null;
  return (
    <div className="mb-2 flex items-start gap-3 rounded-xl border border-dls-border bg-dls-surface px-3 py-2" role="status" data-computer-use-hint>
      <MousePointer2 size={15} className="mt-0.5 shrink-0 text-dls-secondary" />
      <div className="min-w-0 flex-1 text-[12px] text-dls-text">
        <div className="font-medium">{COMPUTER_USE_TITLE}</div>
        <div className="text-dls-secondary">{message}</div>
        {action && !data?.allowed ? <div className="mt-0.5 text-[11px] text-dls-secondary">Opens your account page; come back here when it's on.</div> : null}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {action ? (
          <Button type="button" variant="outline" size="xs" onClick={() => void setup.turnOn().catch(() => undefined)} data-computer-use-hint-action>
            {data?.allowed ? null : <ExternalLink data-icon="inline-start" />}
            {action}
          </Button>
        ) : null}
        <Button type="button" variant="ghost" size="icon-xs" aria-label="Not now" onClick={dismiss}>
          <X />
        </Button>
      </div>
    </div>
  );
}
