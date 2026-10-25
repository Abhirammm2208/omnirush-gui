import { expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assertEngineGates, createManagedOpencodeV2Server, engineV2SpawnEnv } from "./managed-opencode-v2.js";

const posix = process.platform === "win32" ? test.skip : test;

posix("the v2 engine gets its own empty config home, not the user's global opencode config", async () => {
  const dir = await mkdtemp(join(tmpdir(), "v2-env-"));
  try {
    const record = join(dir, "env.txt");
    const bin = join(dir, "fake-v2");
    await writeFile(bin, `#!/bin/sh\nenv > "${record}"\nexit 3\n`);
    await chmod(bin, 0o755);
    const userConfig = join(dir, "user-config");
    await createManagedOpencodeV2Server({ bin, rootDir: join(dir, "state"), bootTimeoutMs: 5_000, env: { XDG_CONFIG_HOME: userConfig } })
      .then((server) => server.close(), () => undefined);
    const env = await readFile(record, "utf8");
    const configHome = /^XDG_CONFIG_HOME=(.*)$/m.exec(env)?.[1];
    expect(configHome).toBe(join(dir, "state", "xdg-config"));
    // Only agent shells get the user's config home back (omnirush-session-next.ts).
    expect(env.replace(/^OMNIRUSH_USER_XDG_CONFIG_HOME=.*$/m, "")).not.toContain(userConfig);
    expect(env).toMatch(/^OMNIRUSH_USER_XDG_CONFIG_HOME=.*user-config$/m);
    // Project config stays on (engine patch 0003 keeps only its descriptive keys); the gates are on.
    expect(env).not.toMatch(/^OPENCODE_DISABLE_PROJECT_CONFIG=/m);
    expect(env).toMatch(/^OMNIRUSH_GATE_PROVIDERS=omnirush$/m);
    expect(env).toMatch(/^OMNIRUSH_GATE_MCP=$/m);
    expect(env).toMatch(/^OMNIRUSH_NO_SYSTEM_CONFIG=1$/m);
    expect(/^XDG_DATA_HOME=(.*)$/m.exec(env)?.[1]).toBe(join(dir, "state", "data"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the engine's gates are applied last and a spawn without them is refused", () => {
  const env = engineV2SpawnEnv({ OMNIRUSH_GATE_PROVIDERS: "*", OMNIRUSH_GATE_MCP: "anything", OMNIRUSH_NO_SYSTEM_CONFIG: "0", PATH: "/bin" });
  expect(env).toMatchObject({ OMNIRUSH_GATE_PROVIDERS: "omnirush", OMNIRUSH_GATE_MCP: "", OMNIRUSH_NO_SYSTEM_CONFIG: "1", PATH: "/bin" });
  expect(() => assertEngineGates({ PATH: "/bin" })).toThrow(/gates are missing/);
  expect(() => assertEngineGates({ OMNIRUSH_GATE_PROVIDERS: "omnirush", OMNIRUSH_NO_SYSTEM_CONFIG: "1" })).toThrow(/gates are missing/);
});
