import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseDynamicPortRange, phaseFromLine, runWithConnectionLog, summarizeNetstat } from "./connection-log.mjs";

// A trimmed copy of what `netstat -ano` prints on Windows: loopback and LAN rows, IPv6 rows, a UDP row
// (no state column), and TIME_WAIT rows that belong to no process (PID 0).
const NETSTAT = `
Active Connections

  Proto  Local Address          Foreign Address        State           PID
  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       2124
  TCP    127.0.0.1:8767         0.0.0.0:0              LISTENING       4100
  TCP    127.0.0.1:50200        127.0.0.1:8767         ESTABLISHED     8784
  TCP    127.0.0.1:50201        127.0.0.1:8767         TIME_WAIT       0
  TCP    127.0.0.1:50202        127.0.0.1:8767         TIME_WAIT       0
  TCP    192.168.0.157:49673    192.168.0.1:53         TIME_WAIT       0
  TCP    [::]:445               [::]:0                 LISTENING       4
  TCP    [::1]:50300            [::1]:8766             ESTABLISHED     4100
  UDP    0.0.0.0:53             *:*                                    5852
`;

const NETSH_DYNAMIC_PORT = `
Protocol tcp Dynamic Port Range
---------------------------------
Start Port      : 49152
Number of Ports : 16384

`;

test("counts TCP connections by state, on loopback and overall, and by owning process", () => {
  const summary = summarizeNetstat(NETSTAT, { dynamicPortRange: { start: 49152, count: 16384 } });
  assert.deepEqual(summary, {
    total: 8,
    byState: { LISTENING: 3, ESTABLISHED: 2, TIME_WAIT: 3 },
    loopbackByState: { LISTENING: 1, ESTABLISHED: 2, TIME_WAIT: 2 },
    ownerless: 3,
    topProcesses: [{ pid: 4100, count: 2 }, { pid: 4, count: 1 }, { pid: 2124, count: 1 }, { pid: 8784, count: 1 }],
    dynamicPortsInUse: 5,
    loopbackByServicePort: { 8767: 3, 8766: 1 },
  });
});

test("does not claim a dynamic port count when the range is unknown", () => {
  assert.equal(summarizeNetstat(NETSTAT).dynamicPortsInUse, null);
});

test("an empty or unreadable listing summarises to zero connections", () => {
  assert.equal(summarizeNetstat("").total, 0);
  assert.equal(summarizeNetstat("netstat: command not found").total, 0);
});

test("reads the dynamic port range from the netsh listing and refuses text without one", () => {
  assert.deepEqual(parseDynamicPortRange(NETSH_DYNAMIC_PORT), { start: 49152, count: 16384 });
  assert.equal(parseDynamicPortRange("The syntax of this command is:"), null);
});

test("names the npm script a line of output announces, and nothing else", () => {
  assert.equal(phaseFromLine("> favsense-xhs@0.1.0 test:e2e"), "test:e2e");
  assert.equal(phaseFromLine("> favsense-xhs@0.1.0 release:check\r"), "release:check");
  assert.equal(phaseFromLine("> node scripts/run-python-tests.mjs"), null);
  assert.equal(phaseFromLine("Running 68 tests using 1 worker"), null);
});

async function childScript(dir, body) {
  const file = join(dir, "child.mjs");
  await writeFile(file, body);
  return file;
}

function memoryStream() {
  const chunks = [];
  return { write(chunk) { chunks.push(String(chunk)); return true; }, text: () => chunks.join("") };
}

