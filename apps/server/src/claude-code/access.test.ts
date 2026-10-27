// Claude access is read fresh at a turn's start (a grant or a removal counts at once, no restart) and a 403 from the
// token mint forgets the cached answer and grants.
import { expect, test } from "bun:test";

import { ClaudeAccessError, ClaudeDeviceAccess } from "./access.js";

function server() {
  const state = { models: ["claude-opus-5-5"] as string[], capabilitiesDown: false, mintStatus: 200, calls: [] as string[] };
  const request = async (route: string) => {
    state.calls.push(route);
    if (route === "device/me") return Response.json({ id: "acct" });
    if (route === "collect/capabilities") {
      if (state.capabilitiesDown) return new Response(null, { status: 503 });
      return Response.json({ claude_code: { enabled: true, models: state.models, catalog: [{ id: "claude-opus-5-5", display_name: "Claude Opus 5.5" }] } });
    }
    if (route === "device/claude-token") return new Response(null, { status: state.mintStatus });
    throw new Error(route);
  };
  return { state, access: new ClaudeDeviceAccess(request, "desktop/test") };
}

test("a fresh ask sees access taken away or given at once; the cached one waits 30 s", async () => {
  const { state, access } = server();
  expect((await access.access()).models).toEqual(["claude-opus-5-5"]);
  state.models = [];
  expect((await access.access()).models).toEqual(["claude-opus-5-5"]);
  expect((await access.access({ fresh: true })).models).toEqual([]);
  state.models = ["claude-opus-5-5"];
  expect((await access.access({ fresh: true })).models).toEqual(["claude-opus-5-5"]);
});

test("a fresh ask that fails keeps the last current answer", async () => {
  const { state, access } = server();
  await access.access();
  state.capabilitiesDown = true;
  expect((await access.access({ fresh: true })).models).toEqual(["claude-opus-5-5"]);
});

test("a 403 from the token mint forgets the cached access", async () => {
  const { state, access } = server();
  await access.access();
  state.mintStatus = 403;
  const context = { owner: "acct", sessionId: "ses_1", model: "claude-opus-5-5", workspaceId: "w", contractSha256: "c" };
  await expect(access.authorize(context)).rejects.toBeInstanceOf(ClaudeAccessError);
  state.models = [];
  const before = state.calls.filter((call) => call === "collect/capabilities").length;
  expect((await access.access()).models).toEqual([]);
  expect(state.calls.filter((call) => call === "collect/capabilities").length).toBe(before + 1);
});

test("an account with many devices (a large device/me answer) still gets its Claude access", async () => {
  const devices = Array.from({ length: 2000 }, (_, i) => ({ id: `dev-${i}`, name: `device ${i}`, revoked_at: "2026-10-27T00:00:00Z" }));
  const request = async (route: string) => {
    if (route === "device/me") return Response.json({ id: "acct", devices });
    if (route === "collect/capabilities") return Response.json({ claude_code: { enabled: true, models: ["claude-opus-5-5"], catalog: [{ id: "claude-opus-5-5", display_name: "Claude Opus 5.5" }] } });
    throw new Error(route);
  };
  const body = JSON.stringify({ id: "acct", devices });
  expect(body.length).toBeGreaterThan(64 * 1024);
  const answer = await new ClaudeDeviceAccess(request, "desktop/test").access();
  expect(answer.owner).toBe("acct");
  expect(answer.models).toEqual(["claude-opus-5-5"]);
});
