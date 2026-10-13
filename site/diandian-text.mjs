// How a saved DianDian reply is shaped for display. The stored reply is never changed: only the
// chat-style opening line is left out, and the plain lines are grouped into headings, paragraphs and lists.

// "根据你引用的笔记……：" / "以下是核心总结：" — the assistant talking to the person who asked, not the note.
const OPENER = /^(?:根据(?:你|获取到)|以下是)/;
const OPENER_ENDING = /[：:。]$/;
const OPENER_MAX_LENGTH = 200;
// A heading is a short line with no sentence punctuation in it, standing apart from other such lines.
const HEADING_MAX_LENGTH = 24;
const SENTENCE_MARKS = /[。！？!?；;，,：:、（）()“”"…]/;
const MARKDOWN_HEADING = /^#{1,6}\s+(.+)$/;
const BOLD_LINE = /^\*\*([^*]+)\*\*[：:]?$/;
const LIST_MARKER = /^(?:[-*•·]|\d{1,2}\s*[、，.)．])\s*/;
const NUMERIC_MARKER = /^\d{1,2}\s*[、，.)．]/;
const COUNT_WORD = /(\d+|[一二三四五六七八九十])\s*个/;
const CHINESE_DIGITS = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
const INVISIBLE = /[​-‍﻿]/g;

export function stripDiandianOpener(reply) {
  const paragraphs = String(reply ?? "").replace(/\r\n?/g, "\n").trim().split(/\n\s*\n/);
  let first = 0;
  while (
    first < paragraphs.length - 1
    && OPENER.test(paragraphs[first])
    && OPENER_ENDING.test(paragraphs[first])
    && !paragraphs[first].includes("\n")
    && paragraphs[first].length <= OPENER_MAX_LENGTH
  ) first += 1;
  return { text: paragraphs.slice(first).join("\n\n"), removed: first > 0 };
}

function isBare(line) {
  const visible = line.replace(INVISIBLE, "");
  return visible.length > 0 && visible.length <= HEADING_MAX_LENGTH && !SENTENCE_MARKS.test(visible);
}

function countWord(text) {
  const match = String(text).match(COUNT_WORD);
  if (!match) return 0;
  return Number(match[1]) || CHINESE_DIGITS[match[1]] || 0;
}

// Blocks: { type: "heading" | "paragraph", text } or { type: "list", ordered, items }.
export function diandianBlocks(reply) {
  const lines = [];
  let blankBefore = true;
  for (const raw of String(reply ?? "").replace(/\r\n?/g, "\n").split("\n")) {
    const text = raw.trim();
    if (!text) { blankBefore = true; continue; }
    lines.push({ text, blankBefore });
    blankBefore = false;
  }
  const headingText = (index) => {
    const { text } = lines[index];
    const explicit = text.match(MARKDOWN_HEADING)?.[1] || text.match(BOLD_LINE)?.[1];
    if (explicit) return explicit.trim();
    const previousBare = index > 0 && !lines[index].blankBefore && isBare(lines[index - 1].text);
    const nextBare = index + 1 < lines.length && !lines[index + 1].blankBefore && isBare(lines[index + 1].text);
    return isBare(text) && index + 1 < lines.length && !previousBare && !nextBare ? text : "";
  };

  const blocks = [];
  let run = [];
  const flushRun = () => {
    if (!run.length) return;
    if (run.length === 1) blocks.push({ type: "paragraph", text: run[0] });
    else {
      const previous = blocks.at(-1);
      const counted = previous ? countWord(previous.text) : 0;
      blocks.push({
        type: "list",
        ordered: run.every((item) => NUMERIC_MARKER.test(item)) || counted === run.length,
        items: run.map((item) => item.replace(LIST_MARKER, "").trim() || item)
      });
    }
    run = [];
  };
  lines.forEach((line, index) => {
    const heading = headingText(index);
    if (heading) {
      flushRun();
      blocks.push({ type: "heading", text: heading });
      return;
    }
    if (line.blankBefore) flushRun();
    run.push(line.text);
  });
  flushRun();
  return blocks;
}
