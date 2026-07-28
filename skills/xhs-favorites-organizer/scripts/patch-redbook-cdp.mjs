#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const SUPPORTED_VERSION = "0.8.1";
const PATCH_MARKER = "// xhs-favorites-organizer: Chrome 150 CDP compatibility patch";

function usage() {
  return `Usage:
  node patch-redbook-cdp.mjs --workspace <path> [--check|--restore]

Options:
  --workspace <path>  Workspace containing .xhs-tools
  --check             Validate that the patch can be applied without writing
  --restore           Restore the backup created before patching
  --help              Show this help
`;
}

function parseArgs(argv) {
  const options = { check: false, restore: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--check") {
      options.check = true;
      continue;
    }
    if (argument === "--restore") {
      options.restore = true;
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    if (argument !== "--workspace") throw new Error(`Unknown argument: ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error("Missing value for --workspace");
    options.workspace = value;
    index += 1;
  }
  if (options.check && options.restore) throw new Error("--check and --restore cannot be combined");
  return options;
}

function ensureInsideWorkspace(workspace, target) {
  const relative = path.relative(workspace, target);
  if (relative === "" || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Refusing to access a target outside the workspace");
  }
}

function atomicWrite(target, content) {
  const temporary = `${target}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, content, "utf8");
    fs.renameSync(temporary, target);
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
  }
}

function replaceExactlyOnce(source, before, after, label) {
  const first = source.indexOf(before);
  const last = source.lastIndexOf(before);
  if (first === -1) throw new Error(`Expected ${label} code was not found; refusing to patch`);
  if (first !== last) throw new Error(`Expected exactly one ${label} match; refusing to patch`);
  return source.slice(0, first) + after + source.slice(first + before.length);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  if (!options.workspace) throw new Error("--workspace is required\n\n" + usage());

  const workspace = path.resolve(options.workspace);
  const packageRoot = path.join(workspace, ".xhs-tools", "node_modules", "@lucasygu", "redbook");
  const packageJsonPath = path.join(packageRoot, "package.json");
  const target = path.join(packageRoot, "dist", "lib", "cdp-cookies.js");
  const backup = `${target}.xhs-favorites-organizer.bak`;
  ensureInsideWorkspace(workspace, packageJsonPath);
  ensureInsideWorkspace(workspace, target);
  ensureInsideWorkspace(workspace, backup);

  if (!fs.existsSync(packageJsonPath) || !fs.existsSync(target)) {
    throw new Error("Project-local @lucasygu/redbook installation was not found");
  }
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  if (packageJson.version !== SUPPORTED_VERSION) {
    throw new Error(`Unsupported redbook version ${packageJson.version}; expected ${SUPPORTED_VERSION}`);
  }

  if (options.restore) {
    if (!fs.existsSync(backup)) throw new Error("Patch backup was not found");
    atomicWrite(target, fs.readFileSync(backup, "utf8"));
    process.stdout.write(`${JSON.stringify({ restored: true, version: packageJson.version, target })}\n`);
    return;
  }

  let source = fs.readFileSync(target, "utf8");
  if (source.includes(PATCH_MARKER)) {
    process.stdout.write(`${JSON.stringify({ patched: true, already_applied: true, version: packageJson.version, target })}\n`);
    return;
  }

  source = replaceExactlyOnce(
    source,
    'ws.send(JSON.stringify({ id: 1, method: "Network.getAllCookies" }));',
    'ws.send(JSON.stringify({ id: 1, method: "Storage.getCookies" }));',
    "cookie method",
  );
  source = replaceExactlyOnce(
    source,
    'log("Requesting all cookies via CDP (Network.getAllCookies)...");',
    'log("Requesting all cookies via CDP (Storage.getCookies)...");',
    "cookie diagnostic",
  );
  source = replaceExactlyOnce(
    source,
    'const isProfileLock = err instanceof Error && err.message.includes("Chrome exited immediately");',
    'const shouldRetryWithTemp = err instanceof Error && (err.message.includes("Chrome exited immediately") || err.message.includes("Chrome headless did not start"));',
    "temporary-profile condition",
  );
  source = replaceExactlyOnce(
    source,
    "if (isProfileLock) {",
    "if (shouldRetryWithTemp) {",
    "temporary-profile branch",
  );
  source = `${PATCH_MARKER}\n${source}`;

  if (options.check) {
    process.stdout.write(`${JSON.stringify({ applicable: true, version: packageJson.version, target })}\n`);
    return;
  }

  if (!fs.existsSync(backup)) fs.copyFileSync(target, backup, fs.constants.COPYFILE_EXCL);
  atomicWrite(target, source);
  process.stdout.write(`${JSON.stringify({ patched: true, already_applied: false, version: packageJson.version, target, backup })}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`patch-redbook-cdp: ${error.message}\n`);
  process.exitCode = 1;
}
