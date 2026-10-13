// The organization mutation lock when two writers hand it to each other (issue 95).
//
// The lock is a folder renamed into place. A writer that loses the rename watches the holder, and the
// holder deletes the folder when it is done. Every test here is about a moment where those two overlap.
// The Python side of the same lock (issue 76) has the matching tests in
// skills/xhs-diandian-summarize-note/tests/test_lock_handoff.py.
//
// Windows errors are produced with stand-ins at the file calls, so they run on every platform.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const lockModule = await import("../scripts/organization-mutation-lock.mjs");
const { acquireOrganizationMutationLock } = lockModule;
// A build that has not got the tunable timing yet gets a throwaway object, so its tests fail on the
// behaviour under test and not on a missing export.
const timing = lockModule.LOCK_TIMING ?? {};

const busyError = () => new Error("TEST_BUSY");
const invalidError = () => new Error("TEST_INVALID");
const acquire = (root) => acquireOrganizationMutationLock(root, { busyError, invalidError });

const SHORT_WAIT_MS = 300;
const savedTiming = { ...timing };
test.afterEach(() => {
  for (const key of Object.keys(savedTiming)) timing[key] = savedTiming[key];
});

function workspace(context) {
  const root = fs.mkdtempSync(path.join(tmpdir(), "favsense-lock-handoff-"));
  const migration = path.join(root, ".xhs-favorites", "organization-migration");
  fs.mkdirSync(migration, { recursive: true });
  // A reader process that is still shutting down can keep a folder from being deleted for a moment.
  context.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  return { root, migration, lock: path.join(migration, ".apply-lock") };
}

// The lock as another writer leaves it. A dead writer's process number is one that has already exited.
function holdAsAnotherWriter(lock, pid = process.pid) {
  fs.mkdirSync(lock, { recursive: true });
  fs.writeFileSync(path.join(lock, "owner.json"), `${JSON.stringify({ schema_version: 1, pid, nonce: "another-writer" })}\n`);
}

function deadProcessNumber() {
  return spawnSync(process.execPath, ["-e", "0"]).pid;
}

function releaseAsAnotherWriter(lock) {
  fs.rmSync(lock, { recursive: true, force: true });
}

function fileError(code) {
  return Object.assign(new Error(`${code}: simulated`), { code, syscall: "simulated" });
}

// Replace some file calls with stand-ins that can see the real call. Returns the way back.
function standIn(replacements) {
  const originals = {};
  for (const [name, make] of Object.entries(replacements)) {
    originals[name] = fsPromises[name];
    fsPromises[name] = make(originals[name]);
  }
  syncBuiltinESMExports();
  return () => {
    for (const [name, original] of Object.entries(originals)) fsPromises[name] = original;
    syncBuiltinESMExports();
  };
}

const samePath = (left, right) => path.resolve(String(left)) === path.resolve(String(right));

async function withStandIns(replacements, body) {
  const restore = standIn(replacements);
  try {
    return await body();
  } finally {
    restore();
  }
}

async function enterAndLeave(root) {
  const release = await acquire(root);
  await release();
}

// ---------------------------------------------------------------------------------------------
// Waiting for a lock the other writer has just released
// ---------------------------------------------------------------------------------------------

for (const code of ["EPERM", "ENOTEMPTY"]) {
  test(`a rename that failed with ${code} while the lock was already released is tried again`, async (context) => {
    const { root, lock } = workspace(context);
    let refused = 0;
    await withStandIns({
      rename: (real) => async (source, target) => {
        if (samePath(target, lock) && refused === 0) {
          refused += 1;
          throw fileError(code); // the other writer's release landed in between: no lock is there now
        }
        return real(source, target);
      },
    }, () => enterAndLeave(root));
    assert.equal(refused, 1, "the failed rename must actually have happened");
    assert.equal(fs.existsSync(lock), false);
  });
}

for (const code of ["ENOENT", "EPERM", "EBUSY", "EACCES"]) {
  test(`an owner file that cannot be read (${code}) because the holder is deleting it is a released lock`, async (context) => {
    const { root, lock } = workspace(context);
    holdAsAnotherWriter(lock);
    let refused = 0;
    await withStandIns({
      readFile: (real) => async (target, ...rest) => {
        if (samePath(target, path.join(lock, "owner.json")) && refused === 0) {
          refused += 1;
          releaseAsAnotherWriter(lock);
          throw fileError(code);
        }
        return real(target, ...rest);
      },
    }, () => enterAndLeave(root));
    assert.equal(refused, 1, "the failed read must actually have happened");
    assert.equal(fs.existsSync(lock), false);
  });
}

