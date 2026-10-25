import { omnirushPluginPath } from "./omnirush-extensions-plugin-path.js";
/** The 2.x engine's session plugin (gateway chat headers, shell secrets). */
export const sessionNextPluginPath = (): string => omnirushPluginPath("omnirush-session-next");
export function managedPolicyPluginPath(next = false): string {
  return omnirushPluginPath(next ? "managed-policy-next" : "managed-policy");
}
