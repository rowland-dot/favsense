import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// The CI Windows runner reaches its temp folder through an 8.3 short name
// (RUNNER~1). These tests address a temp repository through such a name and
// check that the privacy guards treat it as the same place as the long name.

const organizeScript = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../scripts/organize.mjs");

function shortNameOf(directory) {
  if (process.platform !== "win32") return directory;
  const result = spawnSync("cmd.exe", ["/d", "/c", `for %I in ("${directory}") do @echo %~sI`], {
    encoding: "utf8",
    windowsVerbatimArguments: true,
  });
  return result.status === 0 && result.stdout.trim() ? result.stdout.trim() : directory;
}

// Returns a git repository whose folder name is long enough to have a distinct
// 8.3 name, plus both spellings of its path. `short === long` means this
// machine has no short names (non-Windows, or 8.3 generation disabled).
function repositoryWithShortName(t) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "xhs-short-path-test-"));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const long = path.join(parent, "private-repository-with-a-long-name");
  fs.mkdirSync(long);
  fs.writeFileSync(path.join(long, ".gitignore"), ".private/\n.xhs-favorites/\nreports/\n", "utf8");
  assert.equal(spawnSync("git", ["init", "--quiet"], { cwd: long }).status, 0);
  const short = path.join(shortNameOf(parent), shortNameOf(long).split(path.sep).pop());
  return { parent, long, short };
}

function skipUnlessShortNamesExist(t, repository) {
  if (repository.short === repository.long
    || repository.short.toLowerCase() === repository.long.toLowerCase()) {
    t.skip("this machine does not create 8.3 short names for new folders");
    return true;
  }
  return false;
}

function runOrganizer(workspace, outputPath) {
  const input = path.join(workspace, "favorites.json");
  fs.writeFileSync(input, JSON.stringify([{ note_id: "n1", title: "One", description: "d" }]), "utf8");
  fs.mkdirSync(path.join(workspace, ".xhs-favorites"), { recursive: true });
  return spawnSync(process.execPath, [
    organizeScript,
    "--input", input,
    "--catalog", path.join(workspace, ".xhs-favorites", "catalog.json"),
    "--output", outputPath,
    "--date", "2026-10-12",
  ], { encoding: "utf8" });
}

test("organizer: ignored catalog and report reached through a short path are accepted", (t) => {
  const repository = repositoryWithShortName(t);
  if (skipUnlessShortNamesExist(t, repository)) return;
  const result = runOrganizer(repository.short, path.join(repository.short, "reports", "report.md"));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(path.join(repository.long, "reports", "report.md")), true);
});

test("organizer: a report outside the repository is refused when the repository is reached through a short path", (t) => {
  const repository = repositoryWithShortName(t);
  if (skipUnlessShortNamesExist(t, repository)) return;
  const outside = path.join(repository.parent, "outside-report.md");
  const result = runOrganizer(repository.short, outside);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must stay inside the detected Git worktree/);
  assert.equal(fs.existsSync(outside), false);
});

test("organizer: an un-ignored report reached through a short path is refused", (t) => {
  const repository = repositoryWithShortName(t);
  if (skipUnlessShortNamesExist(t, repository)) return;
  const result = runOrganizer(repository.short, path.join(repository.short, "public-docs", "report.md"));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not ignored/i);
});
