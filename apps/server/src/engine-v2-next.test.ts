import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assertSessionPluginActive, OMNIRUSH_SESSION_PLUGIN_ID } from "./engine-v2-preview.js";
import { readMigratedSessions, seedV2StoreFromV1 } from "./engine-v2-migration.js";
import { pluginDirectories } from "./managed-opencode-v2.js";
import sessionPlugin from "./opencode-plugins/omnirush-session-next.js";
import { startsV1Chat } from "./server.js";

async function withDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "v2-next-"));
  try { await run(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

test("a 1.x store seeds the 2.x store once, keeps a backup and stays untouched", () => withDir(async (dir) => {
  const v1 = join(dir, "v1", "opencode.db");
  await Bun.write(join(dir, "v1", ".keep"), "");
  const db = new Database(v1, { create: true });
  db.run("PRAGMA journal_mode=WAL");
  db.run("CREATE TABLE session (id TEXT PRIMARY KEY)");
  db.run("INSERT INTO session VALUES ('ses_a'), ('ses_b')");
  const root = join(dir, "v2", "state");
  const seeded = await seedV2StoreFromV1(root, v1, new Date("2026-10-25T00:00:00Z"));
  db.close();
  expect(seeded?.sessions.sort()).toEqual(["ses_a", "ses_b"]);
  expect(existsSync(seeded!.backup)).toBe(true);
  // The copy holds the rows still in the WAL.
  const copy = new Database(join(root, "opencode.db"), { readonly: true });
  expect(copy.query("SELECT count(*) AS n FROM session").get()).toEqual({ n: 2 });
  copy.close();
  expect(readMigratedSessions(root)).toEqual(new Set(["ses_a", "ses_b"]));
  // Nothing was written beside the 1.x store.
  expect((await readdir(join(dir, "v1"))).filter((name) => !/^(\.keep|opencode\.db(-wal|-shm)?)$/.test(name))).toEqual([]);
  // Never again once the 2.x store exists.
  expect(await seedV2StoreFromV1(root, v1)).toBeNull();
  expect(await seedV2StoreFromV1(join(dir, "other"), join(dir, "missing.db"))).toBeNull();
  expect(readMigratedSessions(join(dir, "other"))).toEqual(new Set());
}));

test("the session plugin names the chat on gateway requests and blanks secrets in shells", async () => {
  const hooks: Record<string, (event: never) => Promise<void> | void> = {};
  process.env.OMNIRUSH_USER_XDG_DATA_HOME = "/home/me/.data";
  process.env.OMNIRUSH_USER_XDG_STATE_HOME = "";
  try {
    await sessionPlugin.setup({
      session: {
        get: async ({ sessionID }) => ({ id: sessionID, parentID: sessionID === "ses_child" ? "ses_parent" : undefined, model: { id: "gpt-6-astra" } }),
        hook: async (name, callback) => { hooks[name] = callback as never; },
      },
      shell: { hook: async (name, callback) => { hooks[name] = callback as never; } },
    });
  } finally {
    delete process.env.OMNIRUSH_USER_XDG_DATA_HOME;
    delete process.env.OMNIRUSH_USER_XDG_STATE_HOME;
  }
  const request = (sessionID: string, kind: string, providerID = "omnirush") => {
    const event = { sessionID, kind, model: { id: "cheap", providerID }, headers: {} as Record<string, string> };
    return (hooks["model.request"] as (e: typeof event) => Promise<void>)(event).then(() => event.headers);
  };
  expect(await request("ses_main", "primary")).toEqual({ "x-omnirush-session-id": "ses_main" });
  expect(await request("ses_child", "primary")).toEqual({ "x-omnirush-session-id": "ses_child", "x-parent-session-id": "ses_parent" });
  expect(await request("ses_main", "title")).toEqual({ "x-omnirush-session-id": "ses_main", "x-omnirush-title": "1", "x-omnirush-chat-model": "gpt-6-astra" });
  expect(await request("ses_main", "primary", "openai")).toEqual({});
  const env: Record<string, string | undefined> = { OPENCODE_PASSWORD: "pw", OMNIRUSH_POLICY_TOKEN: "t", XDG_DATA_HOME: "/engine/data", XDG_STATE_HOME: "/engine/state", PATH: "/bin" };
  await (hooks["create.before"] as (e: { env: typeof env }) => void)({ env });
  expect(env).toMatchObject({ OPENCODE_PASSWORD: "", OMNIRUSH_POLICY_TOKEN: "", XDG_DATA_HOME: "/home/me/.data", XDG_STATE_HOME: undefined, PATH: "/bin" });
});

test("chats do not start unless the session plugin is active", async () => {
  expect(sessionPlugin.id).toBe(OMNIRUSH_SESSION_PLUGIN_ID);
  const engine = (data: unknown, status = 200) => ({ fetchJson: async () => ({ status, json: { data } }) });
  await assertSessionPluginActive(engine([{ id: "omnirush.session", state: { status: "active" } }]), "/p");
  await expect(assertSessionPluginActive(engine([{ id: "opencode.agent", state: { status: "active" } }]), "/p")).rejects.toThrow(/not active/);
  await expect(assertSessionPluginActive(engine([{ id: "omnirush.session", state: { status: "failed" } }]), "/p")).rejects.toThrow(/not active/);
  await expect(assertSessionPluginActive(engine([], 500), "/p")).rejects.toThrow(/not active/);
});

test("each plugin module gets a directory the 2.x engine loads", () => withDir(async (dir) => {
  const [plugin] = await pluginDirectories(dir, ["/app/opencode-plugins/omnirush-session-next.js"]);
  expect(plugin).toBe(join(dir, "omnirush-session-next"));
  expect(await readFile(join(plugin!, "server.js"), "utf8")).toBe('export { default } from "file:///app/opencode-plugins/omnirush-session-next.js";\n');
}));

test("the 1.x engine starts no chat and no turn", () => {
  for (const path of ["/session", "/opencode/session", "/session/ses_1/prompt_async", "/session/ses_1/message", "/session/ses_1/command", "/session/ses_1/shell", "/session/ses_1/summarize", "/session/ses_1/fork"]) {
    expect(startsV1Chat("POST", path)).toBe(true);
  }
  for (const [method, path] of [["GET", "/session"], ["GET", "/session/ses_1/message"], ["POST", "/session/ses_1/abort"], ["DELETE", "/session/ses_1"], ["POST", "/session/ses_1/permissions/p1"]]) {
    expect(startsV1Chat(method!, path!)).toBe(false);
  }
});
