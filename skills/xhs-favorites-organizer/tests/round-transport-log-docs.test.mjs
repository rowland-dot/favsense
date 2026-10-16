import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Issue 139: a transport failure that ends a round leaves one line in bridge.log. The skill document that
// tells the operator what bridge.log holds must say so, with the three step names the line can carry.

const skill = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skillDoc = await readFile(resolve(skill, "SKILL.md"), "utf8");

test("SKILL.md says a transport failure that ends a round writes a ROUND line with its step", () => {
  const line = skillDoc.split("\n").find((entry) => entry.includes("bridge.log"));
  assert.ok(line, "missing the bridge.log bullet");
  assert.match(line, /传输故障/);
  assert.match(line, /`ROUND`/);
  for (const step of ["share-page-move", "chat-page-move", "chat-conversation"]) {
    assert.ok(line.includes(`\`${step}\``), `missing step ${step}`);
  }
  assert.match(line, /不写错误自带的文字/);
});
