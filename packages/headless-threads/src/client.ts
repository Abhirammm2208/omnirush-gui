/**
 * A function-driven client for native OmniRush.ai threads.
 *
 * Every call goes to the 2.x engine's API through OmniRush.ai's workspace-scoped mount:
 *
 * - `POST /workspace/:id/opencode2/api/session` creates a thread
 * - native session reads provide messages and status (the 2.x engine has no todos)
 * - native prompt and interrupt calls control a turn
 *
 * The engine's 2.x messages are read in the wire shape below (`{info, parts}`, wire.ts); tool names
 * stay the engine's own.
 */
import { z } from "zod";

import { HeadlessThreadError } from "./errors.js";
import { assistantReplyForTurn, toTranscript } from "./transcript.js";
import type {
  CreateThreadInput,
  HeadlessAbortResult,
  HeadlessThread,
  HeadlessThreadClient,
  HeadlessThreadClientOptions,
  HeadlessThreadSnapshot,
  HeadlessThreadTranscript,
  HeadlessThreadTurnInput,
  HeadlessThreadWaitInput,
  HeadlessThreadWaitResult,
  HeadlessTurnAcceptance,
} from "./types.js";
import { nextCursorOf, v2MessagesToWire, v2SessionToWire } from "./v2.js";
import {
  abortResultSchema,
  isRunning,
  sessionSchema,
  threadMessagesSchema,
  threadSnapshotSchema,
  toSnapshot,
  toThread,
} from "./wire.js";

const DEFAULT_POLL_INTERVAL_MS = 500;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

const errorBodySchema = z
  .object({ code: z.string().optional(), message: z.string().optional() })
  .passthrough();

function settled<T>(result: PromiseSettledResult<T>): T {
  if (result.status === "rejected") throw result.reason;
  return result.value;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Scanned rather than matched with `/\/+$/`: the anchored form backtracks
 * quadratically on a long run of slashes, which CodeQL flags.
 */
function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === "/") end -= 1;
  return value.slice(0, end);
}

