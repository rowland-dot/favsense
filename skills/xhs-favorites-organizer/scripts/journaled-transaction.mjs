import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
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

async function atomicJson(path, value) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", flag: "wx" });
  await rename(temporary, path);
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

export async function executeJournaledTransaction({
  root: rootValue,
  id,
  participants: rawParticipants,
  failAt = "",
  beforeParticipant = null,
}) {
  const root = resolve(rootValue);
  if (!SAFE_ID.test(id)) throw new Error("TRANSACTION_ID_INVALID");
  await requirePlainRoot(root);
  const participants = validateParticipants(root, rawParticipants);
  for (const participant of participants) {
    await assertContainedPlainPath(root, participant.target);
    if (participant.staging) await assertContainedPlainPath(root, resolve(participant.staging));
  }
  const transaction = join(root, `.organization-tx-${id}`);
  if (await metadata(transaction)) throw new Error("TRANSACTION_ALREADY_EXISTS");
  await mkdir(transaction);
  const journal = join(transaction, "journal.json");
  const entries = [];
  try {
    for (const participant of participants) {
      const staging = participant.staging ? resolve(participant.staging) : join(transaction, `stage-${participant.name}`);
      const stagingInfo = await metadata(staging);
      if (participant.staging) {
        if (!stagingInfo || stagingInfo.isSymbolicLink()) throw new Error("TRANSACTION_STAGING_INVALID");
      } else {
        await writeFile(staging, String(participant.content ?? ""), { encoding: "utf8", flag: "wx" });
      }
      const targetInfo = await metadata(participant.target);
      if (targetInfo?.isSymbolicLink()) throw new Error("TRANSACTION_TARGET_UNSAFE");
      entries.push({ name: participant.name, target: participant.target, staging, backup: join(transaction, `backup-${participant.name}`), had_live: Boolean(targetInfo), swapped: false });
    }
    await atomicJson(journal, { schema_version: 1, transaction_id: id, phase: "prepared", participants: entries.map(({ name, had_live }) => ({ name, had_live })) });
    for (const entry of entries) {
      if (typeof beforeParticipant === "function") await beforeParticipant(entry.name);
      await assertContainedPlainPath(root, entry.target);
      await assertContainedPlainPath(root, entry.staging);
      if (entry.had_live) await rename(entry.target, entry.backup);
      await atomicJson(journal, { schema_version: 1, transaction_id: id, phase: `backup:${entry.name}`, participants: entries.map(({ name, had_live, swapped }) => ({ name, had_live, swapped })) });
      if (failAt === `crash:${entry.name}`) throw new Error(`SIMULATED_CRASH:${failAt}`);
      if (failAt === `swap:${entry.name}`) throw new Error(`FAULT_INJECTION:${failAt}`);
      await assertContainedPlainPath(root, entry.target);
      await assertContainedPlainPath(root, entry.staging);
      await rename(entry.staging, entry.target);
      entry.swapped = true;
      if (failAt === `crash-after-swap:${entry.name}`) throw new Error(`SIMULATED_CRASH:${failAt}`);
      await atomicJson(journal, { schema_version: 1, transaction_id: id, phase: `swap:${entry.name}`, participants: entries.map(({ name, had_live, swapped }) => ({ name, had_live, swapped })) });
    }
    await atomicJson(journal, { schema_version: 1, transaction_id: id, phase: "committed", participants: entries.map(({ name, had_live, swapped }) => ({ name, had_live, swapped })) });
    await rm(transaction, { recursive: true, force: true });
    return { schema_version: 1, outcome: "committed", transaction_id: id };
  } catch (error) {
    if (String(error?.message || "").startsWith("SIMULATED_CRASH:")) throw error;
    for (const entry of [...entries].reverse()) {
      if (entry.swapped && await metadata(entry.target)) await rm(entry.target, { recursive: true, force: true });
      if (entry.had_live && await metadata(entry.backup)) await rename(entry.backup, entry.target);
    }
    await rm(transaction, { recursive: true, force: true });
    throw error;
  }
}

export async function recoverJournaledTransaction({ root: rootValue, id, participants: rawParticipants }) {
  const root = resolve(rootValue);
  if (!SAFE_ID.test(id)) throw new Error("TRANSACTION_ID_INVALID");
  const transaction = join(root, `.organization-tx-${id}`);
  const info = await metadata(transaction);
  if (!info) return { outcome: "none" };
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("TRANSACTION_RECOVERY_UNSAFE");
  const record = JSON.parse(await readFile(join(transaction, "journal.json"), "utf8"));
  if (record.schema_version !== 1 || record.transaction_id !== id || !Array.isArray(record.participants)) throw new Error("TRANSACTION_JOURNAL_INVALID");
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
    ))
  ) throw new Error("TRANSACTION_RECOVERY_PARTICIPANTS_INVALID");
  for (const entry of [...record.participants].reverse()) {
    const participant = byName.get(entry.name);
    await assertContainedPlainPath(root, participant.target);
    const targetInfo = await metadata(participant.target);
    if (targetInfo?.isSymbolicLink()) throw new Error("TRANSACTION_RECOVERY_UNSAFE");
    const backup = join(transaction, `backup-${entry.name}`);
    const backupInfo = await metadata(backup);
    if (backupInfo?.isSymbolicLink()) throw new Error("TRANSACTION_RECOVERY_UNSAFE");
    if (entry.had_live) {
      if (backupInfo) {
        if (targetInfo) await rm(participant.target, { recursive: true, force: true });
        await rename(backup, participant.target);
      } else if (!targetInfo) {
        throw new Error("TRANSACTION_RECOVERY_INCOMPLETE");
      }
    } else if (targetInfo) {
      await rm(participant.target, { recursive: true, force: true });
    }
  }
  await rm(transaction, { recursive: true, force: true });
  return { schema_version: 1, outcome: "rolled_back", transaction_id: id };
}
