import { describe, expect, test } from "bun:test";

import { resolveWorkspaceEndpoint } from "../src/app/lib/workspace-endpoint";
import { classifyRouteSessionReadError, listRouteSessions, mergeRouteSessionLists, readRouteSessionsWithRetry, v2RouteSessionList } from "../src/react-app/shell/route-workspaces";

describe("workspace route native session lists", () => {
  test("2.x: the folder's chats come from the engine list and the server's by-folder list, each once", async () => {
    const resolved = resolveWorkspaceEndpoint({ id: "ws", workspaceType: "local" }, { baseUrl: "https://local.example.test", token: "t" });
    if (!resolved) throw new Error("Expected a local endpoint");
    const asked: string[] = [];
    const endpoint = { ...resolved, client: { ...resolved.client, listWorkspaceSessionsByFolder: async (id: string, limit: number, engine?: string) => {
      asked.push(`${id}:${limit}:${engine}`);
      // A chat stored under another spelling of the folder (real path, a git repo's root since), and one also in the engine list.
      return [
        { id: "ses_symlinked", title: "old", location: { directory: "/real/proj" }, time: { created: 1, updated: 9 } },
        { id: "ses_here", title: "here", location: { directory: "/home/a/proj" }, time: { created: 1, updated: 5 } },
      ];
    } } };
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      expect(url).toContain("/workspace/ws/opencode2/api/session");
      return Response.json({ data: [
        { id: "ses_here", title: "here", location: { directory: "/home/a/proj/" }, time: { created: 1, updated: 5 } },
        { id: "ses_other_folder", title: "other", location: { directory: "/home/a/other" }, time: { created: 1, updated: 7 } },
      ], cursor: {} });
    }) as typeof fetch;
    try {
      const sessions = await listRouteSessions(endpoint, v2RouteSessionList, "/home/a/proj");
      expect(sessions.map((session) => session.id)).toEqual(["ses_symlinked", "ses_here"]);
      expect(asked).toEqual(["ws:200:v2"]);
      // A server without the 2.x by-folder list: the engine list, kept to the folder.
      endpoint.client.listWorkspaceSessionsByFolder = async () => { throw new Error("503 opencode_unconfigured"); };
      expect((await listRouteSessions(endpoint, v2RouteSessionList, "/home/a/proj")).map((session) => session.id)).toEqual(["ses_here"]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("loads a bare session array through the local native transport input", async () => {
    const endpoint = resolveWorkspaceEndpoint({
      id: "local workspace",
      workspaceType: "local",
    }, {
      baseUrl: "https://local.example.test",
      token: "local-token",
    });
    if (!endpoint) throw new Error("Expected a local endpoint");

    const inputs: unknown[] = [];

    await expect(listRouteSessions(endpoint, async (input) => {
      inputs.push(input);
      return {
        data: [{ id: "ses_local", directory: "/tmp/local" }],
        request: new Request(`${endpoint.opencodeBaseUrl}/session?limit=200`),
        response: Response.json([{ id: "ses_local", directory: "/tmp/local" }]),
      };
    })).resolves.toEqual([
      { id: "ses_local", directory: "/tmp/local" },
    ]);
    expect(inputs).toEqual([{ endpoint, limit: 200 }]);
    expect(endpoint.opencodeBaseUrl).toBe("https://local.example.test/workspace/local%20workspace/opencode2");
    expect(endpoint.token).toBe("local-token");
  });

  test("sessions filed under another engine project come back through the folder list", () => {
    const request = new Request("https://local.example.test/workspace/ws/opencode/session?limit=200");
    const session = (id: string, updated: number) => ({ id, directory: "C:\\work\\taskforge", time: { created: 1, updated } }) as never;
    const byProject = { data: [session("ses_current", 5)], request, response: Response.json([]) };
    const merged = mergeRouteSessionLists(byProject, [session("ses_old_project", 9), session("ses_current", 5)], 200);
    expect(merged.data?.map((item) => item.id)).toEqual(["ses_old_project", "ses_current"]);
    expect(mergeRouteSessionLists(byProject, null, 200)).toBe(byProject);
    expect(mergeRouteSessionLists(byProject, [session("a", 3), session("b", 2), session("c", 1)], 2).data?.map((item) => item.id))
      .toEqual(["ses_current", "a"]);
    const failed = { error: new Error("Request timed out."), request, response: undefined };
    expect(mergeRouteSessionLists(failed, [session("ses_old_project", 9)], 200).data?.map((item) => item.id)).toEqual(["ses_old_project"]);
    expect(mergeRouteSessionLists(failed, [], 200)).toBe(failed);
  });

  test("a list request with no response (server down or timed out) stays retryable", async () => {
    const endpoint = resolveWorkspaceEndpoint({
      id: "local workspace",
      workspaceType: "local",
    }, {
      baseUrl: "https://local.example.test",
      token: "local-token",
    });
    if (!endpoint) throw new Error("Expected a local endpoint");

    for (const cause of [new TypeError("Failed to fetch"), new Error("Request timed out.")]) {
      try {
        await listRouteSessions(endpoint, async () => ({
          error: cause,
          request: new Request(`${endpoint.opencodeBaseUrl}/session?limit=200`),
          response: undefined,
        }));
        throw new Error("Expected the list to fail");
      } catch (error) {
        expect((error as Error).message).toBe(cause.message);
        expect(classifyRouteSessionReadError(error)).toBe("retryable");
      }
    }
  });

  test("retries a remote native list failure on the remote endpoint and token", async () => {
    const endpoint = resolveWorkspaceEndpoint({
      id: "rem_ui-id",
      workspaceType: "remote",
      baseUrl: "https://remote.example.test/worker",
      omnirushToken: "remote-token",
      omnirushWorkspaceId: "server/id",
    }, {
      baseUrl: "https://local.example.test",
      token: "local-token",
    });
    if (!endpoint) throw new Error("Expected a remote endpoint");

    const inputs: unknown[] = [];
    const waits: number[] = [];

    await expect(readRouteSessionsWithRetry({
      load: () => listRouteSessions(endpoint, async (input) => {
        inputs.push(input);
        const response = inputs.length === 1
          ? Response.json({ code: "opencode_engine_unreachable", message: "engine starting" }, { status: 503 })
          : Response.json([{ id: "ses_remote", directory: "/workspace/remote" }]);
        return inputs.length === 1
          ? {
              error: { code: "opencode_engine_unreachable", message: "engine starting" },
              request: new Request(`${endpoint.opencodeBaseUrl}/session?limit=200`),
              response,
            }
          : {
              data: [{ id: "ses_remote", directory: "/workspace/remote" }],
              request: new Request(`${endpoint.opencodeBaseUrl}/session?limit=200`),
              response,
            };
      }),
      retryDelaysMs: [250],
      wait: async (delayMs) => { waits.push(delayMs); },
    })).resolves.toEqual([{ id: "ses_remote", directory: "/workspace/remote" }]);
    expect(waits).toEqual([250]);
    expect(inputs).toEqual([
      { endpoint, limit: 200 },
      { endpoint, limit: 200 },
    ]);
    expect(endpoint.opencodeBaseUrl).toBe("https://remote.example.test/worker/workspace/server%2Fid/opencode2");
    expect(endpoint.token).toBe("remote-token");
  });
});
