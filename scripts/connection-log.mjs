#!/usr/bin/env node

// Runs a command and, while it runs, records the machine's TCP connection state to a JSON Lines file.
// Built for the intermittent Windows CI browser failure `net::ERR_NO_BUFFER_SPACE`: the browser trace shows
// the operating system refusing a connection but cannot show why, so the evidence has to be taken from the
// machine itself, over the whole run, not in a step that only starts after the failure.
//
//   node scripts/connection-log.mjs --out ci-diagnostics -- npm run release:check
//
// The log never changes the command's result: a sampler that cannot read the connections writes a
// `sampler-error` record and the command carries on.

import { execFile, spawn } from "node:child_process";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(import.meta.url);
// Windows hands out outgoing ports from 49152 upward unless the machine says otherwise.
const DEFAULT_DYNAMIC_PORT_START = 49152;

function splitEndpoint(endpoint) {
  const split = endpoint.lastIndexOf(":");
  return { address: endpoint.slice(0, split).replace(/^\[|\]$/g, ""), port: Number.parseInt(endpoint.slice(split + 1), 10) };
}

const isLoopback = (address) => address === "::1" || address.startsWith("127.");

function bump(counts, key) {
  counts[key] = (counts[key] || 0) + 1;
}

export function summarizeNetstat(text, { dynamicPortRange = null } = {}) {
  const byState = {};
  const loopbackByState = {};
  const loopbackByServicePort = {};
  const perProcess = new Map();
  const dynamicPorts = new Set();
  const isDynamic = (port) => (dynamicPortRange
    ? port >= dynamicPortRange.start && port < dynamicPortRange.start + dynamicPortRange.count
    : port >= DEFAULT_DYNAMIC_PORT_START);
  let total = 0;
  let ownerless = 0;
  for (const line of String(text).split(/\r?\n/)) {
    const row = line.match(/^\s*TCP\s+(\S+)\s+(\S+)\s+([A-Z_]+)\s+(\d+)\s*$/);
    if (!row) continue;
    const local = splitEndpoint(row[1]);
    const foreign = splitEndpoint(row[2]);
    const state = row[3];
    const pid = Number.parseInt(row[4], 10);
    total += 1;
    bump(byState, state);
    if (pid === 0) ownerless += 1;
    else perProcess.set(pid, (perProcess.get(pid) || 0) + 1);
    if (dynamicPortRange && isDynamic(local.port)) dynamicPorts.add(local.port);
    if (!isLoopback(local.address)) continue;
    bump(loopbackByState, state);
    if (state === "LISTENING") continue;
    bump(loopbackByServicePort, !isDynamic(foreign.port) ? foreign.port : !isDynamic(local.port) ? local.port : "ephemeral");
  }
  return {
    total,
    byState,
    loopbackByState,
    ownerless,
    topProcesses: [...perProcess].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, 5).map(([pid, count]) => ({ pid, count })),
    dynamicPortsInUse: dynamicPortRange ? dynamicPorts.size : null,
    loopbackByServicePort: Object.fromEntries(Object.entries(loopbackByServicePort).sort((a, b) => b[1] - a[1]).slice(0, 8)),
  };
}

export function parseDynamicPortRange(text) {
  const start = String(text).match(/Start Port\s*:\s*(\d+)/);
  const count = String(text).match(/Number of Ports\s*:\s*(\d+)/);
  return start && count ? { start: Number.parseInt(start[1], 10), count: Number.parseInt(count[1], 10) } : null;
}

// npm announces each script it starts with a line like `> favsense-xhs@0.1.0 test:e2e`.
export function phaseFromLine(line) {
  const match = String(line).trim().match(/^> \S+@\S+ (\S+)$/);
  return match ? match[1] : null;
}

async function run(file, args) {
  return (await execFileAsync(file, args, { maxBuffer: 64 * 1024 * 1024, windowsHide: true })).stdout;
}

async function readNetstat() {
  return run("netstat", ["-ano"]);
}

async function readEnvironment() {
  // Only the two values that govern how fast outgoing ports free up; an absent value means the Windows default.
  const key = "HKLM\\SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters";
  const tcpParameters = {};
  for (const name of ["TcpTimedWaitDelay", "MaxUserPort"]) {
    tcpParameters[name] = await run("reg", ["query", key, "/v", name]).catch(() => "not set");
  }
  return {
    dynamicPort: await run("netsh", ["int", "ipv4", "show", "dynamicport", "tcp"]),
    excludedPorts: await run("netsh", ["int", "ipv4", "show", "excludedportrange", "protocol=tcp"]),
    tcpParameters,
  };
}

