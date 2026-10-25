import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createEditorLsp, findProgram, type LspOp } from "./editor-lsp.js";

// Every editor language request against the real servers. The npm servers (typescript, pyright) are installed by
// the host itself into OMNIRUSH_LSP_E2E_TOOLS (set to run them); the others run when their program is on PATH.
const toolsDir = process.env.OMNIRUSH_LSP_E2E_TOOLS?.trim();
const roots: string[] = [];
const host = createEditorLsp({ toolsDir: toolsDir || join(tmpdir(), "omnirush-lsp-unused"), diagnosticsWaitMs: 30_000 });
afterAll(async () => {
  host.close();
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

type Case = {
  server: string;
  available: boolean;
  files: Record<string, string>;
  file: string;
  /** The position of the use of `greet` (0-based). */
  use: { line: number; character: number };
  broken: string;
};

const CASES: Case[] = [
  {
    server: "typescript", available: Boolean(toolsDir) || Boolean(findProgram("typescript-language-server", "/nonexistent")),
    files: { "tsconfig.json": "{\"compilerOptions\":{\"strict\":true}}", "main.ts": "export function greet(name: string): string {\n  return `hi ${name}`;\n}\nconst out: string = greet(\"a\");\n" },
    file: "main.ts", use: { line: 3, character: 21 }, broken: "const n: number = \"text\";\n",
  },
  {
    server: "pyright", available: Boolean(toolsDir) || Boolean(findProgram("pyright-langserver", "/nonexistent")),
    files: { "main.py": "def greet(name: str) -> str:\n    return \"hi \" + name\n\nout = greet(\"a\")\n" },
    file: "main.py", use: { line: 3, character: 6 }, broken: "x: int = \"text\"\nundefined_name\n",
  },
  {
    server: "gopls", available: Boolean(findProgram("gopls", "/nonexistent")),
    files: { "go.mod": "module example.com/p\n\ngo 1.22\n", "main.go": "package main\n\nfunc greet(name string) string {\n\treturn \"hi \" + name\n}\n\nfunc main() {\n\t_ = greet(\"a\")\n}\n" },
    file: "main.go", use: { line: 7, character: 6 }, broken: "package main\n\nfunc main() {\n\tvar x int = \"text\"\n}\n",
  },
  {
    server: "rust-analyzer", available: Boolean(findProgram("rust-analyzer", "/nonexistent")),
    files: { "Cargo.toml": "[package]\nname = \"p\"\nversion = \"0.1.0\"\nedition = \"2021\"\n", "src/main.rs": "fn greet(name: &str) -> String {\n    format!(\"hi {name}\")\n}\n\nfn main() {\n    let _ = greet(\"a\");\n}\n" },
    file: "src/main.rs", use: { line: 5, character: 13 }, broken: "fn main() {\n    let x = ;\n}\n",
  },
  {
    server: "clangd", available: Boolean(findProgram("clangd", "/nonexistent")),
    files: { "main.c": "int greet(int n) {\n  return n + 1;\n}\n\nint main(void) {\n  return greet(1);\n}\n" },
    file: "main.c", use: { line: 5, character: 9 }, broken: "int main(void) {\n  return undefined_name;\n}\n",
  },
];

async function project(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "omnirush-lsp-"));
  roots.push(root);
  for (const [name, text] of Object.entries(files)) {
    await mkdir(join(root, name, ".."), { recursive: true });
    await writeFile(join(root, name), text);
  }
  return root;
}

describe("editor language features (editor-lsp.ts)", () => {
  test("refuses paths outside the project and answers an empty project", async () => {
    const root = await project({ "a.txt": "x" });
    expect(await host.run(root, "diagnostics", {})).toEqual([]);
    await expect(host.run(root, "hover", { path: "../outside.ts" })).rejects.toThrow(/outside the project/);
    expect(await host.run(root, "hover", { path: "a.txt" })).toEqual([]);
    expect(await host.run(root, "rename", { path: "a.txt", line: 0, character: 0, newName: "" })).toEqual([]);
  });

  for (const c of CASES) {
    (c.available ? test : test.skip)(`${c.server}: every operation, and unsaved text never stays`, async () => {
      const root = await project(c.files);
      const run = (op: LspOp, extra: Record<string, unknown> = {}) => host.run(root, op, { path: c.file, ...c.use, ...extra });
      // A server still loading its project (rust-analyzer runs cargo first) answers empty: asked again, bounded.
      for (let i = 0; i < 120 && ((await run("hover")) as unknown[]).length === 0; i += 1) await Bun.sleep(500);
      const symbols = await run("symbols") as Array<{ name?: string }>;
      expect(JSON.stringify(symbols)).toContain("greet");
      const hover = await run("hover") as unknown[];
      expect(hover.length).toBe(1);
      expect(JSON.stringify(hover)).toContain("greet");
      const definition = await run("definition") as unknown[];
      expect(definition.length).toBeGreaterThan(0);
      expect(JSON.stringify(definition)).toContain(c.file.split("/").pop()!);
      const references = await run("references") as unknown[];
      expect(references.length).toBeGreaterThanOrEqual(2);
      const rename = await run("rename", { newName: "welcome" }) as unknown[];
      expect(JSON.stringify(rename)).toContain("welcome");
      // Unsaved broken text: its diagnostics show for that request; the next request sees the disk file again.
      const unsaved = await run("diagnostics", { text: c.broken }) as Array<{ path: string; diagnostics: unknown[] }>;
      expect(unsaved.find((entry) => entry.path === c.file)?.diagnostics.length ?? 0).toBeGreaterThan(0);
      const disk = await run("diagnostics") as Array<{ path: string; diagnostics: Array<{ severity?: number }> }>;
      const errors = (disk.find((entry) => entry.path === c.file)?.diagnostics ?? []).filter((d) => d.severity === 1);
      expect(errors).toEqual([]);
      const all = await host.run(root, "diagnostics", {}) as Array<{ path: string }>;
      expect(all.every((entry) => !entry.path.startsWith(".."))).toBe(true);
    }, 300_000);
  }
});
