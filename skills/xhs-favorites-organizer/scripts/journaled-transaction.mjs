import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, realpath, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const SAFE_NAME = /^[a-z][a-z0-9-]{0,63}$/;
const SAFE_ID = /^[A-Za-z0-9_-]{1,80}$/;

function inside(root, candidate) {
  const rel = relative(root, candidate);
  return rel && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

async function metadata(path) {
  try { return await lstat(path); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

function sameIdentity(left, right) {
  return left?.dev === right?.dev && left?.ino === right?.ino;
}

async function boundMetadata(path) {
  try { return await lstat(path, { bigint: true }); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

async function readBoundTransactionJournal(transaction) {
  const transactionBefore = await boundMetadata(transaction);
  const journal = join(transaction, "journal.json");
  const journalBefore = await boundMetadata(journal);
  if (
    !transactionBefore?.isDirectory()
    || transactionBefore.isSymbolicLink()
    || !journalBefore?.isFile()
    || journalBefore.isSymbolicLink()
    || journalBefore.nlink !== 1n
  ) throw new Error("TRANSACTION_JOURNAL_UNSAFE");
  let handle;
  try {
    handle = await open(journal, "r");
    const opened = await handle.stat({ bigint: true });
    if (
      !opened.isFile()
      || opened.nlink !== 1n
      || !sameIdentity(opened, journalBefore)
    ) throw new Error("TRANSACTION_JOURNAL_UNSAFE");
    const content = await handle.readFile("utf8");
    const journalAfter = await boundMetadata(journal);
    const transactionAfter = await boundMetadata(transaction);
    if (
      !journalAfter?.isFile()
      || journalAfter.isSymbolicLink()
      || journalAfter.nlink !== 1n
      || !sameIdentity(opened, journalAfter)
      || !transactionAfter?.isDirectory()
      || transactionAfter.isSymbolicLink()
      || !sameIdentity(transactionBefore, transactionAfter)
    ) throw new Error("TRANSACTION_JOURNAL_UNSAFE");
    return content;
  } catch (error) {
    if (error?.message === "TRANSACTION_JOURNAL_UNSAFE") throw error;
    throw new Error("TRANSACTION_JOURNAL_UNSAFE", { cause: error });
  } finally {
    await handle?.close();
  }
}

async function requirePlainRoot(root) {
  const info = await metadata(root);
  if (!info) await mkdir(root, { recursive: true });
  const current = await lstat(root);
  if (!current.isDirectory() || current.isSymbolicLink()) throw new Error("TRANSACTION_ROOT_UNSAFE");
}

async function assertContainedPlainPath(root, candidate) {
  const rel = relative(root, candidate);
  if (!rel || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("TRANSACTION_PATH_ESCAPE");
  const rootReal = await realpath(root);
  let cursor = root;
  for (const segment of rel.split(sep)) {
    cursor = join(cursor, segment);
    const info = await metadata(cursor);
    if (!info) break;
    if (info.isSymbolicLink()) throw new Error("TRANSACTION_PATH_UNSAFE");
    const currentReal = await realpath(cursor);
    const realRel = relative(rootReal, currentReal);
    if (realRel.startsWith(`..${sep}`) || isAbsolute(realRel)) throw new Error("TRANSACTION_PATH_ESCAPE");
  }
}

async function syncDirectory(path) {
  let handle;
  try {
    handle = await open(path, "r");
    await handle.sync();
  } catch (error) {
    if (process.platform !== "win32" || !["EACCES", "EBADF", "EINVAL", "EPERM"].includes(error.code)) throw error;
  } finally {
    await handle?.close();
  }
}

async function durableRename(source, destination) {
  await rename(source, destination);
  await syncDirectory(dirname(destination));
  if (dirname(source) !== dirname(destination)) await syncDirectory(dirname(source));
}

async function durableRemove(path, options) {
  await rm(path, options);
  await syncDirectory(dirname(path));
}

async function durableWriteFile(path, content) {
  const handle = await open(path, "wx");
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(dirname(path));
}

async function atomicJson(path, value) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await durableWriteFile(temporary, `${JSON.stringify(value)}\n`);
    await durableRename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

function validateParticipants(root, participants) {
  if (!Array.isArray(participants) || participants.length < 1 || participants.length > 16) throw new Error("TRANSACTION_PARTICIPANTS_INVALID");
  const names = new Set();
  return participants.map((participant) => {
    if (!participant || !SAFE_NAME.test(participant.name) || names.has(participant.name)) throw new Error("TRANSACTION_PARTICIPANT_INVALID");
    names.add(participant.name);
    const target = resolve(participant.target);
    if (!inside(root, target)) throw new Error("TRANSACTION_TARGET_ESCAPE");
    if (participant.staging && !inside(root, resolve(participant.staging))) throw new Error("TRANSACTION_STAGING_ESCAPE");
    return { ...participant, target };
  });
}

function journalParticipants(root, entries) {
  return entries.map(({ name, target, had_live, swapped }) => ({
    name,
    target: relative(root, target).split(sep).join("/"),
    had_live,
    swapped,
  }));
}

function immutableStateSha256(root, id, entries) {
  const state = entries.map(({ name, target, had_live }) => ({
    name,
    target: relative(root, target).split(sep).join("/"),
    had_live,
  }));
  return createHash("sha256")
    .update(JSON.stringify({ transaction_id: id, participants: state }))
    .digest("hex");
}

function journalRecord(root, id, phase, entries) {
  return {
    schema_version: 1,
    transaction_id: id,
    phase,
    immutable_state_sha256: immutableStateSha256(root, id, entries),
    participants: journalParticipants(root, entries),
  };
}

export async function executeJournaledTransaction({
  root: rootValue,
  transactionRoot: transactionRootValue,
  id,
  participants: rawParticipants,
  failAt = "",
  beforeParticipant = null,
}) {
  const root = resolve(rootValue);
  const transactionRoot = resolve(transactionRootValue || root);
  if (!SAFE_ID.test(id)) throw new Error("TRANSACTION_ID_INVALID");
  await requirePlainRoot(root);
  if (transactionRoot !== root) {
    if (!inside(root, transactionRoot)) throw new Error("TRANSACTION_STORAGE_ESCAPE");
    await assertContainedPlainPath(root, transactionRoot);
    await requirePlainRoot(transactionRoot);
    await assertContainedPlainPath(root, transactionRoot);
  }
  const participants = validateParticipants(root, rawParticipants);
  for (const participant of participants) {
    await assertContainedPlainPath(root, participant.target);
    if (participant.staging) await assertContainedPlainPath(root, resolve(participant.staging));
  }
  const transaction = join(transactionRoot, `.organization-tx-${id}`);
  if (await metadata(transaction)) throw new Error("TRANSACTION_ALREADY_EXISTS");
  await mkdir(transaction);
  await syncDirectory(transactionRoot);
  const journal = join(transaction, "journal.json");
  const entries = [];
  try {
    for (const participant of participants) {
      const staging = participant.staging ? resolve(participant.staging) : join(transaction, `stage-${participant.name}`);
      const stagingInfo = await metadata(staging);
      if (participant.staging) {
        if (!stagingInfo || stagingInfo.isSymbolicLink()) throw new Error("TRANSACTION_STAGING_INVALID");
      } else {
        await durableWriteFile(staging, String(participant.content ?? ""));
      }
      const targetInfo = await metadata(participant.target);
      if (targetInfo?.isSymbolicLink()) throw new Error("TRANSACTION_TARGET_UNSAFE");
      entries.push({ name: participant.name, target: participant.target, staging, backup: join(transaction, `backup-${participant.name}`), had_live: Boolean(targetInfo), swapped: false });
    }
    await atomicJson(journal, journalRecord(root, id, "prepared", entries));
    for (const entry of entries) {
      if (typeof beforeParticipant === "function") await beforeParticipant(entry.name);
      await assertContainedPlainPath(root, entry.target);
      await assertContainedPlainPath(root, entry.staging);
      if (entry.had_live) await durableRename(entry.target, entry.backup);
      await atomicJson(journal, journalRecord(root, id, `backup:${entry.name}`, entries));
      if (failAt === `crash:${entry.name}`) throw new Error(`SIMULATED_CRASH:${failAt}`);
      if (failAt === `swap:${entry.name}`) throw new Error(`FAULT_INJECTION:${failAt}`);
      await assertContainedPlainPath(root, entry.target);
      await assertContainedPlainPath(root, entry.staging);
      await durableRename(entry.staging, entry.target);
      entry.swapped = true;
      if (failAt === `crash-after-swap:${entry.name}`) throw new Error(`SIMULATED_CRASH:${failAt}`);
      await atomicJson(journal, journalRecord(root, id, `swap:${entry.name}`, entries));
    }
    await atomicJson(journal, journalRecord(root, id, "committed", entries));
    if (failAt === "crash:committed") throw new Error(`SIMULATED_CRASH:${failAt}`);
    await durableRemove(transaction, { recursive: true, force: true });
    return { schema_version: 1, outcome: "committed", transaction_id: id };
  } catch (error) {
    if (String(error?.message || "").startsWith("SIMULATED_CRASH:")) throw error;
    for (const entry of [...entries].reverse()) {
      if (entry.swapped && await metadata(entry.target)) await durableRemove(entry.target, { recursive: true, force: true });
      if (entry.had_live && await metadata(entry.backup)) await durableRename(entry.backup, entry.target);
    }
    await durableRemove(transaction, { recursive: true, force: true });
    throw error;
  }
}

export async function recoverJournaledTransaction({ root: rootValue, transactionRoot: transactionRootValue, id, participants: rawParticipants }) {
  const root = resolve(rootValue);
  const transactionRoot = resolve(transactionRootValue || root);
  if (!SAFE_ID.test(id)) throw new Error("TRANSACTION_ID_INVALID");
  if (transactionRoot !== root && !inside(root, transactionRoot)) throw new Error("TRANSACTION_STORAGE_ESCAPE");
  await requirePlainRoot(root);
  if (transactionRoot !== root) {
    await assertContainedPlainPath(root, transactionRoot);
    await requirePlainRoot(transactionRoot);
    await assertContainedPlainPath(root, transactionRoot);
  }
  const transaction = join(transactionRoot, `.organization-tx-${id}`);
  const info = await metadata(transaction);
  if (!info) return { outcome: "none" };
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("TRANSACTION_RECOVERY_UNSAFE");
  const record = JSON.parse(await readBoundTransactionJournal(transaction));
  if (
    record.schema_version !== 1
    || record.transaction_id !== id
    || !Array.isArray(record.participants)
    || !/^[a-f0-9]{64}$/.test(record.immutable_state_sha256 || "")
  ) throw new Error("TRANSACTION_JOURNAL_INVALID");
  const participants = validateParticipants(root, rawParticipants);
  for (const participant of participants) await assertContainedPlainPath(root, participant.target);
  const byName = new Map(participants.map((participant) => [participant.name, participant]));
  const journalNames = new Set(record.participants.map((entry) => entry?.name));
  if (
    record.participants.length !== participants.length
    || journalNames.size !== participants.length
    || participants.some((participant) => !journalNames.has(participant.name))
    || record.participants.some((entry) => (
      !entry || !byName.has(entry.name) || typeof entry.had_live !== "boolean"
      || (entry.swapped !== undefined && typeof entry.swapped !== "boolean")
      || entry.target !== relative(root, byName.get(entry.name).target).split(sep).join("/")
    ))
  ) throw new Error("TRANSACTION_RECOVERY_PARTICIPANTS_INVALID");
  const validPhases = new Set([
    "prepared",
    "committed",
    ...participants.flatMap(({ name }) => [`backup:${name}`, `swap:${name}`]),
  ]);
  if (
    !validPhases.has(record.phase)
    || record.immutable_state_sha256 !== immutableStateSha256(
      root,
      id,
      record.participants.map((entry) => ({
        name: entry.name,
        target: byName.get(entry.name).target,
        had_live: entry.had_live,
      })),
    )
  ) throw new Error("TRANSACTION_JOURNAL_STATE_INVALID");
  const recoveryEntries = [];
  for (const entry of record.participants) {
    const participant = byName.get(entry.name);
    await assertContainedPlainPath(root, participant.target);
    const targetInfo = await metadata(participant.target);
    if (targetInfo?.isSymbolicLink()) throw new Error("TRANSACTION_RECOVERY_UNSAFE");
    const backup = join(transaction, `backup-${entry.name}`);
    const backupInfo = await metadata(backup);
    if (backupInfo?.isSymbolicLink()) throw new Error("TRANSACTION_RECOVERY_UNSAFE");
    const staging = participant.staging ? resolve(participant.staging) : join(transaction, `stage-${entry.name}`);
    const stagingInfo = await metadata(staging);
    if (stagingInfo?.isSymbolicLink()) throw new Error("TRANSACTION_RECOVERY_UNSAFE");
    if ((!entry.had_live && backupInfo) || (entry.had_live && !targetInfo && !backupInfo)) {
      throw new Error("TRANSACTION_JOURNAL_STATE_INVALID");
    }
    recoveryEntries.push({ entry, participant, targetInfo, backup, backupInfo, stagingInfo });
  }
  if (record.phase === "committed") {
    const expectedTransactionFiles = new Set([
      "journal.json",
      ...record.participants.filter((entry) => entry.had_live).map((entry) => `backup-${entry.name}`),
    ]);
    const transactionFiles = await readdir(transaction);
    if (
      recoveryEntries.some(({ entry, targetInfo, backupInfo, stagingInfo }) => (
        entry.swapped !== true
        || !targetInfo
        || Boolean(backupInfo) !== entry.had_live
        || Boolean(stagingInfo)
      ))
      || transactionFiles.length !== expectedTransactionFiles.size
      || transactionFiles.some((name) => !expectedTransactionFiles.has(name))
    ) throw new Error("TRANSACTION_JOURNAL_STATE_INVALID");
    await durableRemove(transaction, { recursive: true, force: true });
    return { schema_version: 1, outcome: "committed", transaction_id: id };
  }
  for (const { entry, participant, targetInfo, backup, backupInfo } of recoveryEntries.reverse()) {
    if (entry.had_live) {
      if (backupInfo) {
        if (targetInfo) await durableRemove(participant.target, { recursive: true, force: true });
        await durableRename(backup, participant.target);
      } else if (!targetInfo) {
        throw new Error("TRANSACTION_RECOVERY_INCOMPLETE");
      }
    } else if (targetInfo) {
      await durableRemove(participant.target, { recursive: true, force: true });
    }
  }
  await durableRemove(transaction, { recursive: true, force: true });
  return { schema_version: 1, outcome: "rolled_back", transaction_id: id };
}
