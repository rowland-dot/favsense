import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { assertPublicTextSafe } from "../scripts/public-tree-policy.mjs";

const publisher = path.resolve(
  "skills/xhs-favorites-organizer/scripts/publish-huggingface.mjs"
);
const privateConfigFixture = path.resolve(
  "skills/xhs-favorites-organizer/test-fixtures/publisher-private-config.json"
);
const rootCredentialFixture = path.resolve(
  "skills/xhs-favorites-organizer/test-fixtures/publisher-root-credential.json"
);

test("public JSON may contain the deliberate token-free Xiaohongshu search fallback", () => {
  assert.doesNotThrow(() => assertPublicTextSafe(JSON.stringify({
    sourceUrl: "https://www.xiaohongshu.com/search_result?keyword=example&source=web_search_result_notes",
  }), "knowledge.json"));
});

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
  await writeFile(
    path.join(seed, "README.md"),
    "---\ntitle: Existing Space\nsdk: static\napp_file: site/index.html\nheader: default\nheader: duplicate\n---\n\nKeep this description.\n",
    "utf8"
  );
  await writeFile(path.join(seed, "site", "index.html"), "old", "utf8");
  await writeFile(path.join(seed, "site", "stale.js"), "stale", "utf8");
  git(["add", "."], seed);
  git(["commit", "-m", "initial"], seed);
  git(["push", "origin", "main"], seed);
  return remote;
}

test("publisher mirrors only the public site and enforces the mini Space header", async () => {
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
  const readme = await readFile(path.join(checkout, "README.md"), "utf8");
  assert.match(readme, /sdk: static/);
  assert.match(readme, /^hf_oauth:\s*true$/m);
  assert.match(readme, /^hf_oauth_scopes:\s*\r?\n\s+- contribute-repos$/m);
  assert.match(readme, /title: Existing Space/);
  assert.match(readme, /Keep this description\./);
  assert.deepEqual(readme.match(/^header:\s*.*$/gm), ["header: mini"]);
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

test("publisher refuses a credential-shaped file already present at the Space repository root", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "favsense-publish-root-secret-"));
  const remote = await createRemoteFixture(root);
  const seed = path.join(root, "seed");
  await writeFile(
    path.join(seed, "debug.json"),
    await readFile(rootCredentialFixture, "utf8"),
    "utf8"
  );
  git(["add", "debug.json"], seed);
  git(["commit", "-m", "add unsafe root fixture"], seed);
  git(["push", "origin", "main"], seed);

  const workspace = path.join(root, "workspace");
  await mkdir(path.join(workspace, "site"), { recursive: true });
  await writeFile(path.join(workspace, "site", "index.html"), "safe", "utf8");
  const result = spawnSync(
    process.execPath,
    [publisher, "--workspace", workspace, "--repository", remote, "--branch", "main"],
    { encoding: "utf8", env: { ...process.env, FAVSENSE_ALLOW_LOCAL_PUBLISH: "1" } }
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /sensitive public content/);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /fixture-credential-that-must-never-publish/);
});

test("publisher validates a cloned README before following or rewriting it", {
  skip: process.platform === "win32" ? "Git for Windows may materialize symlinks as plain files" : false,
}, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "favsense-publish-readme-link-"));
  const remote = await createRemoteFixture(root);
  const seed = path.join(root, "seed");
  const victim = path.join(root, "victim.md");
  const victimBytes = "---\ntitle: External victim\nheader: default\n---\n\nDo not modify.\n";
  await writeFile(victim, victimBytes, "utf8");
  await rm(path.join(seed, "README.md"));
  await symlink(victim, path.join(seed, "README.md"));
  git(["add", "-A", "README.md"], seed);
  git(["commit", "-m", "malicious README symlink"], seed);
  git(["push", "origin", "main"], seed);

  const workspace = path.join(root, "workspace");
  await mkdir(path.join(workspace, "site"), { recursive: true });
  await writeFile(path.join(workspace, "site", "index.html"), "safe", "utf8");
  const result = spawnSync(
    process.execPath,
    [publisher, "--workspace", workspace, "--repository", remote, "--branch", "main"],
    { encoding: "utf8", env: { ...process.env, FAVSENSE_ALLOW_LOCAL_PUBLISH: "1" } },
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /symbolic link|redirected/i);
  assert.equal(await readFile(victim, "utf8"), victimBytes);
});

test("publisher refuses raw media evidence inside the public site", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "favsense-publish-media-"));
  const remote = await createRemoteFixture(root);
  const workspace = path.join(root, "workspace");
  await mkdir(path.join(workspace, "site", "assets"), { recursive: true });
  await writeFile(path.join(workspace, "site", "index.html"), "ok", "utf8");
  await writeFile(path.join(workspace, "site", "assets", "note-frame.png"), "not really an image", "utf8");
  const result = spawnSync(
    process.execPath,
    [publisher, "--workspace", workspace, "--repository", remote, "--branch", "main"],
    { encoding: "utf8", env: { ...process.env, FAVSENSE_ALLOW_LOCAL_PUBLISH: "1" } }
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /raw evidence file/);
});

test("publisher refuses encoded private Xiaohongshu source data in a safe-named text file", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "favsense-publish-encoded-"));
  const remote = await createRemoteFixture(root);
  const workspace = path.join(root, "workspace");
  await mkdir(path.join(workspace, "site", "data"), { recursive: true });
  await writeFile(path.join(workspace, "site", "index.html"), "ok", "utf8");
  await writeFile(
    path.join(workspace, "site", "data", "debug.json"),
    JSON.stringify({ value: "https%3A%2F%2Fwww%2Exiaohongshu%2Ecom%2Fuser%2Fprofile%2Fprivate-id" }),
    "utf8"
  );
  const result = spawnSync(
    process.execPath,
    [publisher, "--workspace", workspace, "--repository", remote, "--branch", "main"],
    { encoding: "utf8", env: { ...process.env, FAVSENSE_ALLOW_LOCAL_PUBLISH: "1" } }
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /sensitive public content/);
});