async function readProcessNames() {
  const names = new Map();
  for (const line of (await run("tasklist", ["/fo", "csv", "/nh"])).split(/\r?\n/)) {
    const row = line.match(/^"([^"]*)","(\d+)"/);
    if (row) names.set(Number.parseInt(row[2], 10), row[1]);
  }
  return names;
}

export async function runWithConnectionLog({
  command,
  outDir,
  intervalMs = 1000,
  cwd = process.cwd(),
  stdout = process.stdout,
  readNetstat: netstat = readNetstat,
  readEnvironment: environment = readEnvironment,
  readProcessNames: processNames = readProcessNames,
}) {
  await mkdir(outDir, { recursive: true });
  const logFile = join(outDir, "connections.jsonl");
  await writeFile(logFile, "");
  let queue = Promise.resolve();
  const log = (record) => { queue = queue.then(() => appendFile(logFile, `${JSON.stringify(record)}\n`)); return queue; };
  const startedAt = Date.now();
  const lastErrors = new Map();
  const logError = (where, error) => {
    const message = String(error?.message || error);
    if (lastErrors.get(where) === message) return;
    lastErrors.set(where, message);
    log({ type: "sampler-error", at: new Date().toISOString(), where, message });
  };

  let dynamicPortRange = null;
  try {
    const env = await environment();
    dynamicPortRange = parseDynamicPortRange(env.dynamicPort);
    await log({ type: "environment", at: new Date().toISOString(), dynamicPortRange, ...env });
  } catch (error) {
    logError("environment", error);
  }

  let phase = null;
  const names = new Map();
  let peak = -1;
  const sampleOnce = async () => {
    try {
      const text = await netstat();
      const summary = summarizeNetstat(text, { dynamicPortRange });
      if (summary.topProcesses.some(({ pid }) => !names.has(pid))) {
        try { for (const [pid, name] of await processNames()) names.set(pid, name); } catch { /* names are a convenience */ }
      }
      summary.topProcesses = summary.topProcesses.map((entry) => ({ ...entry, name: names.get(entry.pid) ?? null }));
      await log({ type: "sample", at: new Date().toISOString(), elapsedMs: Date.now() - startedAt, phase, ...summary });
      if (summary.total > peak) {
        peak = summary.total;
        await writeFile(join(outDir, "netstat-peak.txt"), text);
      }
    } catch (error) {
      logError("netstat", error);
    }
  };

  let stopped = false;
  let wake = () => {};
  const sampler = (async () => {
    while (!stopped) {
      await sampleOnce();
      if (stopped) break;
      await new Promise((done) => { wake = done; setTimeout(done, intervalMs).unref(); });
    }
  })();

  const exitCode = await new Promise((done) => {
    const child = spawn(command, { shell: true, cwd, stdio: ["inherit", "pipe", "inherit"], windowsHide: true });
    let pending = "";
    child.stdout.on("data", (chunk) => {
      stdout.write(chunk);
      pending += chunk.toString("utf8");
      const lines = pending.split("\n");
      pending = lines.pop();
      for (const line of lines) phase = phaseFromLine(line) ?? phase;
    });
    child.on("error", (error) => { logError("command", error); done(1); });
    child.on("close", (code) => done(code ?? 1));
  });

  stopped = true;
  wake();
  await sampler;
  await sampleOnce();
  await log({ type: "end", exitCode, at: new Date().toISOString() });
  await queue;
  return { exitCode };
}

function parseArguments(argv) {
  const separator = argv.indexOf("--");
  const options = separator < 0 ? argv : argv.slice(0, separator);
  const command = separator < 0 ? "" : argv.slice(separator + 1).join(" ");
  const value = (flag) => { const at = options.indexOf(flag); return at >= 0 ? options[at + 1] : undefined; };
  return { outDir: value("--out"), intervalMs: value("--interval-ms") ? Number.parseInt(value("--interval-ms"), 10) : undefined, command };
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  const { outDir, intervalMs, command } = parseArguments(process.argv.slice(2));
  if (!outDir || !command) {
    console.error("usage: node scripts/connection-log.mjs --out <folder> [--interval-ms <n>] -- <command>");
    process.exitCode = 2;
  } else {
    const { exitCode } = await runWithConnectionLog({ command, outDir: resolve(outDir), intervalMs, cwd: resolve(dirname(scriptPath), "..") });
    process.exitCode = exitCode;
  }
}
