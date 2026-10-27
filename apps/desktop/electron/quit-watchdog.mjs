// The quit's last resort: a teardown that has not finished in time (a stop
// stuck behind an engine restart after a sign-out, an upload that never ends)
// must not leave the window and the engine running. When the watchdog fires,
// every process this app started (the engine and its children, helpers,
// Electron's own) is killed and the app exits.
import { spawnSync } from "node:child_process";

/** Longer than a normal teardown can take: box checkpoints (10 s) + capture stop (20 s) + the engine's stop. */
export const QUIT_WATCHDOG_MS = 45_000;

/** Every pid below `rootPid` in `rows` ({pid, ppid}), children before their parents' siblings. */
export function descendantPids(rows, rootPid) {
  const children = new Map();
  for (const { pid, ppid } of rows) {
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid).push(pid);
  }
  const found = [];
  const seen = new Set([rootPid]);
  const queue = [rootPid];
  while (queue.length) {
    for (const child of children.get(queue.shift()) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      found.push(child);
      queue.push(child);
    }
  }
  return found;
}

/** This machine's processes as {pid, ppid} (empty when they cannot be listed). */
export function listProcesses(platform = process.platform, run = spawnSync) {
  const result = platform === "win32"
    ? run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId) $($_.ParentProcessId)\" }"], { encoding: "utf8", windowsHide: true, timeout: 10_000 })
    : run("ps", ["-Ao", "pid=,ppid="], { encoding: "utf8", timeout: 5_000 });
  return String(result?.stdout ?? "").split(/\r?\n/).flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)$/);
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]) }] : [];
  });
}

/** Kills every process below `rootPid` (Windows: taskkill /F; elsewhere SIGKILL). Returns the pids it went for. */
export function killDescendants({ rootPid = process.pid, platform = process.platform, run = spawnSync, kill = process.kill.bind(process) } = {}) {
  const listing = { pid: -1 };
  // The listing's own process (powershell / ps) has ended by now: its pid is left out.
  const pids = descendantPids(listProcesses(platform, (...args) => Object.assign(listing, run(...args))), rootPid).filter((pid) => pid !== listing.pid);
  if (!pids.length) return pids;
  if (platform === "win32") {
    run("taskkill", ["/F", ...pids.flatMap((pid) => ["/PID", String(pid)])], { windowsHide: true, timeout: 10_000 });
  } else {
    for (const pid of pids) {
      try { kill(pid, "SIGKILL"); } catch { /* already gone */ }
    }
  }
  return pids;
}

/**
 * Armed once when the quit's teardown starts: after `timeoutMs` the app's
 * processes are killed and `exit` runs. Returns a disarm (the teardown ended).
 */
export function armQuitWatchdog({ timeoutMs = QUIT_WATCHDOG_MS, killAll = () => killDescendants(), exit, log = () => undefined, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const timer = setTimer(() => {
    log(`quit did not finish in ${Math.round(timeoutMs / 1000)} s: ending the engine and the app's other processes`);
    let pids = [];
    try { pids = killAll(); } catch (error) { log(`killing the app's processes failed: ${error?.message ?? error}`); }
    log(`killed ${pids.length} process(es)`);
    exit();
  }, timeoutMs);
  timer?.unref?.();
  return () => clearTimer(timer);
}
