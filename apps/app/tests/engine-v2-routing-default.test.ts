import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";

const source = readFileSync(fileURLToPath(new URL("../src/react-app/shell/use-workspace-route-state.ts", import.meta.url)), "utf8");

test("the sidebar starts on the 2.x engine and goes back to 1.x only for a server without the routing status", () => {
  expect(source).toContain("useState(true);");
  expect(source).not.toContain("setEngineV2ChatRouting(false);\n    setEngineRoutingReady(false);");
  expect(source).not.toMatch(/if \(!routingServerUrl \|\| !routingServerToken\) \{\s*setEngineV2ChatRouting\(false\)/);
  expect(source).toMatch(/error\.status === 404\) \{\s*setEngineV2ChatRouting\(false\);/);
});
