import { SHELL_SECRET_ENV } from "./shell-secret-env.js";

/**
 * 2.x engine plugin: what the 1.x plugins' `chat.headers` and `shell.env` did.
 * - Every model request to the app's gateway names its chat (x-omnirush-session-id) and,
 *   for a sub-agent, its parent chat, so the broker binds the chat (strict sessions) and
 *   keeps one model per chat. A title request is marked and names the chat's model.
 * - Agent shells never see the app's secrets (the engine password included).
 * The server refuses v2 chats while this plugin is not active (engine-v2-preview.ts).
 */
export const OMNIRUSH_SESSION_PLUGIN_ID = "omnirush.session";
const PROVIDER_ID = "omnirush";

type SessionInfo = { parentID?: unknown; model?: { id?: unknown } | null };

export default {
  id: OMNIRUSH_SESSION_PLUGIN_ID,
  async setup(ctx: {
    session: {
      get(input: { sessionID: string }): Promise<unknown>;
      hook(name: "model.request", callback: (event: { sessionID: string; kind: string; model: { id: string; providerID: string }; headers: Record<string, string> }) => Promise<void>, options?: { providerID?: string }): Promise<unknown>;
    };
    shell: { hook(name: "create.before", callback: (event: { env: Record<string, string | undefined> }) => Promise<void> | void): Promise<unknown> };
  }) {
    const sessions = new Map<string, SessionInfo>();
    const info = async (sessionID: string): Promise<SessionInfo> => {
      const known = sessions.get(sessionID);
      if (known) return known;
      const result: unknown = await ctx.session.get({ sessionID }).catch(() => undefined);
      const raw = result && typeof result === "object" && "data" in result ? (result as { data: unknown }).data : result;
      const found = (raw && typeof raw === "object" ? raw : {}) as SessionInfo;
      if (sessions.size >= 512) sessions.clear();
      sessions.set(sessionID, found);
      return found;
    };
    await ctx.session.hook("model.request", async (event) => {
      if (event.model.providerID !== PROVIDER_ID || !event.sessionID) return;
      event.headers["x-omnirush-session-id"] = event.sessionID;
      const session = await info(event.sessionID);
      if (typeof session.parentID === "string" && session.parentID) event.headers["x-parent-session-id"] = session.parentID;
      if (event.kind === "title") {
        event.headers["x-omnirush-title"] = "1";
        const chatModel = typeof session.model?.id === "string" ? session.model.id : event.model.id;
        if (chatModel) event.headers["x-omnirush-chat-model"] = chatModel;
      }
    }, { providerID: PROVIDER_ID });
    // Captured before any shell runs: the engine's own XDG folders are not the user's.
    const userXdg = Object.fromEntries(["DATA", "STATE", "CONFIG"].map((kind) =>
      [`XDG_${kind}_HOME`, process.env[`OMNIRUSH_USER_XDG_${kind}_HOME`]]));
    await ctx.shell.hook("create.before", (event) => {
      for (const name of SHELL_SECRET_ENV) event.env[name] = "";
      for (const [name, value] of Object.entries(userXdg)) {
        if (value === undefined) continue;
        event.env[name] = value || undefined;
      }
    });
  },
};
