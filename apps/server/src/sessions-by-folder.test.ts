import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isSameSessionFolder, listEngineSessionsInFolder, listEngineV2SessionsInFolder } from "./server.js";
import type { ServerConfig, WorkspaceInfo } from "./types.js";

describe("isSameSessionFolder", () => {
  test("Windows ignores case, slash direction, a trailing slash and the extended-length prefix", () => {
    const folder = "C:\\Users\\vedant\\taskforge";
    for (const other of [
      "c:\\users\\vedant\\taskforge",
      "C:/Users/vedant/taskforge",
      "C:\\Users\\vedant\\taskforge\\",
      "\\\\?\\C:\\Users\\vedant\\taskforge",
    ]) {
      expect(isSameSessionFolder(other, folder, "win32")).toBe(true);
    }
    expect(isSameSessionFolder("C:\\Users\\vedant\\taskforge2", folder, "win32")).toBe(false);
    expect(isSameSessionFolder("C:\\Users\\vedant\\taskforge\\sub", folder, "win32")).toBe(false);
  });

  test("macOS ignores case, Linux does not", () => {
    expect(isSameSessionFolder("/Users/alden/Code/Helm", "/Users/alden/code/helm/", "darwin")).toBe(true);
    expect(isSameSessionFolder("/home/a/Helm", "/home/a/helm", "linux")).toBe(false);
    expect(isSameSessionFolder("/home/a/helm/", "/home/a/helm", "linux")).toBe(true);
  });

  test("an empty session folder never matches", () => {
    expect(isSameSessionFolder("", "/", "linux")).toBe(false);
  });
});

describe("listEngineSessionsInFolder", () => {
  const workspace: WorkspaceInfo = {
    id: "ws_folder",
    name: "taskforge",
    path: "/tmp/omnirush-by-folder",
    preset: "starter",
    workspaceType: "local",
    baseUrl: "http://engine.invalid",
  };
  const config: ServerConfig = {
    host: "127.0.0.1",
    port: 0,
    token: "owt_test_token",
    hostToken: "owt_host_token",
    approval: { mode: "auto", timeoutMs: 1000 },
    corsOrigins: ["*"],
    workspaces: [workspace],
    authorizedRoots: [workspace.path],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "pretty",
    logRequests: false,
  };

  test("reads the unscoped engine list and keeps only this folder's sessions, from every project", async () => {
    const requests: Request[] = [];
    const sessions = await listEngineSessionsInFolder(config, workspace, workspace.path, 10, async (input, init) => {
      requests.push(new Request(input, init));
      return Response.json([
        { id: "ses_new_project", directory: workspace.path, projectID: "github.com/a/b", time: { updated: 3 } },
        { id: "ses_other_folder", directory: "/tmp/elsewhere", projectID: "global", time: { updated: 2 } },
        { id: "ses_old_project", directory: `${workspace.path}/`, projectID: "global", time: { updated: 1 } },
      ]);
    });
    expect(sessions.map((session) => (session as { id: string }).id)).toEqual(["ses_new_project", "ses_old_project"]);
    const url = new URL(requests[0]!.url);
    expect(url.pathname).toBe("/experimental/session");
    expect(url.searchParams.get("directory")).toBeNull();
    expect(url.searchParams.get("archived")).toBe("true");
    expect(requests[0]!.headers.get("x-opencode-directory")).toBe(workspace.path);
  });

  test("respects the limit and fails loudly when the engine does", async () => {
    const many = Array.from({ length: 5 }, (_, index) => ({ id: `ses_${index}`, directory: workspace.path }));
    expect(await listEngineSessionsInFolder(config, workspace, workspace.path, 2, async () => Response.json(many))).toHaveLength(2);
    await expect(listEngineSessionsInFolder(config, workspace, workspace.path, 2, async () => new Response("no", { status: 500 })))
      .rejects.toMatchObject({ status: 502 });
  });
});

describe("listEngineV2SessionsInFolder", () => {
  test("keeps this folder's 2.x chats from the engine's list of every folder, also under its real path", async () => {
    const root = mkdtempSync(join(tmpdir(), "omnirush-v2-by-folder-"));
    try {
      const real = join(root, "real", "proj");
      mkdirSync(real, { recursive: true });
      const link = join(root, "proj");
      symlinkSync(real, link);
      const requests: Request[] = [];
      const sessions = await listEngineV2SessionsInFolder({ url: "http://engine.invalid", password: "pw" }, link, 10, async (input, init) => {
        requests.push(new Request(input, init));
        return Response.json({ data: [
          { id: "ses_link", location: { directory: link } },
          { id: "ses_other", location: { directory: join(root, "other") } },
          { id: "ses_real", location: { directory: real } },
          { id: "ses_slash", location: { directory: `${link}/` } },
          { id: "ses_none" },
        ], cursor: {} });
      });
      expect(sessions.map((session) => (session as { id: string }).id)).toEqual(["ses_link", "ses_real", "ses_slash"]);
      const url = new URL(requests[0]!.url);
      expect(url.pathname).toBe("/api/session");
      expect(url.searchParams.get("directory")).toBeNull();
      expect(url.searchParams.get("limit")).toBe("2000");
      expect(requests[0]!.headers.get("authorization")).toBe(`Basic ${Buffer.from("opencode:pw").toString("base64")}`);
      expect(await listEngineV2SessionsInFolder({ url: "http://engine.invalid", password: "pw" }, link, 1, async () => Response.json({ data: [{ id: "a", location: { directory: link } }, { id: "b", location: { directory: link } }] }))).toHaveLength(1);
      await expect(listEngineV2SessionsInFolder({ url: "http://engine.invalid", password: "pw" }, link, 2, async () => new Response("no", { status: 500 })))
        .rejects.toMatchObject({ status: 502 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
