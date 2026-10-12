import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const publisher = path.resolve(
  "skills/xhs-favorites-organizer/scripts/publish-huggingface.mjs"
);

function git(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

// The private `.local` folder must stay out of the Space whatever its letter case
// and whatever path form the copy routine hands its filter (Node 20 on Windows
// passes \\?\-prefixed paths).
test("publisher keeps a differently-cased .Local folder out of the published Space", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "favsense-publish-local-case-"));
  const remote = path.join(root, "space.git");
  const seed = path.join(root, "seed");
  git(["init", "--bare", "--initial-branch=main", remote], root);
  git(["clone", remote, seed], root);
  git(["config", "user.name", "FavSense Test"], seed);
  git(["config", "user.email", "test@example.invalid"], seed);
  await writeFile(
    path.join(seed, "README.md"),
    "---\ntitle: Existing Space\nsdk: static\napp_file: site/index.html\n---\n\nBody.\n",
    "utf8"
  );
  git(["add", "."], seed);
  git(["commit", "-m", "initial"], seed);
  git(["push", "origin", "main"], seed);

  const workspace = path.join(root, "workspace");
  await mkdir(path.join(workspace, "site", ".Local", "nested"), { recursive: true });
  await writeFile(path.join(workspace, "site", "index.html"), "new", "utf8");
  await writeFile(path.join(workspace, "site", ".Local", "nested", "bridge.json"), "private", "utf8");

  const published = spawnSync(
    process.execPath,
    [publisher, "--workspace", workspace, "--repository", remote, "--branch", "main"],
    { encoding: "utf8", env: { ...process.env, FAVSENSE_ALLOW_LOCAL_PUBLISH: "1" } }
  );
  assert.equal(published.status, 0, published.stderr || published.stdout);

  const checkout = path.join(root, "checkout");
  git(["clone", remote, checkout], root);
  const tracked = git(["ls-files", "site"], checkout).split("\n");
  assert.deepEqual(tracked, ["site/index.html"]);
});
