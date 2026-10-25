/**
 * The 2.x engine's session and messages in the wire shape (wire.ts). Display data for a headless
 * caller only: tool names and inputs stay the engine's own, nothing is renamed.
 */
type Rec = Record<string, unknown>;
const isRecord = (value: unknown): value is Rec => typeof value === "object" && value !== null && !Array.isArray(value);

/** `cursor.next` of a paged 2.x answer, if any. */
export function nextCursorOf(payload: unknown): string | undefined {
  const cursor = isRecord(payload) && isRecord(payload.cursor) ? payload.cursor.next : undefined;
  return typeof cursor === "string" && cursor ? cursor : undefined;
}

/** A 2.x session (`location.directory`) as the wire session (`directory`). */
export function v2SessionToWire(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const location = isRecord(value.location) ? value.location : {};
  return { ...value, directory: typeof location.directory === "string" ? location.directory : null };
}

function part(id: string, item: Rec): Rec | null {
  if (item.type === "text" || item.type === "reasoning") return { id, type: item.type, text: typeof item.text === "string" ? item.text : "" };
  if (item.type === "tool") {
    const state = isRecord(item.state) ? item.state : {};
    return { id, type: "tool", tool: item.name, callID: item.id, state: { status: state.status } };
  }
  return null;
}

/** 2.x messages (oldest first) as `{info, parts}`; turn markers and switches are left out. */
export function v2MessagesToWire(messages: readonly unknown[]): Rec[] {
  const out: Rec[] = [];
  // A 2.x answer names no prompt: it answers the user message before it (wire `parentID`).
  let lastUser: string | undefined;
  for (const message of messages) {
    if (!isRecord(message) || typeof message.id !== "string") continue;
    const time = isRecord(message.time) ? { created: message.time.created } : undefined;
    if (message.type === "user" || message.type === "synthetic") {
      const text = typeof message.text === "string" ? message.text : "";
      if (message.type === "user") lastUser = message.id;
      out.push({ info: { id: message.id, role: "user", ...(time ? { time } : {}) }, parts: [{ id: `${message.id}_text`, type: "text", text, ...(message.type === "synthetic" ? { synthetic: true } : {}) }] });
      continue;
    }
    if (message.type !== "assistant") continue;
    const content = Array.isArray(message.content) ? message.content : [];
    const parts = content.flatMap((item, index) => {
      const mapped = isRecord(item) ? part(`${message.id}_${index}`, item) : null;
      return mapped ? [mapped] : [];
    });
    out.push({
      info: {
        id: message.id, role: "assistant", ...(time ? { time } : {}), ...(lastUser ? { parentID: lastUser } : {}),
        ...(message.error !== undefined ? { error: message.error } : {}),
        ...(typeof message.cost === "number" ? { cost: message.cost } : {}),
        ...(isRecord(message.tokens) ? { tokens: message.tokens } : {}),
      },
      parts,
    });
  }
  return out;
}
