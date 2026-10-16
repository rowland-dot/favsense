// One deterministic step: what a card says. Its inputs are the catalog record, the saved DianDian reply,
// the text taken out of the post's media, and (elsewhere) the optional add-on. It reads no review state
// and no run record, so no agent session can decide whether a card shows in full.

export const TITLE_LIMIT = 52;
const tidy = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

// A plain tag is "#word" that starts after a space or the line start and holds at least one non-digit,
// so "C#" and a bare "#1" are not tags. Only a run of them at the very end of a line is removed.
const PLAIN_TAG = "#(?=[^\\s#]*[^\\s#\\d])[^\\s#]+";
const TAG_RUN = `${PLAIN_TAG}(?:\\s*${PLAIN_TAG})*\\s*$`;
const TRAILING_TAG_RUN = new RegExp(`(?:^|\\s)${TAG_RUN}`);
// Invisible characters (zero-width spaces and joiners, word joiner, byte-order mark) turn up inside saved replies,
// even between the characters of a label, so the label pattern allows them anywhere.
const INVISIBLE = "[\\u200b-\\u200d\\u2060\\ufeff]";
const INVISIBLES = new RegExp(INVISIBLE, "g");
const bare = (text) => String(text).replace(INVISIBLES, "").trim();
const gap = `${INVISIBLE}*`;
// A closing run introduced by a label ("标签：", "笔记标签：", "标签包括：") goes with its label, wherever the label sits.
const LABELLED_TAG_RUN = new RegExp(`${gap}(?:笔${gap}记${gap})?标${gap}签${gap}(?:包${gap}括${gap})?\\s*[：:]${gap}\\s*${TAG_RUN}`);
// A tag may also be glued to the last word ("博主#Ai"). It must start with a non-digit, and a lone letter
// before the "#" ("C#", "学C#入门") is a language name, not a word with a tag.
const GLUED_TAG_RUN = new RegExp(`(?<!(?:^|[^A-Za-z])[A-Za-z])(?<=[^\\s#])#(?=[^\\d\\s#])[^\\s#]+(?:\\s*${PLAIN_TAG})*\\s*$`);
export const stripTrailingTags = (line) => String(line ?? "")
  .replace(LABELLED_TAG_RUN, "").replace(TRAILING_TAG_RUN, "").replace(GLUED_TAG_RUN, "").trim();

// A closing line that introduced its tags in words no label pattern can list ("笔记标签涉及", "笔记作者还附带了话题",
// "笔记带上了") is left holding only that lead-in once the tags go. A remainder this short with no sentence end is
// a lead-in, not text, so the whole line goes. 12 is measured against the three saved endings (6, 10 and 5 characters).
const LEAD_IN_MAX = 12;
const SENTENCE_END = /[。！？.!?]/;
const isLeadIn = (text) => Array.from(bare(text)).length <= LEAD_IN_MAX && !SENTENCE_END.test(text);
// The heading of a tag section ("标签", "笔记标签：") whose tags were just removed.
const TAG_HEADING = /^(?:笔记)?(?:话题)?标签[：:]?$/;

// A DianDian reply with its closing tag lines removed: the last line loses its tags, and a last line that
// was only tags (or a label and tags, or a short lead-in and tags) goes whole, repeatedly. A bare tag heading
// above removed tags goes too. Lines above the closing ones are never touched, and a reply with nothing to
// remove comes back exactly as saved.
export function replyBody(summary) {
  const original = String(summary ?? "");
  const lines = original.replace(/\r\n?/g, "\n").trimEnd().split("\n");
  let changed = false;
  while (lines.length) {
    const last = lines.pop();
    if (!bare(last)) continue;
    if (changed && TAG_HEADING.test(bare(last))) continue;
    const kept = stripTrailingTags(last);
    if (kept === last.trim()) { lines.push(last); break; }
    changed = true;
    if (bare(kept) && !isLeadIn(kept)) { lines.push(kept); break; }
  }
  return changed ? lines.join("\n").trimEnd() : original;
}

// The post's own words with its topic tags taken out. Line breaks are kept and nothing is cut.
export function postBody(description) {
  const lines = String(description ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/#[^#\n]*?\[话题\]#?/g, " ")
    .replace(/\[[^\]\n]*话题[^\]\n]*\]/g, " ")
    .split("\n")
    .map((line) => line.replace(/[ \t 　]+/g, " ").trim());
  return lines.map(stripTrailingTags).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// The post's own title; else the first line of its text (cut at 52 with an ellipsis); else the author's collection.
// Either way a closing tag run is removed; a title that is only tags counts as no title.
export function cardTitle({ title, body, author, noteId }) {
  const own = stripTrailingTags(tidy(title));
  if (own) return own;
  const first = stripTrailingTags(tidy(String(body ?? "").split("\n").find((line) => line.trim()) ?? ""));
  // Count and cut by characters (code points), so an emoji at the limit is never split in half.
  const chars = Array.from(first);
  if (first && chars.length <= TITLE_LIMIT) return first;
  // The cut can land inside a run of tags in the middle of the line, so the tag rule applies to the cut too.
  const head = first && stripTrailingTags(chars.slice(0, TITLE_LIMIT - 1).join(""));
  if (head) return `${head}…`;
  const who = tidy(author);
  return who ? `${who}的收藏` : `收藏条目 · ${String(noteId).slice(-6)}`;
}

// "damaged" means the saved reply is the very copy on the frozen damaged list; a re-fetched reply has a
// different hash and counts as complete again. A refusal never reaches here (the loader drops it), so it is "absent".
export function replyState(noteId, point, damagedReplies) {
  if (!point) return "absent";
  return damagedReplies.get(noteId) === point.summary_sha256 ? "damaged" : "complete";
}

export function cardText({ body, point, state, extracted }) {
  if (state === "complete") return { mainText: replyBody(point.summary), mainSource: "diandian", extractedSection: null };
  if (body) return { mainText: body, mainSource: "post-text", extractedSection: state === "absent" ? extracted : null };
  if (extracted) return { mainText: extracted.text, mainSource: extracted.kind, extractedSection: null };
  // A damaged reply is the only text left (D10): showing its saved part beats a card with no text.
  if (point) return { mainText: replyBody(point.summary), mainSource: "diandian", extractedSection: null };
  return { mainText: "", mainSource: "post-text", extractedSection: null };
}

// The two numbers on the home page: cards that show a complete DianDian reply, cards that show a video transcript.
export function cardCounts(cards) {
  return {
    replyCount: cards.filter((card) => card.mainSource === "diandian" && !card.replyDamaged).length,
    transcriptCount: cards.filter((card) => card.mainSource === "video-transcript" || card.extracted?.kind === "video-transcript").length,
  };
}
