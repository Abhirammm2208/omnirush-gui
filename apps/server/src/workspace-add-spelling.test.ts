import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { addLocalWorkspace } from "./routes/workspaces.js";
import type { ServerConfig } from "./types.js";

async function withConfig(fn: (root: string, config: ServerConfig) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "omnirush-ws-spelling-"));
  const previousDb = process.env.OMNIRUSH_RUNTIME_DB;
  process.env.OMNIRUSH_RUNTIME_DB = join(root, "runtime.sqlite");
  const config: ServerConfig = {
    host: "127.0.0.1", port: 0, token: "token", hostToken: "host-token", configPath: join(root, "server.json"),
    approval: { mode: "auto", timeoutMs: 0 }, corsOrigins: [], workspaces: [], authorizedRoots: [root], readOnly: false,
    startedAt: Date.now(), tokenSource: "generated", hostTokenSource: "generated", logFormat: "pretty", logRequests: false,
  };
  try {
    await fn(root, config);
  } finally {
    if (previousDb === undefined) delete process.env.OMNIRUSH_RUNTIME_DB;
    else process.env.OMNIRUSH_RUNTIME_DB = previousDb;
    await rm(root, { recursive: true, force: true });
  }
}

describe("adding a folder already added under another spelling", () => {
  test("macOS and Windows: a letter-case variant is the existing workspace, never a second one", async () => {
    await withConfig(async (root, config) => {
      const folder = join(root, "Atwo");
      await mkdir(folder);
      const first = await addLocalWorkspace(config, { folderPath: folder, name: "Atwo", preset: "starter", platform: "darwin" });
      const again = await addLocalWorkspace(config, { folderPath: join(root, "ATWO"), name: "ATWO", preset: "starter", platform: "darwin" });
      expect(again.workspace).toMatchObject({ id: first.workspace.id, path: folder, name: "Atwo" });
      expect(config.workspaces.map((entry) => entry.id)).toEqual([first.workspace.id]);
      expect(existsSync(join(root, "ATWO"))).toBe(false);
      const win = await addLocalWorkspace(config, { folderPath: `${join(root, "atwo")}/`, name: "atwo", preset: "starter", platform: "win32" });
      expect(win.workspace.id).toBe(first.workspace.id);
      expect(config.workspaces).toHaveLength(1);
    });
  });

  test("Linux keeps case apart; a trailing slash is the same folder everywhere", async () => {
    await withConfig(async (root, config) => {
      const first = await addLocalWorkspace(config, { folderPath: join(root, "Atwo"), name: "Atwo", preset: "starter", platform: "linux" });
      expect((await addLocalWorkspace(config, { folderPath: `${join(root, "Atwo")}/`, name: "x", preset: "starter", platform: "linux" })).workspace.id).toBe(first.workspace.id);
      const other = await addLocalWorkspace(config, { folderPath: join(root, "ATWO"), name: "ATWO", preset: "starter", platform: "linux" });
      expect(other.workspace.id).not.toBe(first.workspace.id);
      expect(config.workspaces).toHaveLength(2);
    });
  });
});