test("a lock folder that has no owner file yet, and is deleted a moment later, is a released lock", async (context) => {
  const { root, lock } = workspace(context);
  fs.mkdirSync(lock);
  // Something else is left in the folder (a half-deleted lock), so no platform renames onto it.
  fs.writeFileSync(path.join(lock, "left-behind.tmp"), "x");
  setTimeout(() => releaseAsAnotherWriter(lock), 60);
  await enterAndLeave(root);
  assert.equal(fs.existsSync(lock), false);
});

test("a stale lock taken over, then lost to another writer who releases it at once, is tried again", async (context) => {
  const { root, lock } = workspace(context);
  holdAsAnotherWriter(lock, deadProcessNumber());
  let attempts = 0;
  await withStandIns({
    rename: (real) => async (source, target) => {
      if (samePath(target, lock)) {
        attempts += 1;
        // 1: the first try, refused because the stale lock is there. 2: right after taking the stale
        // lock over, another waiter got in and has already released again.
        if (attempts === 2) throw fileError("EPERM");
      }
      return real(source, target);
    },
  }, () => enterAndLeave(root));
  assert.equal(attempts, 3, "the lost takeover must actually have happened");
  assert.equal(fs.existsSync(lock), false);
});

// ---------------------------------------------------------------------------------------------
// A state that does not clear ends as "already running", never as "invalid" or a raw file error
// ---------------------------------------------------------------------------------------------

test("a rename that keeps failing with no lock in place ends as already running", async (context) => {
  const { root, lock } = workspace(context);
  timing.waitMs = SHORT_WAIT_MS;
  await withStandIns({
    rename: (real) => async (source, target) => {
      if (samePath(target, lock)) throw fileError("EPERM");
      return real(source, target);
    },
  }, () => assert.rejects(acquire(root), /TEST_BUSY/));
});

for (const code of ["ENOENT", "EPERM", "EBUSY", "EACCES"]) {
  test(`an owner file that stays unreadable (${code}) ends as already running`, async (context) => {
    const { root, lock } = workspace(context);
    holdAsAnotherWriter(lock);
    timing.waitMs = SHORT_WAIT_MS;
    await withStandIns({
      readFile: (real) => async (target, ...rest) => {
        if (samePath(target, path.join(lock, "owner.json"))) throw fileError(code);
        return real(target, ...rest);
      },
    }, () => assert.rejects(acquire(root), /TEST_BUSY/));
  });
}

test("a lock folder that never gets an owner file ends as already running", async (context) => {
  const { root, lock } = workspace(context);
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, "left-behind.tmp"), "x");
  timing.waitMs = SHORT_WAIT_MS;
  await assert.rejects(acquire(root), /TEST_BUSY/);
});

test("a stale lock taken over and then lost every time ends as already running", async (context) => {
  const { root, lock } = workspace(context);
  holdAsAnotherWriter(lock, deadProcessNumber());
  timing.waitMs = SHORT_WAIT_MS;
  let attempts = 0;
  await withStandIns({
    rename: (real) => async (source, target) => {
      if (samePath(target, lock)) {
        attempts += 1;
        if (attempts >= 2) throw fileError("EPERM");
      }
      return real(source, target);
    },
  }, () => assert.rejects(acquire(root), /TEST_BUSY/));
});

test("a stale lock taken over and then lost to a live writer ends as already running at once", async (context) => {
  const { root, lock } = workspace(context);
  holdAsAnotherWriter(lock, deadProcessNumber());
  timing.waitMs = 10_000;
  let attempts = 0;
  const started = Date.now();
  await withStandIns({
    rename: (real) => async (source, target) => {
      if (samePath(target, lock)) {
        attempts += 1;
        if (attempts === 2) {
          holdAsAnotherWriter(lock); // another waiter took the freed lock first and is running
          throw fileError("EPERM");
        }
      }
      return real(source, target);
    },
  }, () => assert.rejects(acquire(root), /TEST_BUSY/));
  assert.ok(Date.now() - started < 2_000, "a live holder must not be waited for");
});

