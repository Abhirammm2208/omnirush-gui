// The desktop's side of automatic compaction (session-archive/auto-compact.ts,
// shared with the CLI): one chat's engine calls through the proxy's engine
// target, and the server's policy read from /collect/capabilities.

import { autoCompactPolicy, type AutoCompactEngine, type AutoCompactPolicy, type ModelRef } from "./session-archive/auto-compact.js";
import { buildOpencodeProxyUrl, projectArchiveEngineReads, type EngineTarget } from "./session-upload-observer.js";
import { loopbackFetch } from "./server-fetch.js";
import type { TraceCapabilities } from "./session-uploader.js";
import { assertEngineStartedWithinLock, assertProviderAllowed } from "./provider-lock.js";
import { v1View } from "./engine-v2-view.js";

/** How long an answer of the server counts for an ordinary prompt; a due compaction asks again. */
export const POLICY_MAX_AGE_MS = 60_000;
const FRESH_WAIT_MS = 4_000;

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

/** The engine `target` for `sessionId` (a 2.x engine: opencodeV2AutoCompactEngine). */
export function desktopAutoCompactEngine(target: EngineTarget, sessionId: string, fetchImpl: Fetch = loopbackFetch): AutoCompactEngine {
  if (target.engine === "v2") return opencodeV2AutoCompactEngine(target, sessionId, fetchImpl);
  const reads = projectArchiveEngineReads(target, sessionId);
  return {
    messages: () => reads.messages(),
    session: () => reads.session(),
    async busy() {
      const response = await fetchImpl(buildOpencodeProxyUrl(target.baseUrl, "/session/status", target.search), {
        headers: new Headers(target.headers),
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) { await response.body?.cancel().catch(() => undefined); return null; }
      const statuses = (await response.json()) as Record<string, { type?: string } | undefined>;
      const type = statuses?.[sessionId]?.type ?? "idle";
      return type === "busy" || type === "retry";
    },
    async summarize(model: ModelRef, signal: AbortSignal) {
      // The same checks as a prompt (provider-lock.ts): an allowed provider, on an engine that started under the lock.
      assertProviderAllowed(model.providerID);
      assertEngineStartedWithinLock(target.baseUrl, "POST", `/session/${encodeURIComponent(sessionId)}/summarize`);
      const headers = new Headers(target.headers);
      headers.set("content-type", "application/json");
      const response = await fetchImpl(buildOpencodeProxyUrl(target.baseUrl, `/session/${encodeURIComponent(sessionId)}/summarize`, target.search), {
        method: "POST",
        headers,
        body: JSON.stringify({ providerID: model.providerID, modelID: model.modelID }),
        signal,
      });
      const text = await response.text().catch(() => "");
      if (!response.ok) throw new Error(`summarize answered ${response.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
    },
    async removeMessage(messageID: string) {
      const response = await fetchImpl(buildOpencodeProxyUrl(target.baseUrl, `/session/${encodeURIComponent(sessionId)}/message/${encodeURIComponent(messageID)}`, target.search), {
        method: "DELETE",
        headers: new Headers(target.headers),
        signal: AbortSignal.timeout(10_000),
      });
      await response.body?.cancel().catch(() => undefined);
      if (!response.ok && response.status !== 404) throw new Error(`message delete answered ${response.status}`);
    },
    async abort() {
      const response = await fetchImpl(buildOpencodeProxyUrl(target.baseUrl, `/session/${encodeURIComponent(sessionId)}/abort`, target.search), {
        method: "POST",
        headers: new Headers(target.headers),
        signal: AbortSignal.timeout(10_000),
      });
      await response.body?.cancel().catch(() => undefined);
    },
  };
}

/**
 * The same calls on the 2.x engine (the CLI's way): its running sessions,
 * POST /api/session/:id/compact (the engine summarizes on the chat's own
 * model; the call waits until the compaction message it created completed or
 * failed), /interrupt. The chat's messages go to the shared module as their
 * 1.x view (engine-v2-view.ts). No message delete: a compaction still queued
 * is cancelled from the inbox; one already delivered is the engine's record and stays.
 */
function opencodeV2AutoCompactEngine(target: EngineTarget, sessionId: string, fetchImpl: Fetch): AutoCompactEngine {
  const reads = projectArchiveEngineReads(target, sessionId);
  const session = `/api/session/${encodeURIComponent(sessionId)}`;
  const call = (path: string, init: RequestInit) => fetchImpl(buildOpencodeProxyUrl(target.baseUrl, path, target.search), { ...init, headers: new Headers(target.headers) });
  return {
    messages: async () => { const list = await reads.messages(); return Array.isArray(list) ? v1View(list, sessionId) : list; },
    session: () => reads.session(),
    async busy() {
      const response = await call("/api/session/active", { signal: AbortSignal.timeout(5_000) });
      if (!response.ok) { await response.body?.cancel().catch(() => undefined); return null; }
      const payload = (await response.json()) as { data?: unknown };
      const active = payload && typeof payload === "object" && "data" in payload ? payload.data : payload;
      return Boolean(active && typeof active === "object" && Object.hasOwn(active, sessionId));
    },
    async summarize(model: ModelRef, signal: AbortSignal) {
      assertProviderAllowed(model.providerID);
      assertEngineStartedWithinLock(target.baseUrl, "POST", `${session}/compact`);
      const response = await fetchImpl(buildOpencodeProxyUrl(target.baseUrl, `${session}/compact`, target.search), {
        method: "POST", headers: (() => { const headers = new Headers(target.headers); headers.set("content-type", "application/json"); return headers; })(), body: "{}", signal,
      });
      const text = await response.text().catch(() => "");
      if (!response.ok) throw new Error(`compact answered ${response.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
      let id: string | null = null;
      try { id = (JSON.parse(text) as { data?: { id?: string } }).data?.id ?? null; } catch { id = null; }
      if (!id) return;
      // The compaction message has the inbox item's id: done once it no longer runs.
      while (!signal.aborted) {
        const found = await call(`${session}/message?type=compaction&order=desc&limit=20`, { signal: AbortSignal.timeout(10_000) })
          .then(async (answer) => (answer.ok ? ((await answer.json()) as { data?: unknown }).data : null)).catch(() => null);
        const message = Array.isArray(found) ? (found as { id?: string; status?: string }[]).find((item) => item?.id === id) : undefined;
        if (message && message.status !== "running") {
          if (message.status !== "completed") throw new Error(`compaction ${message.status}`);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      throw new Error("compaction stopped");
    },
    async removeMessage(messageID: string) {
      const response = await call(`${session}/inbox/${encodeURIComponent(messageID.replace(/_summary$/, ""))}`, { method: "DELETE", signal: AbortSignal.timeout(10_000) });
      await response.body?.cancel().catch(() => undefined);
    },
    async abort() {
      const response = await call(`${session}/interrupt`, { method: "POST", signal: AbortSignal.timeout(10_000) });
      await response.body?.cancel().catch(() => undefined);
    },
  };
}

/**
 * The server's policy through the broker's capabilities cache: at most
 * POLICY_MAX_AGE_MS old for an ordinary prompt, asked again when `fresh`
 * (bounded). A failed ask keeps the last policy seen; none ever is off.
 */
export function brokerAutoCompactPolicy(read: (options: { strict: true; maxAgeMs: number }) => Promise<TraceCapabilities>) {
  let last: AutoCompactPolicy | null = null;
  return async ({ fresh }: { fresh: boolean }): Promise<AutoCompactPolicy | null> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const answer = await Promise.race([
      read({ strict: true, maxAgeMs: fresh ? 0 : POLICY_MAX_AGE_MS }).then((capabilities) => ({ capabilities }), () => null),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), FRESH_WAIT_MS); }),
    ]);
    clearTimeout(timer);
    if (answer) last = autoCompactPolicy(answer.capabilities);
    return last;
  };
}
