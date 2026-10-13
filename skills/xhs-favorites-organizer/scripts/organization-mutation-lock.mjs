import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Folder identity is compared on exact (bigint) values. Ordinary Number values round the 64-bit
// Windows file number, so a different folder could read back as the same one. Every folder that is
// compared goes through this function, so both sides are always bigint.
async function metadata(path) {
  try {
    return await lstat(path, { bigint: true });
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function samePlainDirectory(expected, current) {
  return Boolean(
    expected?.isDirectory()
    && !expected.isSymbolicLink()
    && current?.isDirectory()
    && !current.isSymbolicLink()
    && expected.dev === current.dev
    && expected.ino === current.ino
  );
}

async function ensurePlainDirectory(path, parentPath, expectedParent, invalidError) {
  let current = await metadata(path);
  if (!current) {
    try {
      await mkdir(path);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    current = await metadata(path);
  }
  if (!current?.isDirectory() || current.isSymbolicLink()) throw invalidError();
  if (!samePlainDirectory(expectedParent, await metadata(parentPath))) throw invalidError();
  return current;
}

// How long writers wait out a hand-over of a lock, in milliseconds. One object so tests can shorten it.
// The Python writer of the same lock (save_diandian_summary.py) waits the same way, with the same release window.
export const LOCK_TIMING = {
  waitMs: 2_000, // how long a lock that is gone or being deleted is waited for before "already running"
  pollMs: 10, // average pause between looks; each pause is randomised so writers cannot fall into step
  releaseMs: 2_000, // how long a release retries a delete the operating system refuses
  ownerlessMs: 1_000, // how long a lock folder with no owner file must stay as it is before it is taken over
};

// Errors from moving the candidate onto the lock that mean "somebody else is there (or just was)".
const CONTENDED_RENAME_ERRORS = new Set(["EEXIST", "ENOTEMPTY", "EPERM"]);
// Errors from reading the owner file while its holder is deleting it. Windows refuses the read of a
// file that is being deleted, and the file or folder may already be gone.
const RELEASING_READ_ERRORS = new Set(["ENOENT", "EPERM", "EBUSY", "EACCES"]);
// Errors from deleting the lock that Windows gives while another process still has a file in it open
// (ENOTEMPTY: a deleted file stays listed in the folder until its last reader lets go).
const SHARING_ERRORS = new Set(["EBUSY", "EPERM", "ENOTEMPTY"]);

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

// A look at the lock folder can be refused while its holder is deleting it (Windows answers "access
// denied" for a folder whose delete is pending). That is the same moment as "gone", so it is not an error
// here; whether it lasts is decided by the caller's own time limit.
const STILL_BEING_DELETED = Symbol("the lock folder is being deleted");
async function lookAtLockFolder(lock) {
  try {
    return await metadata(lock);
  } catch (error) {
    if (RELEASING_READ_ERRORS.has(error.code)) return STILL_BEING_DELETED;
    throw error;
  }
}

async function pauseOrGiveUp(deadline, busyError) {
  if (performance.now() >= deadline) throw busyError();
  await sleep(LOCK_TIMING.pollMs * (0.5 + Math.random()));
}

function processIsActive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (probeError) {
    return probeError.code === "EPERM";
  }
}

// Who holds the lock right now: null when it is gone or is being deleted; { ownerless: true, folder }
// when the folder is there with no owner file; else { owner }. Only a lock that is present and wrong
// is refused.
async function lookAtHolder(lock, invalidError) {
  const lockMetadata = await lookAtLockFolder(lock);
  if (!lockMetadata || lockMetadata === STILL_BEING_DELETED) return null;
  if (!lockMetadata.isDirectory() || lockMetadata.isSymbolicLink()) throw invalidError();
  let source;
  try {
    source = await readFile(join(lock, "owner.json"), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return { ownerless: true, folder: lockMetadata };
    if (RELEASING_READ_ERRORS.has(error.code)) return null;
    throw invalidError();
  }
  try {
    return { owner: JSON.parse(source) };
  } catch {
    throw invalidError();
  }
}

// A lock is only ever put in place with its owner file already inside, so a lock folder without one is
// either being deleted by its holder (over in moments) or was left by a holder that stopped halfway.
// Only a folder seen ownerless, and unchanged, for LOCK_TIMING.ownerlessMs counts as the second.
function ownerlessLongEnough(seen, holder) {
  return seen !== null && samePlainDirectory(seen.folder, holder.folder)
    && performance.now() - seen.since >= LOCK_TIMING.ownerlessMs;
}

// Move the lock folder aside and put the candidate in its place. Returns true when the candidate is now
// the lock. `expected` (the folder as it was seen) is checked again just before the move, so a new
// lock that took its place meanwhile is never moved.
async function replaceLockFolder(candidate, lock, invalidError, expected) {
  if (expected) {
    const now = await lookAtLockFolder(lock);
    if (now === STILL_BEING_DELETED || !samePlainDirectory(expected, now)) return false;
  }
  const stale = `${lock}.stale-${randomUUID()}`;
  try {
    await rename(lock, stale);
  } catch {
    return false; // another waiter took the stale lock first: look again
  }
  if (expected && await metadata(join(stale, "owner.json"))) {
    // A holder's owner file is in what was moved: a real lock took the place of the folder in the
    // instant between the check and the move. Put it back, untouched.
    await rename(stale, lock).catch(() => {});
    return false;
  }
  try {
    await rename(candidate, lock);
    return true;
  } catch (error) {
    if (!CONTENDED_RENAME_ERRORS.has(error.code)) throw error;
    return false; // another waiter took the freed lock first: look again
  } finally {
    // Clearing the old folder away is housekeeping: failing at it must not turn a lock we hold into an error.
    await rm(stale, { recursive: true, force: true }).catch(() => {});
  }
}

// Put `candidate` (a folder already holding its owner file) in place as `lock`. A lock held by a live
// process is refused at once. A lock that is gone, or being deleted, was just released: look again
// after a short random pause, up to LOCK_TIMING.waitMs, then report it as running.
export async function claimLockFolder(candidate, lock, { busyError, invalidError }) {
  const deadline = performance.now() + LOCK_TIMING.waitMs;
  let ownerlessSeen = null;
  for (;;) {
    try {
      await rename(candidate, lock);
      return;
    } catch (error) {
      if (!CONTENDED_RENAME_ERRORS.has(error.code)) throw error;
    }
    const holder = await lookAtHolder(lock, invalidError);
    if (holder?.ownerless) {
      if (!ownerlessSeen || !samePlainDirectory(ownerlessSeen.folder, holder.folder)) {
        ownerlessSeen = { folder: holder.folder, since: performance.now() };
      } else if (ownerlessLongEnough(ownerlessSeen, holder)) {
        if (await replaceLockFolder(candidate, lock, invalidError, holder.folder)) return;
      }
    } else {
      ownerlessSeen = null;
      if (holder) {
        if (processIsActive(holder.owner?.pid)) throw busyError();
        if (await replaceLockFolder(candidate, lock, invalidError, null)) return;
      }
    }
    await pauseOrGiveUp(deadline, busyError);
  }
}

// The owner record of a lock we are about to release: null when there is nothing of ours to delete (the
// lock is gone, or its record is not readable as one). A read the system refuses for a moment (a scanner
// or another reader has the file) is retried until `deadline`; skipping it would leave the lock on disk
// with this live process's number in it, and every writer, this one included, would then wait for it.
async function readOwnerForRelease(lock, deadline) {
  for (;;) {
    let source;
    try {
      source = await readFile(join(lock, "owner.json"), "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return null;
      if (!RELEASING_READ_ERRORS.has(error.code) || performance.now() >= deadline) throw error;
      await sleep(20);
      continue;
    }
    try {
      return JSON.parse(source);
    } catch {
      return null;
    }
  }
}

// Is what sits at `lock` now still the folder we are deleting? Once the owner file is gone the nonce can
// no longer say so, and waiters take over a folder left without one, so a new lock may be there.
async function stillTheFolderBeingDeleted(lock, nonce, folder) {
  const now = await lookAtLockFolder(lock);
  if (now === STILL_BEING_DELETED) return true; // the delete is pending: it is the folder being deleted
  if (!now) return false;
  if (folder && !samePlainDirectory(folder, now)) return false;
  try {
    const owner = JSON.parse(await readFile(join(lock, "owner.json"), "utf8"));
    return owner?.nonce === nonce;
  } catch {
    return true; // no readable owner file: it is the emptied folder
  }
}

// A delete that failed says what the folder still held, so a stuck lock can be explained afterwards.
async function describedWithFolderContents(error, lock) {
  try {
    error.message = `${error.message} [folder held: ${(await readdir(lock)).join(", ") || "nothing"}]`;
  } catch {
    // the folder is gone or unreadable: the original error says enough
  }
  return error;
}

async function removeRetryingSharingErrors(lock, nonce, deadline) {
  let folder = await lookAtLockFolder(lock);
  while (folder === STILL_BEING_DELETED && performance.now() < deadline) {
    await sleep(20);
    folder = await lookAtLockFolder(lock);
  }
  if (folder === STILL_BEING_DELETED) folder = null;
  for (;;) {
    try {
      await rm(lock, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!SHARING_ERRORS.has(error.code) || performance.now() >= deadline) {
        throw await describedWithFolderContents(error, lock);
      }
      await sleep(20);
      if (!await stillTheFolderBeingDeleted(lock, nonce, folder)) return;
    }
  }
}

// Delete the lock if it is still ours. Whether it is ours is decided by the random id in its owner
// file alone, never by the folder's number.
export async function releaseLockFolder(lock, nonce) {
  const deadline = performance.now() + LOCK_TIMING.releaseMs;
  const owner = await readOwnerForRelease(lock, deadline);
  if (owner?.nonce === nonce) await removeRetryingSharingErrors(lock, nonce, deadline);
}

export async function acquireOrganizationMutationLock(root, {
  busyError = () => new Error("ORGANIZATION_MUTATION_ALREADY_RUNNING"),
  invalidError = () => new Error("ORGANIZATION_MUTATION_LOCK_INVALID"),
} = {}) {
  const rootMetadata = await metadata(root);
  if (!rootMetadata?.isDirectory() || rootMetadata.isSymbolicLink()) throw invalidError();
  const privateRoot = join(root, ".xhs-favorites");
  const privateRootMetadata = await ensurePlainDirectory(
    privateRoot, root, rootMetadata, invalidError,
  );
  const directory = join(privateRoot, "organization-migration");
  const directoryMetadata = await ensurePlainDirectory(
    directory, privateRoot, privateRootMetadata, invalidError,
  );
  if (!samePlainDirectory(rootMetadata, await metadata(root))) throw invalidError();
  const lock = join(directory, ".apply-lock");
  const nonce = randomUUID();
  const candidate = `${lock}.candidate-${nonce}`;
  await mkdir(candidate);
  if (
    !samePlainDirectory(rootMetadata, await metadata(root))
    || !samePlainDirectory(privateRootMetadata, await metadata(privateRoot))
    || !samePlainDirectory(directoryMetadata, await metadata(directory))
  ) {
    await rm(candidate, { recursive: true, force: true });
    throw invalidError();
  }
  await writeFile(join(candidate, "owner.json"), `${JSON.stringify({
    schema_version: 1,
    pid: process.pid,
    nonce,
  })}\n`, { encoding: "utf8", flag: "wx" });
  try {
    await claimLockFolder(candidate, lock, { busyError, invalidError });
  } finally {
    await rm(candidate, { recursive: true, force: true });
  }
  return () => releaseLockFolder(lock, nonce);
}
