// The 2.x engine's stored messages as the 1.x `{info, parts}` shape, for the
// capture's derived facts only (turn files, files used, turn writers, turn
// outcome, the turn's model, settle checks). Uploads always carry the raw
// 2.x messages; nothing here is ever sent.
//
// Tool names and input keys stay as the 2.x engine wrote them (`shell`,
// `patch`, `read {path}`): the shared modules know both generations' names.
// shortcut: a copy of the CLI's capture/engine-v2-view.ts; becomes the shared engine-v2-messages reader (PARITY) when WS2 lands it.

type Rec = Record<string, unknown>;

const isRecord = (value: unknown): value is Rec => typeof value === "object" && value !== null && !Array.isArray(value);

/** Whether `messages` are 2.x stored messages (a top-level `type`, no `info`). */
export function isV2Messages(messages: readonly unknown[]): boolean {
  return messages.some((message) => isRecord(message) && typeof message.type === "string" && !isRecord(message.info));
}

function toolOutput(state: Rec): string {
  const content = Array.isArray(state.content) ? state.content : [];
  return content.filter((item) => isRecord(item) && item.type === "text").map((item) => String((item as Rec).text ?? "")).join("\n");
}

function toolPart(item: Rec, sessionID: string, messageID: string): Rec {
  const state = isRecord(item.state) ? item.state : {};
  const time = isRecord(item.time) ? item.time : {};
  const status = state.status === "streaming" ? "pending" : state.status;
  const files = (Array.isArray(state.content) ? state.content : []).filter((entry) => isRecord(entry) && entry.type === "file");
  return {
    type: "tool",
    id: `${messageID}_${String(item.id)}`,
    sessionID,
    messageID,
    tool: item.name,
    callID: item.id,
    state: {
      status,
      input: isRecord(state.input) ? state.input : {},
      ...(status === "completed" || status === "error" ? { output: toolOutput(state) } : {}),
      ...(isRecord(state.metadata) ? { metadata: state.metadata } : {}),
      ...(isRecord(state.error) ? { error: String((state.error as Rec).message ?? "") } : {}),
      ...(files.length ? { attachments: files.map((entry) => ({ type: "file", mime: (entry as Rec).mime, url: (entry as Rec).uri })) } : {}),
      time: { start: time.ran ?? time.created, ...(time.completed !== undefined ? { end: time.completed } : {}) },
    },
  };
}

/** One 2.x message as `{info, parts}`; null for kinds with no 1.x counterpart (idle, agent/model switches). */
export function v1ViewOf(message: unknown, sessionID = ""): Rec | null {
  if (!isRecord(message) || typeof message.type !== "string") return isRecord(message) && isRecord(message.info) ? message : null;
  const id = String(message.id ?? "");
  const time = isRecord(message.time) ? message.time : {};
  const base = { id, sessionID, time: { created: time.created, ...(time.completed !== undefined ? { completed: time.completed } : {}) } };
  switch (message.type) {
    case "user": {
      const files = (Array.isArray(message.files) ? message.files : []).filter(isRecord).map((file) => ({ type: "file", url: file.uri, filename: file.name, mime: "" }));
      return { info: { ...base, role: "user" }, parts: [{ type: "text", text: String(message.text ?? "") }, ...files] };
    }
    case "synthetic":
    case "system":
    case "skill":
      return { info: { ...base, role: "user" }, parts: [{ type: "text", text: String(message.text ?? ""), synthetic: true }] };
    case "compaction":
      // One 2.x message is the 1.x request and its summary (auto-compact.ts reads both).
      return { info: { ...base, role: "user" }, parts: [{ type: "compaction", auto: message.reason === "auto" }] };
    case "assistant": {
      const model = isRecord(message.model) ? message.model : {};
      const parts = (Array.isArray(message.content) ? message.content : []).filter(isRecord).map((item) => {
        if (item.type === "tool") return toolPart(item, sessionID, id);
        return { type: item.type, text: String(item.text ?? "") };
      });
      if (message.finish !== undefined) parts.push({ type: "step-finish", reason: message.finish });
      return {
        info: {
          ...base,
          role: "assistant",
          agent: message.agent,
          modelID: model.id,
          providerID: model.providerID,
          ...(message.finish !== undefined ? { finish: message.finish } : {}),
          ...(isRecord(message.error) ? { error: { name: String(message.error.type ?? "Error"), data: { message: message.error.message } } } : {}),
          ...(isRecord(message.tokens) ? { tokens: message.tokens } : {}),
        },
        parts,
      };
    }
    default:
      return null;
  }
}

/** A 2.x compaction's summary as the 1.x summary message (`summary: true`, agent compaction, its request as parent). */
function compactionSummary(message: Rec, sessionID: string): Rec | null {
  if (message.type !== "compaction" || message.status === "running") return null;
  const time = isRecord(message.time) ? message.time : {};
  const failed = message.status !== "completed";
  return {
    info: {
      id: `${String(message.id)}_summary`,
      sessionID,
      role: "assistant",
      summary: true,
      agent: "compaction",
      mode: "compaction",
      parentID: String(message.id),
      time: { created: time.created, ...(time.completed !== undefined ? { completed: time.completed } : failed ? {} : { completed: time.created }) },
      ...(failed ? { error: { name: isRecord(message.error) ? String(message.error.type ?? "error") : "error" } } : {}),
      ...(isRecord(message.tokens) ? { tokens: message.tokens } : {}),
    },
    parts: [{ type: "text", text: String(message.summary ?? "") }],
  };
}

/** A message list for the shared modules: 1.x lists unchanged, 2.x lists as their 1.x view. */
export function v1View(messages: readonly unknown[], sessionID = ""): unknown[] {
  if (!isV2Messages(messages)) return [...messages];
  return messages.flatMap((message) => [v1ViewOf(message, sessionID), isRecord(message) ? compactionSummary(message, sessionID) : null]).filter((message): message is Rec => message !== null);
}

/** The sub-agent sessions a 2.x turn started (its `subagent` calls' child sessions). */
export function v2ChildSessions(messages: readonly unknown[]): string[] {
  const ids: string[] = [];
  for (const message of messages) {
    if (!isRecord(message) || message.type !== "assistant" || !Array.isArray(message.content)) continue;
    for (const item of message.content) {
      if (!isRecord(item) || item.type !== "tool" || item.name !== "subagent" || !isRecord(item.state)) continue;
      const metadata = isRecord(item.state.metadata) ? item.state.metadata : {};
      const input = isRecord(item.state.input) ? item.state.input : {};
      const id = [metadata.sessionID, metadata.sessionId, input.sessionID].find((value) => typeof value === "string" && value.startsWith("ses_"));
      if (typeof id === "string" && !ids.includes(id)) ids.push(id);
    }
  }
  return ids;
}
