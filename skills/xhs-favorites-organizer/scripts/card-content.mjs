// One deterministic step: what a card says. Its inputs are the catalog record, the saved DianDian reply,
// the text taken out of the post's media, and (elsewhere) the optional add-on. It reads no review state
// and no run record, so no agent session can decide whether a card shows in full.

export const TITLE_LIMIT = 52;
const tidy = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

// A plain tag is "#word" that starts after a space or the line start and holds at least one non-digit,
// so "C#" and a bare "#1" are not tags. Only a run of them at the very end of a line is removed.
const PLAIN_TAG = "#(?=[^\\s#]*[^\\s#\\d])[^\\s#]+";
const TRAILING_TAG_RUN = new RegExp(`(?:^|\\s)${PLAIN_TAG}(?:\\s*${PLAIN_TAG})*\\s*$`);
export const stripTrailingTags = (line) => String(line ?? "").replace(TRAILING_TAG_RUN, "").trim();

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
export function cardTitle({ title, body, author, noteId }) {
  const own = tidy(title);
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
  if (state === "complete") return { mainText: point.summary, mainSource: "diandian", extractedSection: null };
  if (body) return { mainText: body, mainSource: "post-text", extractedSection: state === "absent" ? extracted : null };
  if (extracted) return { mainText: extracted.text, mainSource: extracted.kind, extractedSection: null };
  // A damaged reply is the only text left (D10): showing its saved part beats a card with no text.
  if (point) return { mainText: point.summary, mainSource: "diandian", extractedSection: null };
  return { mainText: "", mainSource: "post-text", extractedSection: null };
}

// The two numbers on the home page: cards that show a complete DianDian reply, cards that show a video transcript.
export function cardCounts(cards) {
  return {
    replyCount: cards.filter((card) => card.mainSource === "diandian" && !card.replyDamaged).length,
    transcriptCount: cards.filter((card) => card.mainSource === "video-transcript" || card.extracted?.kind === "video-transcript").length,
  };
}