// ---------------------------------------------------------------------------------------------
// What stays refused at once (these held before the change and must keep holding)
// ---------------------------------------------------------------------------------------------

test("a live holder is refused at once, not waited for", async (context) => {
  const { root, lock } = workspace(context);
  holdAsAnotherWriter(lock);
  timing.waitMs = 10_000;
  const started = Date.now();
  await assert.rejects(acquire(root), /TEST_BUSY/);
  assert.ok(Date.now() - started < 2_000);
});

test("an owner file that is not valid JSON is refused as invalid at once", async (context) => {
  const { root, lock } = workspace(context);
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, "owner.json"), "{not json");
  timing.waitMs = 10_000;
  const started = Date.now();
  await assert.rejects(acquire(root), /TEST_INVALID/);
  assert.ok(Date.now() - started < 2_000);
});

test("a lock that is a file instead of a folder is refused as invalid at once", async (context) => {
  const { root, lock } = workspace(context);
  fs.writeFileSync(lock, "not a folder");
  timing.waitMs = 10_000;
  const started = Date.now();
  await withStandIns({
    rename: (real) => async (source, target) => {
      // Not every platform refuses to move a folder onto a file; the refusal is what is being stood in for.
      if (samePath(target, lock)) throw fileError("EEXIST");
      return real(source, target);
    },
  }, () => assert.rejects(acquire(root), /TEST_INVALID/));
  assert.ok(Date.now() - started < 2_000);
});

// ---------------------------------------------------------------------------------------------
// Releasing the lock
// ---------------------------------------------------------------------------------------------

const pythonRunner = async () => {
  const { pythonCandidates, selectPython } = await import("../../../scripts/run-python-tests.mjs");
  return selectPython(pythonCandidates({ root: path.resolve(here, "..", "..", "..") }));
};

// A Python process that has the lock's owner file open for `seconds`. Python's open() does not allow the
// file to be deleted meanwhile, which is exactly what the Python writer's look at the owner file does.
// Node's own readers do allow it, so a test that reads from Node proves nothing here.
async function pythonReaderHolding(context, file, seconds) {
  const python = await pythonRunner();
  const reader = spawn(python.command, [
    ...python.prefixArgs,
    "-c",
    "import sys, time\nhandle = open(sys.argv[1], 'rb')\nprint('open', flush=True)\ntime.sleep(float(sys.argv[2]))",
    file,
    String(seconds),
  ], { stdio: ["ignore", "pipe", "inherit"], windowsHide: true });
  context.after(() => reader.kill());
  await new Promise((resolve, reject) => {
    reader.once("error", reject);
    reader.stdout.once("data", resolve);
  });
  return reader;
}

test("a release that Windows refuses while a Python writer reads the owner file succeeds once the reader lets go", { skip: process.platform !== "win32" }, async (context) => {
  const { root, lock } = workspace(context);
  const release = await acquire(root);
  await pythonReaderHolding(context, path.join(lock, "owner.json"), 0.3);
  await release();
  assert.equal(fs.existsSync(lock), false);
});

test("a release that Windows keeps refusing past the retry window fails instead of waiting for ever", { skip: process.platform !== "win32" }, async (context) => {
  const { root, lock } = workspace(context);
  timing.releaseMs = SHORT_WAIT_MS;
  const release = await acquire(root);
  const reader = await pythonReaderHolding(context, path.join(lock, "owner.json"), 4);
  const started = Date.now();
  await assert.rejects(release(), (error) => ["EBUSY", "EPERM"].includes(error.code));
  assert.ok(Date.now() - started < 2_000, "the release must give up soon after its retry window");
  const exited = new Promise((resolve) => reader.once("exit", resolve));
  reader.kill();
  await exited;
});

test("a delete the system refuses with a sharing error is retried and then succeeds", async (context) => {
  const { root, lock } = workspace(context);
  const release = await acquire(root);
  let refused = 0;
  await withStandIns({
    rm: (real) => async (target, ...rest) => {
      if (samePath(target, lock) && refused < 2) {
        refused += 1;
        throw fileError(refused === 1 ? "EBUSY" : "EPERM");
      }
      return real(target, ...rest);
    },
  }, () => release());
  assert.equal(refused, 2);
  assert.equal(fs.existsSync(lock), false);
});

