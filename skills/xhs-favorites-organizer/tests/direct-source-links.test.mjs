import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TODAY, hex, profile, root } from "./public-judgement-fixtures.mjs";

// Issue 106: a card goes direct to the post only while the private code store holds a code for it (and, once
// the one age setting exists, only while that code is younger than the setting). Every other card keeps the
// search link. Codes here are made up. TODAY is a fixed date that is not the day the suite runs.

const builder = join(root, "skills/xhs-favorites-organizer/scripts/build-public-site.mjs");
const NOTE_A = "6a7dc92600000000250090ff";
const NOTE_B = "6a7dc92600000000250090aa";
const NOTE_C = "6a7dc92600000000250090bb";
const post = (extra = {}) => ({ title: "有标题", description: "正文。", author: "作者", source_boards: ["Synthetic"], content_sha256: hex("c"), type: "视频", ...extra });
const entry = (code, extra = {}) => ({ code, source: "pc_collect", captured_at: "2026-10-09T08:00:00.000Z", batch: "batch-late", ...extra });
const storeOf = (notes) => ({ schema_version: 1, notes });

// Runs the builder on the given notes and store. `storeText` writes a raw (possibly broken) store file;
// `store: undefined` and `storeText: undefined` pass no store at all. `source_link` is merged into the domain profile.
async function run({ notes, store, storeText, sourceLink, noStoreArgument = false, extraArgs = [] }) {
  const work = await mkdtemp(join(tmpdir(), "favsense-direct-links-"));
  const at = (name) => join(work, name);
  try {
    await writeFile(at("catalog.json"), JSON.stringify({ version: 1, notes }));
    await writeFile(at("curation.json"), "{}");
    await writeFile(at("candidates.json"), "{}");
    await writeFile(at("profile.json"), JSON.stringify(sourceLink === undefined ? profile : { ...profile, source_link: sourceLink }));
    await writeFile(at("resources.json"), JSON.stringify({ verified_at: TODAY, resources: [] }));
    await writeFile(at("damaged.json"), JSON.stringify({ entries: [] }));
    await writeFile(at("config.json"), JSON.stringify({
      version: 1, domain_profile: at("profile.json"), curation_file: at("curation.json"),
      boards: [{ id: "private-board-id", name: "Synthetic", enabled: true }], public_stats: {},
    }));
    const storeArgs = [];
    if (storeText !== undefined) { await writeFile(at("codes.json"), storeText); storeArgs.push("--source-codes", at("codes.json")); }
    else if (store !== undefined) { await writeFile(at("codes.json"), JSON.stringify(store)); storeArgs.push("--source-codes", at("codes.json")); }
    const result = spawnSync(process.execPath, [
      builder, "--catalog", at("catalog.json"), "--config", at("config.json"), "--curation", at("curation.json"),
      "--candidates", at("candidates.json"), "--profile", at("profile.json"), "--resources", at("resources.json"),
      "--effective-date", TODAY, "--diandian-dir", at("replies"), "--video-analysis", at("video"),
      "--damaged-replies", at("damaged.json"), "--output", at("public.json"),
      ...(noStoreArgument ? [] : storeArgs), ...extraArgs,
    ], { cwd: root, encoding: "utf8" });
    const written = await readFile(at("public.json"), "utf8").catch(() => null);
    const data = written === null ? null : JSON.parse(written);
    return { status: result.status, stderr: result.stderr, written, cards: data ? Object.fromEntries(data.notes.map((card) => [card.id, card])) : null };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

const SEARCH = /^https:\/\/www\.xiaohongshu\.com\/search_result\?/;

test("a note with a stored code gets its signed post link; a note without one keeps the search link", async () => {
  const { status, stderr, cards } = await run({
    notes: { [NOTE_A]: post({ title: "有码的帖子" }), [NOTE_B]: post({ title: "没有码的帖子" }) },
    store: storeOf({ [NOTE_A]: entry("FAKEcodeA1==") }),
  });
  assert.equal(status, 0, stderr);
  // The expected link is written out by hand (the code's "=" is percent-encoded), not built the way the builder builds it.
  assert.equal(cards[NOTE_A].sourceUrl, `https://www.xiaohongshu.com/explore/${NOTE_A}?xsec_token=FAKEcodeA1%3D%3D&xsec_source=pc_collect`);
  assert.equal(cards[NOTE_A].linkKind, "post");
  assert.match(cards[NOTE_B].sourceUrl, /^https:\/\/www\.xiaohongshu\.com\/search_result\?/);
  assert.equal(cards[NOTE_B].linkKind, "search");
});

test("a code kept from an earlier sync still gives a post link: a later normal sync that skipped the note takes nothing away", async () => {
  const { status, stderr, cards } = await run({
    notes: { [NOTE_A]: post(), [NOTE_B]: post() },
    store: storeOf({
      [NOTE_A]: entry("FAKEcodeA1", { batch: "batch-early", captured_at: "2026-08-03T08:00:00.000Z" }),
      [NOTE_B]: entry("FAKEcodeB1", { batch: "batch-late" }),
    }),
  });
  assert.equal(status, 0, stderr);
  assert.equal(cards[NOTE_A].linkKind, "post");
  assert.equal(cards[NOTE_B].linkKind, "post");
});

test("a code with characters that need escaping is escaped in the link", async () => {
  const { status, stderr, cards } = await run({ notes: { [NOTE_A]: post() }, store: storeOf({ [NOTE_A]: entry("ab+cd/ef==", { source: "pc_share" }) }) });
  assert.equal(status, 0, stderr);
  assert.equal(cards[NOTE_A].sourceUrl, `https://www.xiaohongshu.com/explore/${NOTE_A}?xsec_token=ab%2Bcd%2Fef%3D%3D&xsec_source=pc_share`);
});

test("with the age setting, a code younger than it gives a post link and an older one the search link", async () => {
  // Effective date 2026-10-10, setting 5 days: age 1 and 4 are younger than 5; 5 and 6 are not; a capture dated after the build is not usable.
  const when = { [NOTE_A]: "2026-10-09", [NOTE_B]: "2026-10-04", [NOTE_C]: "2026-10-06", "d4": "2026-10-05", "d5": "2026-10-11" };
  const notes = Object.fromEntries(Object.keys(when).map((id) => [id, post()]));
  const { status, stderr, cards } = await run({
    notes,
    sourceLink: { code_max_age_days: 5 },
    store: storeOf(Object.fromEntries(Object.entries(when).map(([id, day]) => [id, entry(`FAKE${id}`, { captured_at: `${day}T23:59:00.000Z` })]))),
  });
  assert.equal(status, 0, stderr);
  assert.equal(cards[NOTE_A].linkKind, "post", "1 day old");
  assert.equal(cards[NOTE_C].linkKind, "post", "4 days old");
  assert.equal(cards[NOTE_B].linkKind, "search", "6 days old");
  assert.equal(cards.d4.linkKind, "search", "exactly 5 days old is not younger than 5");
  assert.equal(cards.d5.linkKind, "search", "captured after the build date");
  assert.match(cards[NOTE_B].sourceUrl, SEARCH);
});

test("a settings section with no age in it means no age limit yet", async () => {
  const { status, stderr, cards } = await run({
    notes: { [NOTE_A]: post() }, sourceLink: {},
    store: storeOf({ [NOTE_A]: entry("FAKEcodeA1", { captured_at: "2026-01-01T00:00:00.000Z" }) }),
  });
  assert.equal(status, 0, stderr);
  assert.equal(cards[NOTE_A].linkKind, "post");
});

for (const [name, sourceLink] of [
  ["a negative number", { code_max_age_days: -1 }],
  ["text", { code_max_age_days: "7" }],
  ["a fraction", { code_max_age_days: 1.5 }],
  ["null", { code_max_age_days: null }],
  ["a section that is not an object", "7"],
]) {
  test(`an age setting that is ${name} stops the build and writes nothing`, async () => {
    const outcome = await run({ notes: { [NOTE_A]: post() }, sourceLink, store: storeOf({ [NOTE_A]: entry("FAKEcodeA1") }) });
    assert.notEqual(outcome.status, 0);
    assert.match(outcome.stderr, /SOURCE_CODE_MAX_AGE_INVALID/);
    assert.equal(outcome.written, null);
  });
}

test("a code stored for one note never appears on another note, and a stored note the catalog does not have is ignored", async () => {
  const { status, stderr, cards, written } = await run({
    notes: { [NOTE_A]: post(), [NOTE_B]: post() },
    store: storeOf({ [NOTE_A]: entry("FAKEcodeA1"), [NOTE_C]: entry("FAKEcodeC1") }),
  });
  assert.equal(status, 0, stderr);
  assert.match(cards[NOTE_B].sourceUrl, SEARCH);
  assert.equal(cards[NOTE_B].linkKind, "search");
  assert.equal(written.includes("FAKEcodeC1"), false, "a code for a note that is not in the catalog is not published");
  assert.equal(written.split("FAKEcodeA1").length - 1, 1, "the code appears once, in its own card's link");
});

test("a build with no store, a missing store file and an empty store all give the same data", async () => {
  const notes = { [NOTE_A]: post(), [NOTE_B]: post({ title: "另一个" }) };
  const without = await run({ notes });
  const empty = await run({ notes, store: storeOf({}) });
  const missing = await run({ notes, extraArgs: ["--source-codes", join(tmpdir(), "favsense-no-such-store.json")] });
  for (const outcome of [without, empty, missing]) assert.equal(outcome.status, 0, outcome.stderr);
  const strip = (outcome) => JSON.stringify(JSON.parse(outcome.written).notes);
  assert.equal(strip(empty), strip(without));
  assert.equal(strip(missing), strip(without));
  for (const card of Object.values(without.cards)) {
    assert.match(card.sourceUrl, SEARCH);
    assert.equal(card.linkKind, "search");
  }
});

for (const [name, text] of [
  ["not JSON", "{ nope"],
  ["the wrong version", JSON.stringify({ schema_version: 2, notes: {} })],
  ["a list of notes", JSON.stringify({ schema_version: 1, notes: [] })],
  ["an entry with no code", JSON.stringify(storeOf({ [NOTE_A]: { source: "pc_collect", captured_at: "2026-10-09T00:00:00.000Z", batch: "b" } }))],
  ["a code with a space", JSON.stringify(storeOf({ [NOTE_A]: entry("FAKE code") }))],
  ["a note id that is not an id", JSON.stringify(storeOf({ "../x": entry("FAKEcodeA1") }))],
  ["a capture time that is not a time", JSON.stringify(storeOf({ [NOTE_A]: entry("FAKEcodeA1", { captured_at: "yesterday" }) }))],
]) {
  test(`a store that is ${name} stops the build, writes nothing and does not repeat what it held`, async () => {
    const outcome = await run({ notes: { [NOTE_A]: post() }, storeText: text });
    assert.notEqual(outcome.status, 0);
    assert.match(outcome.stderr, /SOURCE_CODE_STORE_MALFORMED/);
    assert.equal(outcome.stderr.includes("FAKE"), false);
    assert.equal(outcome.written, null);
  });
}

// ---- The public check: a signed link is allowed as a card's whole source link, for that card's own note, and nowhere else.

const { assertPublicTextSafe, validatePublicTree } = await import("../scripts/public-tree-policy.mjs");
const signed = (id, code = "FAKEcodeA1", source = "pc_collect") => `https://www.xiaohongshu.com/explore/${id}?xsec_token=${code}&xsec_source=${source}`;
const dataOf = (...cards) => JSON.stringify({ meta: { title: "t" }, notes: cards.map((card) => ({ id: NOTE_A, title: "t", mainText: "正文", sourceUrl: signed(NOTE_A), ...card })) });
const refused = (content, label = "data/knowledge.json", identifiers = []) => assert.throws(() => assertPublicTextSafe(content, label, identifiers), /not allowed/);

test("the check lets a card's own signed link through as its source link", () => {
  assert.doesNotThrow(() => assertPublicTextSafe(dataOf({}), "data/knowledge.json"));
  assert.doesNotThrow(() => assertPublicTextSafe(dataOf({ sourceUrl: signed(NOTE_A, "ab%2Bcd%2Fef%3D%3D") }), "data/knowledge.json"));
});

for (const [name, card] of [
  ["a signed link for a different note", { sourceUrl: signed(NOTE_B) }],
  ["a signed link with an extra parameter", { sourceUrl: `${signed(NOTE_A)}&utm=1` }],
  ["a signed link with text around it", { sourceUrl: `看 ${signed(NOTE_A)}` }],
  ["a signed link in the other post address shape", { sourceUrl: signed(NOTE_A).replace("/explore/", "/discovery/item/") }],
  ["a plain post link with no code", { sourceUrl: `https://www.xiaohongshu.com/explore/${NOTE_A}` }],
  ["a signed link in the card's text", { mainText: `原帖 ${signed(NOTE_A)}` }],
  ["a code written in the card's text", { mainText: "xsec_token=FAKEcodeA1" }],
  ["a signed link in another field", { title: signed(NOTE_A) }],
]) {
  test(`the check still refuses ${name}`, () => refused(dataOf(card)));
}

test("the check refuses the code key in a JSON object and a signed link outside a card's source link", () => {
  refused(JSON.stringify({ notes: [{ id: NOTE_A, sourceUrl: signed(NOTE_A), xsec_token: "FAKEcodeA1" }] }));
  refused(JSON.stringify({ meta: { link: signed(NOTE_A) }, notes: [] }));
  refused(JSON.stringify({ notes: [{ id: NOTE_A, sourceUrl: signed(NOTE_A) }, { id: NOTE_B, sourceUrl: signed(NOTE_A) }] }));
});

test("a signed link is refused in every file that is not the data file", () => {
  refused(`<a href="${signed(NOTE_A)}">x</a>`, "index.html");
  refused(`const url = "${signed(NOTE_A)}";`, "app.js");
  refused(signed(NOTE_A), "notes.md");
});

test("cookies, the bridge token, profile and folder addresses are still refused next to an allowed link", () => {
  const bridgeToken = "0123456789abcdef".repeat(4);
  refused(dataOf({ mainText: "cookie: abcdefgh12345678" }));
  refused(dataOf({ mainText: "见 https://www.xiaohongshu.com/user/profile/abc123" }));
  refused(dataOf({ mainText: "见 https://www.xiaohongshu.com/board/abc123456" }));
  refused(dataOf({ mainText: bridgeToken }), "data/knowledge.json", [bridgeToken]);
  refused(dataOf({ mainText: `bridge_token=${bridgeToken}` }), "data/knowledge.json", [bridgeToken]);
});

test("the publisher's tree check lets the data file's own signed links through and stops one anywhere else", async () => {
  const work = await mkdtemp(join(tmpdir(), "favsense-tree-"));
  try {
    await mkdir(join(work, "data"), { recursive: true });
    await writeFile(join(work, "index.html"), "<!doctype html><title>t</title>");
    await writeFile(join(work, "data", "knowledge.json"), dataOf({}));
    await validatePublicTree(work);
    await writeFile(join(work, "notes.md"), signed(NOTE_A));
    await assert.rejects(validatePublicTree(work), /not allowed/);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

// ---- The builder reads the bridge token itself and refuses it in any card text.

const BRIDGE_TOKEN = "7e".repeat(32);
async function withTokenFile(content, body) {
  const work = await mkdtemp(join(tmpdir(), "favsense-bridge-token-"));
  try {
    const file = join(work, "bridge-token");
    if (content !== null) await writeFile(file, content);
    return await body(file);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

for (const [name, text] of [["bare", `读出 ${BRIDGE_TOKEN} 这串`], ["labelled", `bridge_token=${BRIDGE_TOKEN}`]]) {
  test(`the builder refuses the bridge token written ${name} in a card's text, names the card and does not repeat it`, async () => {
    const outcome = await withTokenFile(`${BRIDGE_TOKEN}\n`, (file) => run({
      notes: { [NOTE_A]: post({ description: text }) }, extraArgs: ["--bridge-token-file", file],
    }));
    assert.notEqual(outcome.status, 0);
    assert.match(outcome.stderr, /Public data safety check failed/);
    assert.match(outcome.stderr, new RegExp(NOTE_A));
    assert.equal(outcome.stderr.includes(BRIDGE_TOKEN), false);
    assert.equal(outcome.written, null);
  });
}

test("a missing or malformed bridge token file adds no refusal", async () => {
  for (const content of [null, "not a token"]) {
    const outcome = await withTokenFile(content, (file) => run({
      notes: { [NOTE_A]: post({ description: BRIDGE_TOKEN }) }, extraArgs: ["--bridge-token-file", file],
    }));
    assert.equal(outcome.status, 0, outcome.stderr);
  }
});
