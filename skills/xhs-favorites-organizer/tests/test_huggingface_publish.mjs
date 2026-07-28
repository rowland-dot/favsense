import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
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

async function createRemoteFixture(root) {
  const remote = path.join(root, "space.git");
  const seed = path.join(root, "seed");
  git(["init", "--bare", "--initial-branch=main", remote], root);
  git(["clone", remote, seed], root);
  git(["config", "user.name", "FavSense Test"], seed);
  git(["config", "user.email", "test@example.invalid"], seed);
  await mkdir(path.join(seed, "site"), { recursive: true });
  await writeFile(path.join(seed, "README.md"), "---\nsdk: static\napp_file: site/index.html\n---\n", "utf8");
  await writeFile(path.join(seed, "site", "index.html"), "old", "utf8");
  await writeFile(path.join(seed, "site", "stale.js"), "stale", "utf8");
  git(["add", "."], seed);
  git(["commit", "-m", "initial"], seed);
  git(["push", "origin", "main"], seed);
  return remote;
}

test("publisher mirrors only the public site and preserves Space metadata", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "favsense-publish-test-"));
  const workspace = path.join(root, "workspace");
  const remote = await createRemoteFixture(root);
  await mkdir(path.join(workspace, "site", "data"), { recursive: true });
  await mkdir(path.join(workspace, "site", ".local"), { recursive: true });
  await writeFile(path.join(workspace, "site", "index.html"), "new", "utf8");
  await writeFile(path.join(workspace, "site", "data", "knowledge.json"), "{\"notes\":[]}", "utf8");
  await writeFile(path.join(workspace, "site", ".local", "bridge.json"), "private", "utf8");

  const published = spawnSync(
    process.execPath,
    [publisher, "--workspace", workspace, "--repository", remote, "--branch", "main"],
    {
      encoding: "utf8",
      env: { ...process.env, FAVSENSE_ALLOW_LOCAL_PUBLISH: "1" },
    }
  );
  assert.equal(published.status, 0, published.stderr || published.stdout);
  assert.equal(JSON.parse(published.stdout).status, "published");

  const checkout = path.join(root, "checkout");
  git(["clone", remote, checkout], root);
  assert.match(await readFile(path.join(checkout, "README.md"), "utf8"), /sdk: static/);
  assert.equal(await readFile(path.join(checkout, "site", "index.html"), "utf8"), "new");
  assert.equal(await readFile(path.join(checkout, "site", "data", "knowledge.json"), "utf8"), "{\"notes\":[]}");
  assert.throws(() => git(["ls-files", "--error-unmatch", "site/stale.js"], checkout));
  assert.throws(() => git(["ls-files", "--error-unmatch", "site/.local/bridge.json"], checkout));

  const unchanged = spawnSync(
    process.execPath,
    [publisher, "--workspace", workspace, "--repository", remote, "--branch", "main"],
    {
      encoding: "utf8",
      env: { ...process.env, FAVSENSE_ALLOW_LOCAL_PUBLISH: "1" },
    }
  );
  assert.equal(unchanged.status, 0, unchanged.stderr || unchanged.stdout);
  assert.equal(JSON.parse(unchanged.stdout).status, "unchanged");
});

test("publisher rejects repositories outside Hugging Face Spaces", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "favsense-publish-invalid-"));
  await mkdir(path.join(root, "site"), { recursive: true });
  await writeFile(path.join(root, "site", "index.html"), "ok", "utf8");
  const result = spawnSync(
    process.execPath,
    [publisher, "--workspace", root, "--repository", "https://example.com/not-a-space", "--branch", "main"],
    { encoding: "utf8" }
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Hugging Face Space repository/);
});

test("publisher refuses secret-like files inside the public site", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "favsense-publish-secret-"));
  const remote = await createRemoteFixture(root);
  const workspace = path.join(root, "workspace");
  await mkdir(path.join(workspace, "site"), { recursive: true });
  await writeFile(path.join(workspace, "site", "index.html"), "ok", "utf8");
  await writeFile(path.join(workspace, "site", ".env"), "HF_TOKEN=do-not-publish", "utf8");
  const result = spawnSync(
    process.execPath,
    [publisher, "--workspace", workspace, "--repository", remote, "--branch", "main"],
    {
      encoding: "utf8",
      env: { ...process.env, FAVSENSE_ALLOW_LOCAL_PUBLISH: "1" },
    }
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /secret-like public file/);
});

test("publisher disables terminal and Git Credential Manager prompts", async () => {
  const source = await readFile(publisher, "utf8");
  assert.match(source, /GIT_TERMINAL_PROMPT:\s*"0"/);
  assert.match(source, /GCM_INTERACTIVE:\s*"0"/);
  assert.match(source, /credential\.interactive=false/);
});
