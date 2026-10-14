import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { damageSigns } from "../scripts/damaged-replies.mjs";
import { assertPublicTextSafe } from "../scripts/public-tree-policy.mjs";

// Step 7 audit: two properties of the feature that no other test holds in one place.
//   1. Spec §8: the card rules read files already on disk and touch no network and no browser.
//   2. The data the site ships (site/data/knowledge.json, committed) keeps the promises the rules make about a card,
//      judged from the card itself, so a stale damaged list or a half-finished rebuild is caught without the private folder.

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const scripts = join(repo, "skills/xhs-favorites-organizer/scripts");
const CARD_PATH = [
  join(scripts, "card-content.mjs"), join(scripts, "damaged-replies.mjs"), join(scripts, "extracted-text.mjs"),
  join(scripts, "evidence-files.mjs"), join(scripts, "public-judgement.mjs"), join(scripts, "build-public-site.mjs"),
  join(repo, "site/diandian-text.mjs"),
];

test("§8: the modules that make a card import nothing that can reach a network, a browser or another program", () => {
  const forbidden = /^\s*(?:import\s[^;]*?from\s+|import\s*\(\s*|(?:const|let|var)\s+[^=]+=\s*require\s*\(\s*)["'](?:node:)?(?:http|https|http2|net|tls|dgram|dns|child_process|worker_threads|cluster|playwright|@playwright\/test|puppeteer|axios|node-fetch|undici)["']/m;
  for (const file of CARD_PATH) {
    const source = readFileSync(file, "utf8");
    assert.doesNotMatch(source, forbidden, `${file} imports a network or process module`);
    const code = source.split("\n").filter((line) => !/^\s*(?:\/\/|\*|\/\*)/.test(line)).join("\n");
    assert.doesNotMatch(code, /\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b/, `${file} calls the network`);
  }
});

const data = JSON.parse(readFileSync(join(repo, "site/data/knowledge.json"), "utf8"));
const textsOf = (card) => [card.title, card.mainText, card.extracted?.text ?? "", ...card.themes, ...card.tools];

test("shipped data: no card text carries a replacement character or a leftover topic tag", () => {
  const replacement = data.notes.filter((card) => textsOf(card).some((text) => text.includes("�"))).map((card) => card.id);
  assert.deepEqual(replacement, [], "text that could not be decoded is shown");
  const tagged = data.notes.filter((card) => [card.mainText, card.extracted?.text ?? ""].some((text) => /\[话题\]/.test(text))).map((card) => card.id);
  assert.deepEqual(tagged, [], "a topic tag was not taken out of the text");
});

test("shipped data: each card's parts fit together the way the card rules put them (one main source, an extra section only beside post text)", () => {
  const broken = [];
  for (const card of data.notes) {
    const say = (reason) => broken.push(`${card.id}: ${reason}`);
    if (card.extracted) {
      if (card.mainSource !== "post-text") say("an extracted section beside a main text that is not the post's own");
      if (card.replyDamaged) say("an extracted section on a card whose saved reply is damaged");
      if (card.extracted.kind === "image-text" && card.mediaType !== "图文") say("picture text on a video card");
      if (card.extracted.kind === "video-transcript" && card.mediaType === "图文") say("a transcript on an image card");
    }
    if (card.mainSource === "image-text" && card.mediaType !== "图文") say("picture text as main text of a video card");
    if (card.mainSource === "video-transcript" && card.mediaType === "图文") say("a transcript as main text of an image card");
    if (["video-transcript", "image-text"].includes(card.mainSource) && card.extracted) say("extracted text both as main text and as a section");
    if (!card.mainText.trim()) say("no text at all");
  }
  assert.deepEqual(broken, []);
});

test("shipped data: a card that presents a reply as complete carries no sign of lost text (the frozen damaged list was current when the data was built)", () => {
  const stale = data.notes
    .filter((card) => card.mainSource === "diandian" && !card.replyDamaged)
    .filter((card) => damageSigns(card.mainText).length)
    .map((card) => card.id);
  assert.deepEqual(stale, []);
  // And the other way round: every card marked damaged really shows one of the two signs, so the marker is not stale either.
  const unfounded = data.notes
    .filter((card) => card.mainSource === "diandian" && card.replyDamaged)
    .filter((card) => !damageSigns(card.mainText).length)
    .map((card) => card.id);
  assert.deepEqual(unfounded, []);
});

test("shipped data: the numbers on the home page are the numbers of the cards, and the file passes the publisher's own safety check", () => {
  assert.equal(data.meta.noteCount, data.notes.length);
  assert.deepEqual(data.notes.map((card) => card.number), data.notes.map((_, index) => index + 1), "cards are numbered 1..n in order");
  assert.equal(new Set(data.notes.map((card) => card.id)).size, data.notes.length, "a note appears twice");
  assert.doesNotThrow(() => assertPublicTextSafe(readFileSync(join(repo, "site/data/knowledge.json"), "utf8"), "data/knowledge.json"));
});
