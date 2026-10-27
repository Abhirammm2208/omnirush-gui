/** @jsxImportSource react */
import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

const registered = typeof globalThis.window === "undefined";
if (registered) GlobalRegistrator.register({ url: "http://localhost/" });
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
afterAll(async () => {
  if (registered) await GlobalRegistrator.unregister();
});

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { VoiceSettingsView } = await import("../src/react-app/domains/voice/voice-settings-view");
const { useVoiceSettings } = await import("../src/react-app/domains/voice/voice-settings");

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

async function renderWith(available: boolean | null, baseUrl: string) {
  const client = {
    baseUrl,
    getVoiceStatus: async () => ({ signedIn: true, available, reason: null, repo: null, branch: null }),
    voiceTranscriptionEndpoint: () => `${baseUrl}/voice`,
  };
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<VoiceSettingsView client={client as never} />);
    await tick();
    await tick();
  });
  const toggle = host.querySelector<HTMLElement>('[data-testid="voice-settings-enabled"]');
  const result = {
    text: host.textContent ?? "",
    checked: toggle?.getAttribute("aria-checked") ?? toggle?.getAttribute("data-checked"),
    disabled: toggle?.hasAttribute("disabled") || toggle?.getAttribute("aria-disabled") === "true" || toggle?.hasAttribute("data-disabled"),
  };
  await act(async () => root.unmount());
  host.remove();
  return result;
}

describe("voice settings dictation switch", () => {
  test("unavailable on the account: the switch shows off and locked, the saved choice stays on", async () => {
    useVoiceSettings.getState().update({ enabled: true });
    const r = await renderWith(false, "http://voice-off.test");
    expect(r.text).toContain("isn't available on your account");
    expect(r.checked).toBe("false");
    expect(r.disabled).toBe(true);
    expect(useVoiceSettings.getState().enabled).toBe(true);
  });

  test("available: the switch follows the saved choice", async () => {
    useVoiceSettings.getState().update({ enabled: true });
    const r = await renderWith(true, "http://voice-on.test");
    expect(r.checked).toBe("true");
    expect(r.disabled).toBe(false);
  });
});
