/**
 * The quota wrap (handoff) on the 2.x engine, run by the server: the 1.x plugin
 * (opencode-plugins/omnirush-budget-wrap.ts) read the gateway's wrap headers in
 * the engine process; on 2.x the server's own gateway broker sees every model
 * response, so the same rules (budget-wrap-rules.ts, shared with the CLI) run
 * here. Asked only while the chat is idle, once per offer; an accepted offer
 * compacts the chat (its compaction request is marked as the wrap); a failed
 * wrap becomes a notice with a retry, never the question again.
 */
import { pathToFileURL } from "node:url";

import { omnirushPluginPath } from "./omnirush-extensions-plugin-path.js";

type WrapRules = typeof import("./opencode-plugins/budget-wrap-rules.js");
// The shared rules (PARITY with the CLI) ship beside the engine plugins, outside the app archive.
let rules: Promise<WrapRules> | undefined;
const wrapRules = () => (rules ??= import(pathToFileURL(omnirushPluginPath("budget-wrap-rules")).href) as Promise<WrapRules>);

const REQUIRED_HEADER = "x-omnirush-wrap-required";
const WRAP_UP_HEADER = "x-omnirush-wrap-up";
const OFFER_HEADER = "x-omnirush-wrap-offer-id";
const SCOPES_HEADER = "x-omnirush-wrap-scopes";
/** How long a failed wrap's Retry stays available (the window's notice). */
const RETRY_WINDOW_MS = 30_000;
const MAX_TRACKED = 256;

type Offer = { id: string; scopes: string; watching: boolean; inFlight: boolean; approved: boolean; failedAt?: number };

export type BudgetWrapDeps = {
  /** The desktop window's answer to a wrap query (ui-control `query`): "pending", "accept", "decline", "done", "failed" or "unavailable". */
  control(id: string, args: Record<string, string>): Promise<string>;
  /** Whether the chat runs a turn now; null when the engine cannot say. */
  busy(sessionId: string): Promise<boolean | null>;
  /** Compacts the chat on the 2.x engine; resolves once its compaction completed (throws otherwise). */
  compact(sessionId: string): Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  idleSettleMs?: number;
  pollMs?: number;
};

export function createV2BudgetWrap(deps: BudgetWrapDeps) {
  const pending = new Map<string, Offer>();
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? Date.now;
  const update = (sessionId: string, entry: Offer, operation: string) =>
    deps.control("budget.wrap.update", { sessionID: sessionId, offerID: entry.id, scopes: entry.scopes, operation }).catch(() => "unavailable");

  async function compact(sessionId: string, entry: Offer): Promise<void> {
    entry.inFlight = true;
    entry.approved = true;
    let ok = false;
    try {
      await deps.compact(sessionId);
      ok = true;
    } catch {
      ok = false;
    }
    if ((await wrapRules()).wrapFinished({ ok, compacted: ok })) {
      await update(sessionId, entry, "finish");
      pending.delete(sessionId);
      return;
    }
    entry.approved = false;
    entry.inFlight = false;
    entry.failedAt = now();
    await update(sessionId, entry, "fail");
  }

  /** While the chat is idle: ask, and wrap once accepted (the 1.x plugin's watch loop). */
  async function watch(sessionId: string): Promise<void> {
    const entry = pending.get(sessionId);
    if (!entry || entry.watching || entry.inFlight) return;
    entry.watching = true;
    try {
      // The turn that carried the offer ends first; a prompt queued behind it gets a moment to start.
      while ((await deps.busy(sessionId)) !== false) {
        if (pending.get(sessionId) !== entry) return;
        await sleep(deps.pollMs ?? 1_000);
      }
      await sleep(deps.idleSettleMs ?? 600);
      while (pending.get(sessionId) === entry && !entry.inFlight && (await deps.busy(sessionId)) === false) {
        const offered = await update(sessionId, entry, "offer");
        if (offered === "decline" || offered === "done") { pending.delete(sessionId); break; }
        if (offered === "failed" && now() - (entry.failedAt ?? 0) > RETRY_WINDOW_MS) { pending.delete(sessionId); break; }
        if ((await wrapRules()).startWrapNow({ choice: offered, busy: false, inFlight: entry.inFlight })) { await compact(sessionId, entry); continue; }
        await sleep(3_000);
      }
      if (pending.get(sessionId) === entry && !entry.inFlight) void update(sessionId, entry, "hold");
    } finally {
      entry.watching = false;
    }
  }

  return {
    /** A model response the broker forwarded for `sessionId`. */
    noteResponse(sessionId: string, headers: Headers): void {
      const current = pending.get(sessionId);
      if (headers.get(WRAP_UP_HEADER) === "1") return;
      if (headers.get(REQUIRED_HEADER) !== "1") {
        if (current && !current.inFlight) {
          pending.delete(sessionId);
          void update(sessionId, current, "clear");
        }
        return;
      }
      const id = headers.get(OFFER_HEADER) || `legacy:${headers.get(SCOPES_HEADER) ?? ""}`;
      // An offer replaces the previous one only when it is a new offer (budget-wrap-rules.ts replacesWrapOffer).
      if ((current && current.id === id) || current?.inFlight) return;
      if (current) void update(sessionId, current, "clear");
      pending.delete(sessionId);
      pending.set(sessionId, { id, scopes: headers.get(SCOPES_HEADER) || "token", watching: false, inFlight: false, approved: false });
      while (pending.size > MAX_TRACKED) pending.delete(pending.keys().next().value as string);
      void watch(sessionId);
    },
    /** Whether a compaction request of `sessionId` is an accepted wrap (the gateway holds it as the wrap). */
    contextWrap(sessionId: string): boolean {
      return pending.get(sessionId)?.approved === true;
    },
  };
}