export function createHeadlessThreadClient(options: HeadlessThreadClientOptions): HeadlessThreadClient {
  const baseUrl = stripTrailingSlashes(options.baseUrl);
  const workspaceId = options.workspaceId;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const workspacePath = `/workspace/${encodeURIComponent(workspaceId)}`;
  const opencodePath = `${workspacePath}/opencode2/api`;

  function invalidCreatePayload(message: string): never {
    const path = `${opencodePath}/session`;
    throw new HeadlessThreadError({
      code: "invalid_payload",
      message,
      method: "POST",
      path,
      status: 400,
      body: { code: "invalid_payload", message },
    });
  }

  function createTitle(value: unknown): string {
    if (typeof value !== "string" || !value.trim()) {
      return invalidCreatePayload("title must be a non-empty string");
    }
    const title = value.trim();
    if (title.length > 120) return invalidCreatePayload("title must be 120 characters or fewer");
    return title;
  }

  function initialPrompt(value: unknown): string | undefined {
    if (value === undefined || value === null || value === "") return undefined;
    if (typeof value !== "string" || !value.trim()) {
      return invalidCreatePayload("prompt must be a non-empty string");
    }
    const prompt = value.trim();
    if (prompt.length > 100_000) return invalidCreatePayload("prompt must be 100000 characters or fewer");
    return prompt;
  }

  function requestSignal(signal?: AbortSignal): AbortSignal | undefined {
    const signals = [options.signal, signal].filter((item): item is AbortSignal => item !== undefined);
    if (requestTimeoutMs !== 0) signals.push(AbortSignal.timeout(requestTimeoutMs));
    return signals.length === 0 ? undefined : signals.length === 1 ? signals[0] : AbortSignal.any(signals);
  }

  type SdkResult<T> = {
    data?: T;
    error?: unknown;
    response?: Response;
    /** The whole answer (its `cursor` too). */
    payload?: unknown;
  };

  /** One call to the engine's API (`data` unwrapped), as the SDK reported it. */
  async function call(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<SdkResult<unknown>> {
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${options.token}`,
        ...(options.hostToken === undefined ? {} : { "X-OmniRush-Host-Token": options.hostToken }),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "error",
      signal: requestSignal(signal),
    });
    } catch (error) {
      return { error: { message: error instanceof Error ? error.message : String(error) } };
    }
    const text = await response.text();
    let payload: unknown = undefined;
    try { payload = text ? JSON.parse(text) : undefined; } catch { payload = text; }
    if (!response.ok) return { error: payload ?? {}, response };
    const data = payload !== null && typeof payload === "object" && "data" in payload ? (payload as { data: unknown }).data : payload;
    return { data, response, payload };
  }

  function sdkSuccess<T>(result: SdkResult<T>, method: string, path: string): T | undefined {
    if (result.error === undefined) return result.data;
    const detail = errorBodySchema.safeParse(result.error);
    throw new HeadlessThreadError({
      code: detail.success && detail.data.code !== undefined ? detail.data.code : "request_failed",
      message: detail.success && detail.data.message !== undefined
        ? detail.data.message
        : result.response
          ? `OmniRush.ai returned ${result.response.status} for ${method} ${path}`
          : `OmniRush.ai request failed for ${method} ${path}`,
      method,
      path,
      ...(result.response === undefined ? {} : { status: result.response.status }),
      body: result.error,
    });
  }

  function sdkJson<T>(schema: z.ZodType<T>, result: SdkResult<unknown>, method: string, path: string): T {
    const parsed = schema.safeParse(sdkSuccess(result, method, path));
    if (parsed.success) return parsed.data;
    throw new HeadlessThreadError({
      code: "invalid_response",
      message: `OmniRush.ai returned an unexpected payload for ${method} ${path}`,
      method,
      path,
      ...(result.response === undefined ? {} : { status: result.response.status }),
      body: parsed.error.issues,
    });
  }

  /** The thread's messages, oldest first, in the wire shape (every page; `limit`: the newest that many). */
  async function readMessages(threadId: string, signal?: AbortSignal, limit?: number) {
    const path = `${opencodePath}/session/${encodeURIComponent(threadId)}/message`;
    const out: unknown[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 200; page += 1) {
      const query = new URLSearchParams({ limit: "200", ...(cursor ? { cursor } : { order: "desc" }) });
      const result = await call("GET", `${path}?${query}`, undefined, signal);
      const data = sdkSuccess(result, "GET", path);
      const items = Array.isArray(data) ? data : [];
      out.push(...items);
      cursor = nextCursorOf(result.payload);
      if (!cursor || items.length === 0 || (limit !== undefined && out.length >= limit)) break;
    }
    const wire = v2MessagesToWire(out.reverse());
    return sdkJson(threadMessagesSchema, { data: limit === undefined ? wire : wire.slice(-limit) }, "GET", path);
  }

  async function getThreadSnapshot(threadId: string, input?: { signal?: AbortSignal; limit?: number }): Promise<HeadlessThreadSnapshot> {
    const sessionPath = `${opencodePath}/session/${encodeURIComponent(threadId)}`;
    const statusPath = `${opencodePath}/session/active`;
    const [sessionRead, messagesRead, statusRead] = await Promise.allSettled([
      call("GET", sessionPath, undefined, input?.signal),
      readMessages(threadId, input?.signal, input?.limit),
      call("GET", statusPath, undefined, input?.signal),
    ]);
    // The session's own failure is reported first (it says the most: a missing thread).
    const sessionResult = settled(sessionRead);
    if (sessionResult.error !== undefined) sdkSuccess(sessionResult, "GET", sessionPath);
    const messages = settled(messagesRead);
    const statusResult = settled(statusRead);
    const session = sdkJson(sessionSchema, { ...sessionResult, data: v2SessionToWire(sessionResult.data) }, "GET", sessionPath);
    const active = sdkSuccess(statusResult, "GET", statusPath);
    const running = active !== null && typeof active === "object" && Object.hasOwn(active, threadId);
    return toSnapshot(threadSnapshotSchema.parse({
      session,
      messages,
      todos: [],
      status: running ? { type: "busy" } : { type: "idle" },
    }));
  }

  async function createThread(input: CreateThreadInput): Promise<HeadlessThread> {
    const model = input.model ?? options.defaultModel;
    const createPath = `${opencodePath}/session`;
    const prompt = initialPrompt(input.prompt);
    const created = await call("POST", createPath, {
      title: createTitle(input.title),
      ...(model === undefined ? {} : { model: { id: model.modelId, providerID: model.providerId, ...(model.variant === undefined ? {} : { variant: model.variant }) } }),
    }, input.signal);
    const session = sdkJson(sessionSchema, { ...created, data: v2SessionToWire(created.data) }, "POST", createPath);
    if (prompt !== undefined) {
      const promptPath = `${opencodePath}/session/${encodeURIComponent(session.id)}/prompt`;
      sdkSuccess(await call("POST", promptPath, { text: prompt }, input.signal), "POST", promptPath);
    }
    return toThread(session, workspaceId, prompt !== undefined);
  }

  async function sendTurn(threadId: string, input: HeadlessThreadTurnInput): Promise<HeadlessTurnAcceptance> {
    const model = input.model ?? options.defaultModel;
    const messages = await readMessages(threadId, input.signal);
    const messageCountBefore = messages.length;
    if (input.messageId && messages.some((message) => message.info.id === input.messageId && message.info.role === "user")) {
      return { threadId, acceptedAt: now(), messageCountBefore, messageId: input.messageId, alreadyPresent: true };
    }
    const session = `${opencodePath}/session/${encodeURIComponent(threadId)}`;
    if (model !== undefined) {
      sdkSuccess(await call("POST", `${session}/model`, { model: { id: model.modelId, providerID: model.providerId, ...(model.variant === undefined ? {} : { variant: model.variant }) } }, input.signal), "POST", `${session}/model`);
    }
    const path = `${session}/prompt`;
    sdkSuccess(await call("POST", path, { text: input.prompt, ...(input.messageId === undefined ? {} : { id: input.messageId }) }, input.signal), "POST", path);
    return { threadId, acceptedAt: now(), messageCountBefore, messageId: input.messageId ?? null, alreadyPresent: false };
  }

  async function waitForThread(threadId: string, input: HeadlessThreadWaitInput): Promise<HeadlessThreadWaitResult> {
    const startedAt = now();
    const deadline = startedAt + input.timeoutMs;
    const interval = input.pollIntervalMs ?? pollIntervalMs;
    const messageCountBefore = input.since?.messageCountBefore ?? 0;
    const messageId = input.since?.messageId ?? null;
    let polls = 0;
    let observedRunning = false;

    for (;;) {
      if (input.signal?.aborted) {
        const snapshot = await getThreadSnapshot(threadId);
        return { outcome: "aborted", snapshot, waitedMs: now() - startedAt, polls, observedRunning, terminalError: null };
      }
      const snapshot = await getThreadSnapshot(threadId, { signal: input.signal });
      polls += 1;
      const finish = (outcome: HeadlessThreadWaitResult["outcome"]): HeadlessThreadWaitResult => ({
        outcome,
        snapshot,
        waitedMs: now() - startedAt,
        polls,
        observedRunning,
        terminalError: outcome === "failed"
          ? assistantReplyForTurn(snapshot.messages, { messageId, messageCountBefore })?.error ?? null
          : null,
      });

      if (isRunning(snapshot.status)) {
        observedRunning = true;
      } else {
        const reply = assistantReplyForTurn(snapshot.messages, { messageId, messageCountBefore });
        if (reply?.error) return finish("failed");
        if (reply) return finish("settled");
      }

      if (input.signal?.aborted) return finish("aborted");
      const remaining = deadline - now();
      if (remaining <= 0) return finish("timeout");
      await sleep(Math.min(interval, remaining));
    }
  }

  async function waitUntilIdle(threadId: string, input: HeadlessThreadWaitInput): Promise<HeadlessThreadWaitResult> {
    const startedAt = now();
    const deadline = startedAt + input.timeoutMs;
    const interval = input.pollIntervalMs ?? pollIntervalMs;
    let polls = 0;
    let observedRunning = false;
    for (;;) {
      if (input.signal?.aborted) {
        const snapshot = await getThreadSnapshot(threadId);
        return { outcome: "aborted", snapshot, waitedMs: now() - startedAt, polls, observedRunning, terminalError: null };
      }
      const snapshot = await getThreadSnapshot(threadId, { signal: input.signal });
      polls += 1;
      if (!isRunning(snapshot.status)) {
        return { outcome: "settled", snapshot, waitedMs: now() - startedAt, polls, observedRunning, terminalError: null };
      }
      observedRunning = true;
      const remaining = deadline - now();
      if (remaining <= 0) {
        return { outcome: "timeout", snapshot, waitedMs: now() - startedAt, polls, observedRunning, terminalError: null };
      }
      await sleep(Math.min(interval, remaining));
    }
  }

  async function abortThread(threadId: string, input?: { signal?: AbortSignal }): Promise<HeadlessAbortResult> {
    const path = `${opencodePath}/session/${encodeURIComponent(threadId)}/interrupt`;
    const result = await call("POST", path, {}, input?.signal);
    const data = sdkSuccess(result, "POST", path);
    const interrupted = data !== null && typeof data === "object" && "interrupted" in data ? (data as { interrupted: unknown }).interrupted : data;
    const accepted = sdkJson(abortResultSchema, { data: interrupted }, "POST", path);
    return { threadId, accepted };
  }

  async function exportTranscript(threadId: string, input?: { signal?: AbortSignal }): Promise<HeadlessThreadTranscript> {
    return toTranscript(await getThreadSnapshot(threadId, input));
  }

  return { createThread, sendTurn, waitForThread, waitUntilIdle, getThreadSnapshot, abortThread, exportTranscript };
}
