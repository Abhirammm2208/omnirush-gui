// The 2.x engine reloads on any write to its watched config, and a reload drops the model streams in flight: the
// config is written only when its content changed (managed-opencode-v2.ts writeIfChanged).
import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeIfChanged } from "./managed-opencode-v2.js";

test("the same config is not written again; a change is", async () => {
  const dir = await mkdtemp(join(tmpdir(), "engine-config-"));
  try {
    const file = join(dir, "opencode.json");
    const writes: string[] = [];
    const write = async (path: string, text: string) => { writes.push(text); await Bun.write(path, text); };
    expect(await writeIfChanged(file, "{\"a\":1}\n", write)).toBe(true);
    expect(await writeIfChanged(file, "{\"a\":1}\n", write)).toBe(false);
    expect(await writeIfChanged(file, "{\"a\":2}\n", write)).toBe(true);
    expect(writes).toHaveLength(2);
    expect(await readFile(file, "utf8")).toBe("{\"a\":2}\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