test("a sharing error that never clears fails after the retry window", async (context) => {
  const { root, lock } = workspace(context);
  timing.releaseMs = SHORT_WAIT_MS;
  const release = await acquire(root);
  let attempts = 0;
  await withStandIns({
    rm: (real) => async (target, ...rest) => {
      if (samePath(target, lock)) {
        attempts += 1;
        throw fileError("EBUSY");
      }
      return real(target, ...rest);
    },
  }, () => assert.rejects(release(), { code: "EBUSY" }));
  assert.ok(attempts > 1, "the delete must have been tried more than once");
});

test("any other delete error fails at once", async (context) => {
  const { root, lock } = workspace(context);
  const release = await acquire(root);
  let attempts = 0;
  await withStandIns({
    rm: (real) => async (target, ...rest) => {
      if (samePath(target, lock)) {
        attempts += 1;
        throw fileError("EIO");
      }
      return real(target, ...rest);
    },
  }, () => assert.rejects(release(), { code: "EIO" }));
  assert.equal(attempts, 1);
});

test("a lock another writer took after ours was released is left alone", async (context) => {
  const { root, lock } = workspace(context);
  const release = await acquire(root);
  releaseAsAnotherWriter(lock);
  holdAsAnotherWriter(lock);
  await release();
  assert.equal(JSON.parse(fs.readFileSync(path.join(lock, "owner.json"), "utf8")).nonce, "another-writer");
});

// A release that gives up quietly leaves the lock on disk with the live process's number in it, and that
// process then waits for itself for ever. This is how one stuck run on CI looked (issue 95).
for (const code of ["EBUSY", "EPERM", "EACCES"]) {
  test(`a release whose read of the owner file is refused (${code}) still deletes the lock`, async (context) => {
    const { root, lock } = workspace(context);
    const release = await acquire(root);
    let refused = 0;
    await withStandIns({
      readFile: (real) => async (target, ...rest) => {
        if (samePath(target, path.join(lock, "owner.json")) && refused < 2) {
          refused += 1;
          throw fileError(code);
        }
        return real(target, ...rest);
      },
    }, () => release());
    assert.equal(refused, 2, "the refused reads must actually have happened");
    assert.equal(fs.existsSync(lock), false, "the release gave up and left the lock behind");
  });
}

test("an owner file that stays unreadable at release is reported, not skipped", async (context) => {
  const { root, lock } = workspace(context);
  timing.releaseMs = SHORT_WAIT_MS;
  const release = await acquire(root);
  await withStandIns({
    readFile: (real) => async (target, ...rest) => {
      if (samePath(target, path.join(lock, "owner.json"))) throw fileError("EBUSY");
      return real(target, ...rest);
    },
  }, () => assert.rejects(release(), { code: "EBUSY" }));
  assert.equal(fs.existsSync(lock), true);
});

test("a lock that is already gone when its holder releases is not an error", async (context) => {
  const { root, lock } = workspace(context);
  const release = await acquire(root);
  releaseAsAnotherWriter(lock);
  await release();
});

// ---------------------------------------------------------------------------------------------
// The snapshot builder's own lock, and the order it lets go of its two locks
// ---------------------------------------------------------------------------------------------

const SNAPSHOT_COMMON = {
  sealedScopeDigest: "a".repeat(64),
  curationInputDigest: "b".repeat(64),
  configDigest: "c".repeat(64),
  inputRevisionDigest: "d".repeat(64),
  effectiveDate: "2026-10-13",
};

function snapshotWorkspace(context) {
  const { root, lock: mutationLock } = workspace(context);
  const publicTarget = path.join(root, "knowledge.json");
  fs.writeFileSync(publicTarget, JSON.stringify({ meta: { buildVersion: "old" } }));
  return {
    root,
    mutationLock,
    snapshotLock: path.join(root, ".xhs-tools", "organization-snapshots", ".organization-snapshot-lock"),
    options: {
      root,
      publicTarget,
      ...SNAPSHOT_COMMON,
      buildPublicSite: async ({ target, buildVersion }) => {
        await fsPromises.writeFile(target, JSON.stringify({ meta: { buildVersion } }));
      },
    },
  };
}

