import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";

const source = readFileSync(fileURLToPath(new URL("../src/react-app/shell/settings-route.tsx", import.meta.url)), "utf8");

test("Advanced settings no longer show the agent-permissions panel, which read the 1.x engine the app no longer runs", () => {
  expect(source).not.toContain("<EffectivePermissionsPanel");
});
