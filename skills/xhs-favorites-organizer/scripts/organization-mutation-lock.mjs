import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

async function metadata(path) {
  try {
    return await lstat(path);
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
    await rename(candidate, lock);
  } catch (error) {
    if (!["EEXIST", "ENOTEMPTY"].includes(error.code) && !(error.code === "EPERM" && await metadata(lock))) {
      throw error;
    }
    const lockMetadata = await metadata(lock);
    if (!lockMetadata?.isDirectory() || lockMetadata.isSymbolicLink()) throw invalidError();
    let owner;
    try {
      owner = JSON.parse(await readFile(join(lock, "owner.json"), "utf8"));
    } catch {
      throw invalidError();
    }
    let active = false;
    if (Number.isSafeInteger(owner?.pid) && owner.pid > 0) {
      try {
        process.kill(owner.pid, 0);
        active = true;
      } catch (probeError) {
        active = probeError.code === "EPERM";
      }
    }
    if (active) throw busyError();
    const stale = `${lock}.stale-${randomUUID()}`;
    try {
      await rename(lock, stale);
    } catch {
      throw busyError();
    }
    try {
      await rename(candidate, lock);
    } finally {
      await rm(stale, { recursive: true, force: true });
    }
  } finally {
    await rm(candidate, { recursive: true, force: true });
  }
  return async () => {
    let owner;
    try {
      owner = JSON.parse(await readFile(join(lock, "owner.json"), "utf8"));
    } catch {
      return;
    }
    if (owner.nonce === nonce) await rm(lock, { recursive: true, force: true });
  };
}