test("a snapshot lock whose holder released it during the rename is tried again", async (context) => {
  const { buildOrganizationSnapshot } = await import("../scripts/build-organization-snapshot.mjs");
  const { options, snapshotLock } = snapshotWorkspace(context);
  let refused = 0;
  const result = await withStandIns({
    rename: (real) => async (source, target) => {
      if (samePath(target, snapshotLock) && refused === 0) {
        refused += 1;
        throw fileError("EPERM");
      }
      return real(source, target);
    },
  }, () => buildOrganizationSnapshot(options));
  assert.equal(refused, 1, "the failed rename must actually have happened");
  assert.equal(result.ok, true);
});

test("a snapshot lock that cannot be taken ends as a snapshot already running and frees the other lock", async (context) => {
  const { buildOrganizationSnapshot } = await import("../scripts/build-organization-snapshot.mjs");
  const { options, snapshotLock, mutationLock } = snapshotWorkspace(context);
  timing.waitMs = SHORT_WAIT_MS;
  await withStandIns({
    rename: (real) => async (source, target) => {
      if (samePath(target, snapshotLock)) throw fileError("EPERM");
      return real(source, target);
    },
  }, () => assert.rejects(buildOrganizationSnapshot(options), /SNAPSHOT_ALREADY_RUNNING/));
  assert.equal(fs.existsSync(mutationLock), false);
});

test("a snapshot lock that cannot be deleted does not keep the mutation lock", async (context) => {
  const { buildOrganizationSnapshot } = await import("../scripts/build-organization-snapshot.mjs");
  const { options, snapshotLock, mutationLock } = snapshotWorkspace(context);
  timing.releaseMs = SHORT_WAIT_MS;
  await withStandIns({
    rm: (real) => async (target, ...rest) => {
      if (samePath(target, snapshotLock)) throw fileError("EBUSY");
      return real(target, ...rest);
    },
  }, () => assert.rejects(buildOrganizationSnapshot(options), { code: "EBUSY" }));
  assert.equal(fs.existsSync(mutationLock), false, "the mutation lock was left behind");
});

// ---------------------------------------------------------------------------------------------
// Several processes trading the lock, JS and Python together
// ---------------------------------------------------------------------------------------------

const STRESS_JS_PROCESSES = 2;
const STRESS_CYCLES_PER_PROCESS = 300;
const LONGEST_ACQUISITION_MS = 2_000;
// "Stuck" is judged by lack of progress, never by how long the whole run takes: a slow machine only
// makes the run longer. A process is stuck when it completes no cycle for this long (the Python writer's
// own wait for the lock ends at 30 s, so a longer silence is not a wait but a hang).
const STALL_MS = 45_000;
// Safety net so a run can never hang a job for ever, far above the time any healthy run needs.
const HARD_CAP_MS = 300_000;

// Every worker prints one JSON object per line (see the workers). Keeps the latest of each kind.
function watchWorker(child, label) {
  const worker = { label, pid: child.pid, cycles: 0, lastCycleAt: Date.now(), heartbeat: null, final: null, stderr: "", exitCode: null };
  let pending = "";
  child.stdout.on("data", (chunk) => {
    pending += chunk;
    const lines = pending.split("\n");
    pending = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      const event = JSON.parse(line);
      if (event.event === "cycle") {
        worker.cycles = event.cycle;
        worker.lastCycleAt = Date.now();
      } else if (event.event === "heartbeat") {
        worker.heartbeat = event;
      } else if (event.event === "final") {
        worker.final = event;
      }
    }
  });
  child.stderr.on("data", (chunk) => { worker.stderr += chunk; });
  worker.exited = new Promise((resolve) => child.once("exit", (code) => { worker.exitCode = code; resolve(); }));
  return worker;
}

// Who the lock on disk names as its holder, so a stuck run says whose lock everyone is waiting for.
function describeLock(workers, lock) {
  let state;
  try {
    const owner = JSON.parse(fs.readFileSync(path.join(lock, "owner.json"), "utf8"));
    const holder = workers.find((worker) => worker.pid === owner.pid);
    state = `held by process ${owner.pid} (${holder ? `${holder.label}${holder.exitCode === null ? ", still running" : ", already exited"}` : "not one of the workers"})`;
  } catch (error) {
    state = fs.existsSync(lock) ? `present, owner file unreadable (${error.code ?? error.name})` : "not on disk";
  }
  return `lock: ${state}`;
}

