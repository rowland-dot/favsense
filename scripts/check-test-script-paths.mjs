#!/usr/bin/env node
// Fails when an npm script (or the organization runner's own list) names a file that
// does not exist, or when two file names are joined by a missing space. Node 22+ runs
// `node --test` over a path that does not exist without complaint, so the run passes with
// those tests skipped and only CI on Node 20 notices.

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { organizationCommands } from "./run-organization-tests.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const defaultRoot = resolve(dirname(scriptPath), "..");

// An extension directly followed by more letters means two names were joined. ".json" and
// ".jsx" are different extensions, not a ".js" with a name glued on.
const joinedNames = /\.(?:mjs|cjs|py|ps1|js(?!on|x))[A-Za-z]/;
const filePath = /^[\w.\-]+(?:\/[\w.\-]+)+\.(?:mjs|cjs|js|py|ps1)$/;

export function organizationRunnerFiles() {
  return organizationCommands({ command: "python", prefixArgs: [] }).flatMap(({ args }) => args);
}

function tokenProblems(owner, command, { root, exists }) {
  const problems = [];
  for (const raw of command.split(/\s+/).filter(Boolean)) {
    const token = raw.replace(/^["']|["']$/g, "");
    if (joinedNames.test(token)) problems.push(`${owner}: two file names are joined into one path "${token}"`);
    else if (filePath.test(token) && !exists(resolve(root, token))) problems.push(`${owner}: file does not exist "${token}"`);
  }
  return problems;
}

export function findTestScriptProblems({ root = defaultRoot, scripts, organizationFiles = organizationRunnerFiles, exists = existsSync }) {
  const problems = Object.entries(scripts).flatMap(([name, command]) => tokenProblems(`script "${name}"`, command, { root, exists }));
  problems.push(...tokenProblems("organization test runner list", organizationFiles().join(" "), { root, exists }));
  return problems;
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  const root = process.argv[2] ? resolve(process.argv[2]) : defaultRoot;
  const { scripts } = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  const problems = findTestScriptProblems({ root, scripts });
  if (problems.length) {
    console.error("Test script paths are broken:");
    for (const problem of problems) console.error(`- ${problem}`);
    process.exitCode = 1;
  } else {
    console.log("Every file named in the npm scripts and the organization runner exists, and no names are joined.");
  }
}