test("publisher refuses structured credential keys inside public JSON", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "favsense-publish-json-secret-"));
  const remote = await createRemoteFixture(root);
  const workspace = path.join(root, "workspace");
  await mkdir(path.join(workspace, "site", "data"), { recursive: true });
  await writeFile(path.join(workspace, "site", "index.html"), "ok", "utf8");
  await writeFile(
    path.join(workspace, "site", "data", "debug.json"),
    JSON.stringify({ xsec_token: "credential-value-that-must-not-publish" }),
    "utf8"
  );
  const result = spawnSync(
    process.execPath,
    [publisher, "--workspace", workspace, "--repository", remote, "--branch", "main"],
    { encoding: "utf8", env: { ...process.env, FAVSENSE_ALLOW_LOCAL_PUBLISH: "1" } }
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /sensitive public content/);
});

test("publisher refuses unrecognized public file types", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "favsense-publish-unknown-file-"));
  const remote = await createRemoteFixture(root);
  const workspace = path.join(root, "workspace");
  await mkdir(path.join(workspace, "site", "assets"), { recursive: true });
  await writeFile(path.join(workspace, "site", "index.html"), "ok", "utf8");
  await writeFile(path.join(workspace, "site", "assets", "unexpected.zip"), "opaque", "utf8");
  const result = spawnSync(
    process.execPath,
    [publisher, "--workspace", workspace, "--repository", remote, "--branch", "main"],
    { encoding: "utf8", env: { ...process.env, FAVSENSE_ALLOW_LOCAL_PUBLISH: "1" } }
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unsupported public file type/);
});

test("publisher refuses extensionless files in the public site", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "favsense-publish-extensionless-"));
  const workspace = path.join(root, "workspace");
  await mkdir(path.join(workspace, "site", "assets"), { recursive: true });
  await writeFile(path.join(workspace, "site", "index.html"), "ok", "utf8");
  await writeFile(path.join(workspace, "site", "assets", "opaque"), "untyped payload", "utf8");
  const result = spawnSync(
    process.execPath,
    [publisher, "--workspace", workspace, "--repository", path.join(root, "unused.git"), "--branch", "main"],
    { encoding: "utf8", env: { ...process.env, FAVSENSE_ALLOW_LOCAL_PUBLISH: "1" } }
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unsupported public file type/);
});

test("publisher rejects every private source identifier from the default config without leaking it", async () => {
  const privateConfig = JSON.parse(await readFile(privateConfigFixture, "utf8"));
  const privateIdentifiers = [
    privateConfig.legacy_source_board_id,
    privateConfig.boards[0].id,
    new URL(privateConfig.profile_url).pathname.split("/").at(-1),
  ];

  for (const privateIdentifier of privateIdentifiers) {
    const root = await mkdtemp(path.join(tmpdir(), "favsense-publish-private-id-"));
    const workspace = path.join(root, "workspace");
    await mkdir(path.join(workspace, "site", "data"), { recursive: true });
    await mkdir(path.join(workspace, "config"), { recursive: true });
    await writeFile(path.join(workspace, "site", "index.html"), "ok", "utf8");
    await writeFile(
      path.join(workspace, "site", "data", "knowledge.json"),
      JSON.stringify({ accidentalSourceReference: privateIdentifier }),
      "utf8"
    );
    await writeFile(
      path.join(workspace, "config", "xhs-favorites.json"),
      JSON.stringify(privateConfig),
      "utf8"
    );

    const result = spawnSync(
      process.execPath,
      [publisher, "--workspace", workspace, "--repository", path.join(root, "unused.git"), "--branch", "main"],
      { encoding: "utf8", env: { ...process.env, FAVSENSE_ALLOW_LOCAL_PUBLISH: "1" } }
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /private source identifier/);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(privateIdentifier));
  }
});

test("publisher accepts an explicit private config path for source-identifier validation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "favsense-publish-custom-config-"));
  const workspace = path.join(root, "workspace");
  const customConfig = path.join(root, "private", "custom.json");
  const privateIdentifier = "private-custom-board-fixture-2026";
  await mkdir(path.join(workspace, "site", "data"), { recursive: true });
  await mkdir(path.dirname(customConfig), { recursive: true });
  await writeFile(path.join(workspace, "site", "index.html"), "ok", "utf8");
  await writeFile(
    path.join(workspace, "site", "data", "knowledge.json"),
    JSON.stringify({ accidentalSourceReference: privateIdentifier }),
    "utf8"
  );
  await writeFile(customConfig, JSON.stringify({ boards: [{ id: privateIdentifier }] }), "utf8");

  const result = spawnSync(
    process.execPath,
    [
      publisher,
      "--workspace", workspace,
      "--config", customConfig,
      "--repository", path.join(root, "unused.git"),
      "--branch", "main",
    ],
    { encoding: "utf8", env: { ...process.env, FAVSENSE_ALLOW_LOCAL_PUBLISH: "1" } }
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /private source identifier/);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(privateIdentifier));
});

test("publisher disables terminal and Git Credential Manager prompts", async () => {
  const source = await readFile(publisher, "utf8");
  assert.match(source, /GIT_TERMINAL_PROMPT:\s*"0"/);
  assert.match(source, /GCM_INTERACTIVE:\s*"0"/);
  assert.match(source, /credential\.interactive=false/);
});