function describeWorkers(workers, lock) {
  const lines = workers.map((worker) => {
    const where = worker.heartbeat
      ? `${worker.heartbeat.phase} for ${worker.heartbeat.phase_ms} ms`
      : "no heartbeat yet";
    const silent = Math.round((Date.now() - worker.lastCycleAt) / 1000);
    const finished = worker.final
      ? `, finished with ${worker.final.failure_count} failures: ${worker.final.failures.join(" | ")}`
      : "";
    return `${worker.label} (process ${worker.pid}): ${worker.cycles}/${STRESS_CYCLES_PER_PROCESS} cycles, last cycle ${silent} s ago, last seen ${where}${finished}`;
  });
  return [...lines, describeLock(workers, lock)].join("\n");
}

// Windows only: the cross-language hold-up (a Python reader of the owner file blocking a JS release) is
// Windows behaviour, and how a POSIX filesystem hands the lock over under load is not measured here.
test("two JS processes and a Python writer trading the lock 300 times each never fail or get stuck", { skip: process.platform !== "win32" }, async (context) => {
  const { root } = workspace(context);
  const python = await pythonRunner();
  const privateRoot = path.join(root, ".xhs-favorites", "diandian-summaries");
  const pythonWorker = path.resolve(here, "..", "test-fixtures", "lock-stress-python-worker.py");
  const pythonScript = path.resolve(here, "..", "..", "xhs-diandian-summarize-note", "scripts", "save_diandian_summary.py");
  const jsWorker = path.resolve(here, "..", "test-fixtures", "lock-stress-worker.mjs");
  const lockPath = path.join(root, ".xhs-favorites", "organization-migration", ".apply-lock");
  const children = [];
  const workers = [];
  const start = (command, args, label) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, env: { ...process.env, PYTHONUTF8: "1" } });
    context.after(() => child.kill());
    children.push(child);
    workers.push(watchWorker(child, label));
  };
  for (let index = 0; index < STRESS_JS_PROCESSES; index += 1) {
    start(process.execPath, [jsWorker, root, String(STRESS_CYCLES_PER_PROCESS), "2"], `js-${index}`);
  }
  start(python.command, [...python.prefixArgs, pythonWorker, pythonScript, privateRoot, String(STRESS_CYCLES_PER_PROCESS), "0.002"], "python");

  const startedAt = Date.now();
  let verdict = null;
  const allExited = Promise.all(workers.map((worker) => worker.exited));
  let finishedAll = false;
  allExited.then(() => { finishedAll = true; });
  while (!finishedAll && verdict === null) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const stuck = workers.filter((worker) => worker.exitCode === null && Date.now() - worker.lastCycleAt > STALL_MS);
    if (stuck.length) verdict = `no progress for ${STALL_MS / 1000} s in: ${stuck.map((worker) => worker.label).join(", ")}`;
    else if (Date.now() - startedAt > HARD_CAP_MS) verdict = `still running after ${HARD_CAP_MS / 1000} s`;
  }
  if (verdict !== null) {
    const report = describeWorkers(workers, lockPath);
    for (const child of children) child.kill();
    await allExited;
    assert.fail(`${verdict}\n${report}`);
  }

  for (const worker of workers) {
    assert.equal(worker.exitCode, 0, `${worker.label}: ${worker.stderr}`);
    assert.ok(worker.final, `${worker.label} printed no final report`);
    assert.deepEqual(worker.final.failures, [], worker.label);
    assert.equal(worker.final.failure_count, 0, worker.label);
    assert.equal(worker.final.cycles_done, STRESS_CYCLES_PER_PROCESS, worker.label);
    assert.ok(
      worker.final.longest_wait_ms < LONGEST_ACQUISITION_MS,
      `${worker.label}: one acquisition took ${worker.final.longest_wait_ms} ms\n${describeWorkers(workers, lockPath)}`,
    );
  }
  assert.equal(fs.existsSync(lockPath), false);
});
