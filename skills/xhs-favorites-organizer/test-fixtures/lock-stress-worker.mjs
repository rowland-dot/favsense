#!/usr/bin/env node
// Take and release the organization mutation lock over and over, from its own process.
//
// Run by tests/organization-lock-handoff.test.mjs, several copies at once next to the Python writer's
// lock-stress-python-worker.py, to prove that writers handing the lock to each other never fail or get
// stuck. A JS writer that finds a live holder is refused at once by design, so this worker retries that
// one answer itself, after a short random pause. Anything else is a failure.
//
// Every line on stdout is one JSON object, so a run that hangs can be explained by whoever started it:
//   {"event":"cycle","cycle":N}                              one full take-hold-release finished
//   {"event":"heartbeat","cycle":N,"phase":P,"phase_ms":T}   every 2 s: what it is doing and for how long
//   {"event":"final", ...}                                   cycles done, failures, longest single wait
//
// Usage: lock-stress-worker.mjs <workspace root> <cycles> <hold milliseconds>

import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const MAX_RECORDED_FAILURES = 5;
const HEARTBEAT_MS = 2_000;
const [root, cycles, holdMs] = process.argv.slice(2);
const { acquireOrganizationMutationLock } = await import(
  pathToFileURL(resolve(import.meta.dirname, "..", "scripts", "organization-mutation-lock.mjs")).href
);

const sleep = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds));
const busyMessage = "ORGANIZATION_MUTATION_ALREADY_RUNNING";
const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);

let done = 0;
let busyAnswers = 0;
let longestCallMs = 0;
let phase = "starting";
let phaseSince = performance.now();
const failures = [];
let failureCount = 0;
const enter = (name) => {
  phase = name;
  phaseSince = performance.now();
};
const fail = (error) => {
  failureCount += 1;
  if (failures.length < MAX_RECORDED_FAILURES) failures.push(`${error?.code ?? error?.name}: ${error?.message}`);
};

const heartbeat = setInterval(() => {
  emit({ event: "heartbeat", cycle: done, phase, phase_ms: Math.round(performance.now() - phaseSince), busy_answers: busyAnswers });
}, HEARTBEAT_MS);

for (let cycle = 0; cycle < Number(cycles); cycle += 1) {
  let release = null;
  enter("acquiring");
  while (!release) {
    const started = performance.now();
    try {
      release = await acquireOrganizationMutationLock(root);
      longestCallMs = Math.max(longestCallMs, performance.now() - started);
    } catch (error) {
      longestCallMs = Math.max(longestCallMs, performance.now() - started);
      if (error?.message !== busyMessage) {
        fail(error);
        break;
      }
      busyAnswers += 1;
      await sleep(1 + Math.random() * 4);
    }
  }
  if (!release) break;
  enter("holding");
  await sleep(Number(holdMs));
  enter("releasing");
  try {
    await release();
    done += 1;
  } catch (error) {
    fail(error);
    break;
  }
  emit({ event: "cycle", cycle: done });
  enter("resting");
  await sleep(5 + Math.random() * 10);
}

clearInterval(heartbeat);
emit({
  event: "final",
  cycles_done: done,
  failure_count: failureCount,
  failures,
  busy_answers: busyAnswers,
  longest_wait_ms: Math.round(longestCallMs),
});