async function jsonLines(file) {
  return (await readFile(file, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

test("runs the command to its end, keeps its exit code and output, and logs the environment, samples and the phase", async () => {
  const dir = await mkdtemp(join(tmpdir(), "favsense-connlog-"));
  const child = await childScript(dir, [
    'console.log("> favsense-xhs@0.1.0 test:e2e");',
    'console.log("child output line");',
    "setTimeout(() => process.exit(3), 300);",
  ].join("\n"));
  const stdout = memoryStream();
  const result = await runWithConnectionLog({
    command: `"${process.execPath}" "${child}"`,
    outDir: join(dir, "out"),
    intervalMs: 40,
    stdout,
    readNetstat: async () => NETSTAT,
    readEnvironment: async () => ({ dynamicPort: NETSH_DYNAMIC_PORT, excludedPorts: "excluded listing" }),
    readProcessNames: async () => new Map([[4100, "node.exe"]]),
  });
  assert.equal(result.exitCode, 3);
  assert.match(stdout.text(), /child output line/);

  const records = await jsonLines(join(dir, "out", "connections.jsonl"));
  assert.equal(records[0].type, "environment");
  assert.deepEqual(records[0].dynamicPortRange, { start: 49152, count: 16384 });
  assert.equal(records[0].excludedPorts, "excluded listing");
  const samples = records.filter((record) => record.type === "sample");
  assert.ok(samples.length >= 2, "sampled while the command ran and once more at the end");
  assert.equal(samples.at(-1).phase, "test:e2e");
  assert.equal(samples.at(-1).total, 8);
  assert.equal(samples.at(-1).byState.TIME_WAIT, 3);
  assert.deepEqual(samples.at(-1).topProcesses[0], { pid: 4100, count: 2, name: "node.exe" });
  assert.deepEqual(records.at(-1), { type: "end", exitCode: 3, at: records.at(-1).at });
  assert.equal(await readFile(join(dir, "out", "netstat-peak.txt"), "utf8"), NETSTAT);
});

test("a sampler that cannot read the connections never changes the command's result", async () => {
  const dir = await mkdtemp(join(tmpdir(), "favsense-connlog-"));
  const child = await childScript(dir, 'console.log("still ran");\n');
  const stdout = memoryStream();
  const result = await runWithConnectionLog({
    command: `"${process.execPath}" "${child}"`,
    outDir: join(dir, "out"),
    intervalMs: 40,
    stdout,
    readNetstat: async () => { throw new Error("netstat exploded"); },
    readEnvironment: async () => { throw new Error("netsh exploded"); },
    readProcessNames: async () => new Map(),
  });
  assert.equal(result.exitCode, 0);
  assert.match(stdout.text(), /still ran/);
  const records = await jsonLines(join(dir, "out", "connections.jsonl"));
  assert.ok(records.some((record) => record.type === "sampler-error" && /netstat exploded/.test(record.message)));
  assert.ok(records.some((record) => record.type === "sampler-error" && /netsh exploded/.test(record.message)));
  assert.equal(records.at(-1).type, "end");
});

// --- The CI workflow must run the Windows gate under the log and keep it when the gate fails ---

async function workflowSteps() {
  const text = (await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8")).replaceAll("\r\n", "\n");
  return text.split(/^      - name: /m).slice(1);
}

test("windows_runs_the_release_gate_under_the_connection_log_and_ubuntu_runs_it_unchanged", async () => {
  const steps = await workflowSteps();
  const gates = steps.filter((step) => step.startsWith("Run the complete release gate"));
  assert.equal(gates.length, 2, "one gate step per platform");
  const windows = gates.find((step) => /^\s+if: runner\.os == 'Windows'$/m.test(step));
  const other = gates.find((step) => /^\s+if: runner\.os != 'Windows'$/m.test(step));
  assert.ok(windows && other, "the gate steps are split by platform");
  assert.match(windows, /^\s+run: node scripts\/connection-log\.mjs --out ci-diagnostics -- npm run release:check$/m);
  assert.match(other, /^\s+run: npm run release:check$/m);
});

test("the_windows_connection_log_is_uploaded_when_the_gate_fails", async () => {
  const steps = await workflowSteps();
  const upload = steps.find((step) => /uses: actions\/upload-artifact@v\d+/.test(step) && /ci-diagnostics/.test(step));
  assert.ok(upload, "an upload step carries the connection log");
  assert.match(upload, /^\s+if: failure\(\) && runner\.os == 'Windows'$/m);
  assert.match(upload, /^\s+path: ci-diagnostics\/?$/m);
  assert.match(upload, /^\s+name: [^\n]*connection-log/m);
});
