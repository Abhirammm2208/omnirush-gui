/**
 * The desktop editor's language features (diagnostics, hover, go to definition, references, symbols, rename),
 * served by the app's server. The 2.x engine has no language servers of its own, and this host is separate from
 * the agent: it only answers the editor (the same requests the 1.x engine's /editor/lsp routes answered).
 *
 * - Servers: typescript, pyright (each from PATH, else installed by the app with npm into its own folder, never
 *   running install scripts), gopls, rust-analyzer and clangd (from PATH). A program is never taken from the
 *   project's folder, and nothing is read from the project's opencode config.
 * - One server per (project, server), started on first use; closed with the app's server.
 * - A request with `text` (an unsaved buffer) runs alone: the text is opened for that request, then the file is
 *   always opened again from disk, so unsaved text never stays in a server.
 */
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { delimiter, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export type LspOp = "diagnostics" | "hover" | "definition" | "references" | "symbols" | "rename";
export const LSP_OPS: readonly LspOp[] = ["diagnostics", "hover", "definition", "references", "symbols", "rename"];
export type LspPayload = { path?: string; line?: number; character?: number; newName?: string; text?: string };

type Launch = { command: string; args: string[]; env?: Record<string, string> };
type ServerInfo = {
  id: string;
  extensions: string[];
  program: string;
  args: string[];
  /** npm packages the app installs when the program is not on PATH (the first one has the executable). */
  npm?: { packages: string[]; bin: string };
};

const SERVERS: ServerInfo[] = [
  { id: "typescript", extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"], program: "typescript-language-server", args: ["--stdio"],
    npm: { packages: ["typescript-language-server@4.4.0", "typescript@5.9.3"], bin: "typescript-language-server" } },
  { id: "pyright", extensions: [".py", ".pyi"], program: "pyright-langserver", args: ["--stdio"], npm: { packages: ["pyright@1.1.407"], bin: "pyright-langserver" } },
  { id: "gopls", extensions: [".go"], program: "gopls", args: [] },
  { id: "rust-analyzer", extensions: [".rs"], program: "rust-analyzer", args: [] },
  { id: "clangd", extensions: [".c", ".cc", ".cpp", ".cxx", ".c++", ".h", ".hh", ".hpp", ".hxx", ".m", ".mm"], program: "clangd", args: ["--background-index"] },
];

const LANGUAGE_IDS: Record<string, string> = {
  ".ts": "typescript", ".mts": "typescript", ".cts": "typescript", ".tsx": "typescriptreact", ".js": "javascript", ".mjs": "javascript",
  ".cjs": "javascript", ".jsx": "javascriptreact", ".py": "python", ".pyi": "python", ".go": "go", ".rs": "rust", ".c": "c", ".h": "c",
  ".m": "objective-c", ".mm": "objective-cpp",
};
const languageId = (file: string) => LANGUAGE_IDS[extname(file).toLowerCase()] ?? "cpp";

/** A program on PATH, never from inside the project. */
export function findProgram(program: string, projectRoot: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const name = process.platform === "win32" && !/\.(exe|cmd)$/i.test(program) ? `${program}.exe` : program;
  for (const dir of (env.PATH ?? env.Path ?? "").split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    const rel = relative(projectRoot, dir);
    if (!rel || (!rel.startsWith("..") && !isAbsolute(rel))) continue;
    if (existsSync(join(dir, name))) return join(dir, name);
  }
  return null;
}

const installs = new Map<string, Promise<string | null>>();
/** The npm server's executable script, installed once into the app's folder (no install scripts run). */
function installNpm(info: ServerInfo, toolsDir: string, projectRoot: string): Promise<string | null> {
  const npm = info.npm!;
  const prefix = join(toolsDir, info.id);
  const pkgName = npm.packages[0]!.replace(/@[^@/]+$/, "");
  const script = () => {
    try {
      const pkg = JSON.parse(readFileSync(join(prefix, "node_modules", pkgName, "package.json"), "utf8")) as { bin?: string | Record<string, string> };
      const rel = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.[npm.bin];
      return rel ? join(prefix, "node_modules", pkgName, rel) : null;
    } catch { return null; }
  };
  const existing = script();
  if (existing) return Promise.resolve(existing);
  let pending = installs.get(info.id);
  if (!pending) {
    pending = new Promise<string | null>((done) => {
      const npmBin = findProgram(process.platform === "win32" ? "npm.cmd" : "npm", projectRoot);
      if (!npmBin) return done(null);
      mkdirSync(prefix, { recursive: true });
      execFile(npmBin, ["install", "--prefix", prefix, "--ignore-scripts", "--no-audit", "--no-fund", "--silent", ...npm.packages],
        { timeout: 300_000, shell: process.platform === "win32" }, () => done(script()));
    }).finally(() => installs.delete(info.id));
    installs.set(info.id, pending);
  }
  return pending;
}

async function launchFor(info: ServerInfo, root: string, toolsDir: string): Promise<Launch | null> {
  const onPath = findProgram(info.program, root);
  if (onPath) return { command: onPath, args: info.args };
  if (!info.npm) return null;
  const script = await installNpm(info, toolsDir, root);
  // The app's own runtime runs the server's script (Electron as Node, or Node).
  return script ? { command: process.execPath, args: [script, ...info.args], env: { ELECTRON_RUN_AS_NODE: "1" } } : null;
}

/** Only the basics: no app tokens or engine password reach a language server. */
function basicEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ["PATH", "Path", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "SystemRoot", "SYSTEMROOT", "WINDIR",
    "COMSPEC", "PATHEXT", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "GOPATH", "GOROOT", "GOFLAGS", "CARGO_HOME", "RUSTUP_HOME"]) {
    const value = process.env[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

type Diagnostic = Record<string, unknown>;

/** One language server process over stdio (LSP's JSON-RPC framing). */
class LspClient {
  private readonly child: ChildProcess;
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private readonly waiting = new Map<number, (value: unknown) => void>();
  private readonly versions = new Map<string, number>();
  readonly diagnostics = new Map<string, Diagnostic[]>();
  private readonly diagnosticWaiters = new Map<string, Array<() => void>>();
  readonly ready: Promise<unknown>;
  private folder = "";
  closed = false;

  constructor(launch: Launch, root: string) {
    this.child = spawn(launch.command, launch.args, { cwd: root, stdio: ["pipe", "pipe", "ignore"], env: { ...basicEnv(), ...launch.env } });
    this.child.stdout!.on("data", (chunk: Buffer) => this.read(chunk));
    this.child.stdin!.on("error", () => this.close());
    this.child.on("exit", () => this.close());
    this.child.on("error", () => this.close());
    const folder = (this.folder = pathToFileURL(root).href);
    this.ready = this.request("initialize", {
      processId: process.pid, rootUri: folder, workspaceFolders: [{ uri: folder, name: root.split(sep).pop() || "project" }],
      capabilities: {
        textDocument: {
          synchronization: {}, hover: { contentFormat: ["markdown", "plaintext"] }, definition: { linkSupport: true }, references: {},
          documentSymbol: { hierarchicalDocumentSymbolSupport: true }, rename: {}, publishDiagnostics: { relatedInformation: true },
        },
        workspace: { workspaceFolders: true, configuration: true },
      },
    }, 60_000).then((result) => {
      this.notify("initialized", {});
      // Some servers (pyright) analyze nothing until they get settings: none come from the project.
      this.notify("workspace/didChangeConfiguration", { settings: {} });
      return result;
    });
  }

  private send(message: Record<string, unknown>): void {
    if (this.closed) return;
    const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...message }), "utf8");
    this.child.stdin!.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body]));
  }

  private read(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const end = this.buffer.indexOf("\r\n\r\n");
      if (end < 0) return;
      const length = Number(/Content-Length: *(\d+)/i.exec(this.buffer.subarray(0, end).toString("ascii"))?.[1] ?? Number.NaN);
      if (!Number.isFinite(length)) { this.buffer = this.buffer.subarray(end + 4); continue; }
      if (this.buffer.length < end + 4 + length) return;
      const body = this.buffer.subarray(end + 4, end + 4 + length).toString("utf8");
      this.buffer = this.buffer.subarray(end + 4 + length);
      let message: { id?: number | string; method?: string; params?: unknown; result?: unknown; error?: unknown };
      try { message = JSON.parse(body); } catch { continue; }
      if (message.method && message.id !== undefined) {
        // Server requests: no settings come from the project; everything else is acknowledged.
        const items = (message.params as { items?: unknown[] } | undefined)?.items;
        this.send({
          id: message.id,
          result: message.method === "workspace/configuration" ? (items ?? []).map(() => null)
            : message.method === "workspace/workspaceFolders" ? [{ uri: this.folder, name: "workspace" }] : null,
        });
      } else if (message.method === "textDocument/publishDiagnostics") {
        const params = message.params as { uri: string; diagnostics?: Diagnostic[] };
        this.diagnostics.set(params.uri, params.diagnostics ?? []);
        for (const wake of this.diagnosticWaiters.get(params.uri) ?? []) wake();
      } else if (typeof message.id === "number") {
        this.waiting.get(message.id)?.(message.error ? null : message.result);
        this.waiting.delete(message.id);
      }
    }
  }

  request(method: string, params: unknown, timeoutMs = 20_000): Promise<unknown> {
    if (this.closed) return Promise.resolve(null);
    const id = this.nextId++;
    return new Promise((done) => {
      const timer = setTimeout(() => { this.waiting.delete(id); done(null); }, timeoutMs);
      this.waiting.set(id, (value) => { clearTimeout(timer); done(value); });
      this.send({ id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    this.send({ method, params });
  }

  /** Opens (or replaces) the document with `text`, or the file's disk content. */
  async open(file: string, text?: string): Promise<void> {
    const uri = pathToFileURL(file).href;
    const content = text ?? (await readFile(file, "utf8").catch(() => ""));
    const version = (this.versions.get(uri) ?? 0) + 1;
    this.versions.set(uri, version);
    if (version === 1) this.notify("textDocument/didOpen", { textDocument: { uri, languageId: languageId(file), version, text: content } });
    else this.notify("textDocument/didChange", { textDocument: { uri, version }, contentChanges: [{ text: content }] });
  }

  /**
   * The diagnostics for `file` after an open: the first publish, then until the server goes quiet for a moment
   * (some servers publish the previous version's first), waited for at most `ms` in all.
   */
  waitForDiagnostics(file: string, ms: number, quietMs = 600): Promise<void> {
    const uri = pathToFileURL(file).href;
    return new Promise((done) => {
      let quiet: ReturnType<typeof setTimeout> | undefined;
      const finish = () => { clearTimeout(limit); clearTimeout(quiet); this.diagnosticWaiters.delete(uri); done(); };
      const limit = setTimeout(finish, ms);
      this.diagnosticWaiters.set(uri, [() => { clearTimeout(quiet); quiet = setTimeout(finish, quietMs); }]);
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const done of this.waiting.values()) done(null);
    this.waiting.clear();
    try { this.child.kill(); } catch { /* gone */ }
  }
}

function asList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : value ? [value] : [];
}

/** The editor's language features for every project of one app server. */
export function createEditorLsp(options: { toolsDir: string; diagnosticsWaitMs?: number }) {
  const clients = new Map<string, Promise<LspClient | null>>();
  let textLane: Promise<unknown> = Promise.resolve();

  function clientFor(root: string, file: string): Promise<LspClient | null> {
    const info = SERVERS.find((server) => server.extensions.includes(extname(file).toLowerCase()));
    if (!info) return Promise.resolve(null);
    const key = `${root}\0${info.id}`;
    const existing = clients.get(key);
    if (existing) {
      return existing.then((client) => {
        if (client && !client.closed) return client;
        if (clients.get(key) === existing) clients.delete(key);
        return client ? clientFor(root, file) : null;
      });
    }
    const pending = launchFor(info, root, options.toolsDir).then(async (launch) => {
      if (!launch) return null;
      const client = new LspClient(launch, root);
      return (await client.ready) && !client.closed ? client : (client.close(), null);
    }).catch(() => null);
    clients.set(key, pending);
    return pending;
  }

  /** Every diagnostic of the project's running servers, by project-relative path (only `only` when given). */
  async function projectDiagnostics(root: string, only?: string): Promise<Array<{ path: string; diagnostics: Diagnostic[] }>> {
    const out: Array<{ path: string; diagnostics: Diagnostic[] }> = [];
    for (const [key, pending] of clients) {
      if (!key.startsWith(`${root}\0`)) continue;
      const client = await pending;
      if (!client) continue;
      for (const [uri, diagnostics] of client.diagnostics) {
        const file = fileURLToPath(uri);
        if (only && resolve(file) !== resolve(only)) continue;
        const rel = relative(root, file);
        if (!rel || rel.startsWith("..") || isAbsolute(rel)) continue;
        out.push({ path: rel.split(sep).join("/"), diagnostics });
      }
    }
    return out;
  }

  async function run(root: string, op: LspOp, payload: LspPayload): Promise<unknown> {
    if (op === "diagnostics" && !payload.path) return projectDiagnostics(root);
    if (op === "rename" && !payload.newName) return [];
    if (typeof payload.path !== "string" || !payload.path) throw new Error("path is required");
    const file = resolve(root, payload.path);
    const rel = relative(root, file);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("path outside the project");
    const client = await clientFor(root, file);
    if (!client) return [];
    const position = { line: Math.max(0, Math.floor(payload.line ?? 0)), character: Math.max(0, Math.floor(payload.character ?? 0)) };
    const textDocument = { uri: pathToFileURL(file).href };
    const use = async (): Promise<unknown> => {
      const diagnosticsDone = op === "diagnostics" ? client.waitForDiagnostics(file, options.diagnosticsWaitMs ?? 5_000) : null;
      await client.open(file, payload.text);
      try {
        switch (op) {
          case "diagnostics": await diagnosticsDone; return await projectDiagnostics(root, file);
          case "hover": return [await client.request("textDocument/hover", { textDocument, position })].filter(Boolean);
          case "definition": return asList(await client.request("textDocument/definition", { textDocument, position }));
          case "references": return asList(await client.request("textDocument/references", { textDocument, position, context: { includeDeclaration: true } }));
          case "symbols": return asList(await client.request("textDocument/documentSymbol", { textDocument }));
          case "rename": return [await client.request("textDocument/rename", { textDocument, position, newName: payload.newName })].filter(Boolean);
        }
        return [];
      } finally {
        // Unsaved text never stays: the file is opened again from disk.
        if (payload.text !== undefined) await client.open(file);
      }
    };
    if (payload.text === undefined) return use();
    // One unsaved-text request at a time.
    const next = textLane.then(use, use);
    textLane = next.catch(() => undefined);
    return next;
  }

  return {
    run,
    close(): void {
      for (const pending of clients.values()) void pending.then((client) => client?.close());
      clients.clear();
    },
  };
}
