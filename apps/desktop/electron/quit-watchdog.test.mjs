import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";

import { armQuitWatchdog, descendantPids, killDescendants, listProcesses } from "./quit-watchdog.mjs";

test("descendantPids: the whole tree below the app, nothing beside it, no loop on a reused pid", () => {
  const rows = [
    { pid: 10, ppid: 1 }, // the app
    { pid: 11, ppid: 10 }, { pid: 12, ppid: 10 }, // engine, gpu
    { pid: 13, ppid: 11 }, { pid: 14, ppid: 13 }, // engine's shell and its child
    { pid: 20, ppid: 1 }, { pid: 21, ppid: 20 }, // someone else's
    { pid: 10, ppid: 14 }, // a row naming the app as a child again
  ];
  assert.deepEqual(descendantPids(rows, 10).sort(), [11, 12, 13, 14]);
  assert.deepEqual(descendantPids(rows, 99), []);
});

test("Windows: one taskkill /F for every process below the app, never the listing's own powershell", () => {
  const calls = [];
  const run = (command, args) => {
    calls.push([command, args]);
    if (command === "powershell.exe") return { pid: 31, stdout: "10 1\r\n11 10\r\n13 11\r\n31 10\r\n40 1\r\n" };
    return { pid: 32, stdout: "" };
  };
  assert.deepEqual(killDescendants({ rootPid: 10, platform: "win32", run }), [11, 13]);
  assert.deepEqual(calls.at(-1), ["taskkill", ["/F", "/PID", "11", "/PID", "13"]]);
});

test("the watchdog kills and exits only when the teardown has not finished in time", async () => {
  const events = [];
  const disarm = armQuitWatchdog({ timeoutMs: 20, killAll: () => { events.push("kill"); return [1, 2]; }, exit: () => events.push("exit") });
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(events, ["kill", "exit"]);
  disarm();
  const quiet = [];
  const disarmQuiet = armQuitWatchdog({ timeoutMs: 20, killAll: () => { quiet.push("kill"); return []; }, exit: () => quiet.push("exit") });
  disarmQuiet();
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(quiet, []);
});

test("a real child tree (the engine and its shell) is killed", { skip: process.platform === "win32" }, async () => {
  // An "engine" that starts a long-lived child of its own.
  const engine = spawn(process.execPath, ["-e", "require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); setInterval(() => {}, 1000)"], { stdio: "ignore" });
  await new Promise((resolve) => setTimeout(resolve, 500));
  const before = descendantPids(listProcesses(), process.pid);
  assert.ok(before.includes(engine.pid), "the engine is listed below this process");
  assert.ok(before.length >= 2, "and its child too");
  const exited = new Promise((resolve) => engine.once("exit", (_code, signal) => resolve(signal)));
  killDescendants();
  assert.equal(await exited, "SIGKILL");
  await new Promise((resolve) => setTimeout(resolve, 200));
  const alive = before.filter((pid) => { try { process.kill(pid, 0); return true; } catch { return false; } });
  assert.deepEqual(alive, []);
});
