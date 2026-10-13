#!/usr/bin/env node
// Take and release the organization mutation lock over and over, from its own process.
//
// Run by tests/organization-lock-handoff.test.mjs, several copies at once next to the Python writer's
// lock_stress_worker.py, to prove that writers handing the lock to each other never fail or get stuck.
// A JS writer that finds a live holder is refused at once by design, so this worker retries that one
// answer itself, after a short random pause. Anything else is a failure.
// Prints one JSON line: cycles done, the failures seen, how often it was told "already running", and the
// longest single call to acquireOrganizationMutationLock, in milliseconds.
//
// Usage: lock-stress-worker.mjs <workspace root> <cycles> <hold milliseconds>

import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const MAX_RECORDED_FAILURES = 5;
const [root, cycles, holdMs] = process.argv.slice(2);
const { acquireOrganizationMutationLock } = await import(
  pathToFileURL(resolve(import.meta.dirname, "..", "scripts", "organization-mutation-lock.mjs")).href
);

const sleep = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds));
const busyMessage = "ORGANIZATION_MUTATION_ALREADY_RUNNING";

let done = 0;
let busyAnswers = 0;
let longestCallMs = 0;
const failures = [];
let failureCount = 0;
const fail = (error) => {
  failureCount += 1;
  if (failures.length < MAX_RECORDED_FAILURES) failures.push(`${error?.code ?? error?.name}: ${error?.message}`);
};

for (let cycle = 0; cycle < Number(cycles); cycle += 1) {
  let release = null;
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
  await sleep(Number(holdMs));
  try {
    await release();
    done += 1;
  } catch (error) {
    fail(error);
    break;
  }
  await sleep(5 + Math.random() * 10);
}

process.stdout.write(`${JSON.stringify({
  cycles_done: done,
  failure_count: failureCount,
  failures,
  busy_answers: busyAnswers,
  longest_call_ms: Math.round(longestCallMs),
})}\n`);
