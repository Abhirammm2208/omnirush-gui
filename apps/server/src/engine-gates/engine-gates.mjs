// Shared by omnirush-cli and omnirush-gui, byte for byte (PARITY.sha256). Engine: omnirush fork of opencode 2.0.32.
//
// Env for the engine process that turns on the engine's gates (fork patches 0003, 0004, 0005):
// - Provider lock and MCP fail-closed: OMNIRUSH_GATE_PROVIDERS / OMNIRUSH_GATE_MCP. The engine core turns
//   them into policies evaluated after every config layer (system, global, OPENCODE_CONFIG, project,
//   OPENCODE_CONFIG_CONTENT), so no config file can outrank them, and a missing or invalid config file
//   cannot drop them. With the gate on, an empty or malformed list denies everything.
// - Project code: the engine drops plugins, shell, formatter, lsp, mcp, providers, update, share, websearch,
//   agent request overlays and .opencode/plugin(s) from project config unless OMNIRUSH_PROJECT_CODE=1
//   (a user opt-in; this module never sets it).
// - Isolation from a stock opencode setup: OMNIRUSH_NO_SYSTEM_CONFIG skips /etc/opencode,
//   /Library/Application Support/opencode, %ProgramData%\opencode, the ai.opencode.managed.plist MDM file and
//   the home-level ~/.claude and ~/.agents skill dirs (project .claude/.agents still load).
// - Models fetch off (OPENCODE_DISABLE_MODELS_FETCH).
//
// Merge the result over the user's env (spread it last). Define the gateway provider and the allowed MCP
// servers in the app's own config (OPENCODE_CONFIG_DIR or OPENCODE_CONFIG), never through
// OPENCODE_CONFIG_CONTENT: that layer ranks below project files.

const NAME = /^[A-Za-z0-9_.-]+$/

/**
 * @param {{ provider?: string, mcp?: readonly string[] }} [options]
 * @returns {Record<string, string>}
 */
export function gateEnv(options = {}) {
  const provider = options.provider ?? "omnirush"
  const mcp = options.mcp ?? []
  // A wildcard or separator in a name would widen or split a rule; refuse instead of guessing.
  for (const item of [provider, ...mcp]) {
    if (typeof item !== "string" || !NAME.test(item)) throw new Error(`engine gate: invalid name ${JSON.stringify(item)}`)
  }
  return {
    OMNIRUSH_GATE_PROVIDERS: provider,
    OMNIRUSH_GATE_MCP: mcp.join(","),
    OMNIRUSH_NO_SYSTEM_CONFIG: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
  }
}
