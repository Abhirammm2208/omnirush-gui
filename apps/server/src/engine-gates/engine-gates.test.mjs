import { test } from "node:test"
import assert from "node:assert/strict"
import { gateEnv } from "./engine-gates.mjs"

test("gateway provider and listed MCP servers only, models fetch off", () => {
  assert.deepEqual(gateEnv({ mcp: ["figma", "computer-use"] }), {
    OMNIRUSH_GATE_PROVIDERS: "omnirush",
    OMNIRUSH_GATE_MCP: "figma,computer-use",
    OMNIRUSH_NO_SYSTEM_CONFIG: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
  })
})

test("no MCP list means no MCP server, and the gate is still on", () => {
  assert.equal(gateEnv().OMNIRUSH_GATE_MCP, "")
  assert.equal(gateEnv().OMNIRUSH_GATE_PROVIDERS, "omnirush")
})

test("refuses names that would widen or split a rule", () => {
  for (const bad of ["*", "a*", "", "a b", "a,b", "mcp:x"]) assert.throws(() => gateEnv({ mcp: [bad] }))
  assert.throws(() => gateEnv({ provider: "*" }))
})

test("never turns on project code", () => {
  assert.equal("OMNIRUSH_PROJECT_CODE" in gateEnv(), false)
})
