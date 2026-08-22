import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { findTrackedPrivatePaths, findUnignoredPrivateProbes } from "./verify-release.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("release verification rejects every tracked private-path class", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "favsense-release-boundary-"));
  try {
    const privateFiles = [
      ".xhs-favorites/catalog.json",
      ".xhs-tools/runtime.txt",
      "knowledge-base/00-home.md",
      "config/xhs-favorites.json",
      "site/.local/bridge.json",
    ];
    for (const relative of [...privateFiles, "site/public.txt"]) {
      const target = join(fixture, relative);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, "fixture\n", "utf8");
    }
    assert.equal(spawnSync("git", ["init", "--quiet"], { cwd: fixture }).status, 0);
    assert.equal(spawnSync("git", ["add", "."], { cwd: fixture }).status, 0);

    assert.deepEqual(findTrackedPrivatePaths(fixture), [...privateFiles].sort());
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("release privacy boundary rejects case and every non-ASCII path variant", () => {
  const tracked = [
    ".XHS-FAVORITES/catalog.json",
    ".XHS-TOOLS/runtime.txt",
    "Knowledge-Base/00-home.md",
    "Config/XHS-Favorites.json",
    "Site/.Local/bridge.json",
    ".ＸＨＳ-FAVORITES/fullwidth.json",
    ".xhs\u200b-favorites/zero-width.json",
    ".xhѕ-favoriteѕ/cyrillic.json",
    "knоwledge-base/confusable.json",
    ".xhs-faνorites/greek-nu.json",
    "knoωledge-base/greek-omega.json",
    "site/public.txt",
  ];
  const spawn = () => ({ status: 0, stdout: `${tracked.join("\0")}\0` });
  assert.deepEqual(findTrackedPrivatePaths("unused", { spawn }), tracked.slice(0, -1).sort());
});

test("release verification checks every private ignore probe independently", () => {
  const calls = [];
  const unignored = findUnignoredPrivateProbes("unused", {
    spawn(_command, args) {
      const file = args.at(-1);
      calls.push(file);
      return { status: file === "config/xhs-favorites.json" ? 1 : 0 };
    },
  });
  assert.equal(calls.length, 5);
  assert.deepEqual(unignored, ["config/xhs-favorites.json"]);
});

test("Node 20 entry points do not rely on import.meta.dirname", async () => {
  for (const relative of [
    "scripts/verify-release.mjs",
    "scripts/serve-site.mjs",
    "skills/xhs-favorites-organizer/scripts/build-knowledge-base.mjs",
    "skills/xhs-favorites-organizer/tests/test_knowledge_base.mjs",
  ]) {
    const source = await readFile(resolve(root, relative), "utf8");
    assert.doesNotMatch(source, /import\.meta\.dirname/, relative);
  }
});
