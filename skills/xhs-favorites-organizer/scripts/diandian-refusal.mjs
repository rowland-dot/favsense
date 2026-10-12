// Whether a DianDian reply is a refusal to read the note, not a summary of it.
//
// Now and then DianDian does not open the note. It answers that it cannot reach the link and asks for the
// text or a screenshot to be sent back. Such a reply is never a summary: no reader of a saved record may
// treat it as evidence, and nothing may show it as a note's summary.
//
// This is the one JavaScript copy of the rule. The Python copy is diandian_refusal.py. Both are tested
// against test-fixtures/diandian-refusal-cases.json, which holds real replies.

// The page wraps bold words in zero-width spaces, so they sit inside real replies.
const INVISIBLE = /[​‌‍⁠﻿]/g;

// A refusal says so at the start; a summary that merely contains these words further in is not one.
const LEAD_CHARS = 400;

// Form 1: opens with an apology and says "cannot" in that same sentence. This alone identifies a reply
// cut off after its first clause, which names no copy or screenshot request.
const APOLOGY_THEN_CANNOT = /^\s*(?:很)?抱歉[^。！？!?\n]*?无法/;

// Form 2: asks for the note's text or a screenshot to be sent back, with or without an apology.
const ASKS_TO_SEND_THE_NOTE = /(?:复制|粘贴|截图|截屏)[^。！？!?\n]{0,30}?(?:发给我|发送给我|发我|贴给我|给我)/;

export function isDiandianRefusal(text) {
  if (typeof text !== "string") return false;
  const lead = text.replace(INVISIBLE, "").slice(0, LEAD_CHARS);
  return APOLOGY_THEN_CANNOT.test(lead) || ASKS_TO_SEND_THE_NOTE.test(lead);
}
