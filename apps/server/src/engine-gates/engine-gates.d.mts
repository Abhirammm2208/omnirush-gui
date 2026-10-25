// Types of engine-gates.mjs (shared with omnirush-cli byte for byte; PARITY.sha256 covers the .mjs).
export function gateEnv(options?: { provider?: string; mcp?: readonly string[] }): Record<string, string>;
