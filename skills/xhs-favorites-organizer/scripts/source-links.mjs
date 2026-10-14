import { readFileSync } from "node:fs";

// The one place that knows what a signed post link is: how a card's link is made from a stored code, which
// link a safety check may let through, which stored code is still usable, and how the store is read.
// The store itself (.xhs-favorites/source-codes.json) is private and is written by the sync service only.

const NOTE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const CODE = /^[A-Za-z0-9_\-=+/.]{1,2048}$/;
const SOURCE = /^[A-Za-z0-9_]{1,40}$/;
const DAY_MS = 86_400_000;
const MAX_AGE_KEY = "source_link.code_max_age_days";

function configError(code, message) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  return error;
}

export function signedPostLink(noteId, code, source) {
  const params = new URLSearchParams({ xsec_token: code, xsec_source: source });
  return `https://www.xiaohongshu.com/explore/${noteId}?${params.toString()}`;
}

// True only for exactly the link signedPostLink makes for this note: the note's own ID, one code, one source,
// nothing else. A link for another note, with extra parameters or in any other shape is not it.
export function isSignedPostLinkOf(value, noteId) {
  if (typeof value !== "string" || typeof noteId !== "string" || !NOTE_ID.test(noteId)) return false;
  let url;
  try { url = new URL(value); } catch { return false; }
  const code = url.searchParams.get("xsec_token");
  const source = url.searchParams.get("xsec_source");
  return CODE.test(code ?? "") && SOURCE.test(source ?? "") && value === signedPostLink(noteId, code, source);
}

// The public data with each card's own signed link taken out of its source link, which is the one place a signed
// link may sit. What is left is what the safety checks read: a code anywhere else still shows.
export function withoutOwnSignedLinks(data) {
  if (!data || typeof data !== "object" || !Array.isArray(data.notes)) return data;
  return {
    ...data,
    notes: data.notes.map((note) => (
      note && typeof note === "object" && isSignedPostLinkOf(note.sourceUrl, note.id) ? { ...note, sourceUrl: "" } : note
    )),
  };
}

// note id -> { code, source, capturedAt, batch }. A missing file means no note has a code; a malformed one is
// refused, and the message never carries what the file held.
export function loadSourceCodes(path) {
  let source;
  try { source = readFileSync(path, "utf8"); } catch (error) {
    if (error?.code === "ENOENT") return new Map();
    throw error;
  }
  const malformed = () => configError("SOURCE_CODE_STORE_MALFORMED", `the private source code store is malformed: ${path}`);
  let store;
  try { store = JSON.parse(source.charCodeAt(0) === 0xFEFF ? source.slice(1) : source); } catch { throw malformed(); }
  if (store?.schema_version !== 1 || !store.notes || typeof store.notes !== "object" || Array.isArray(store.notes)) throw malformed();
  const codes = new Map();
  for (const [noteId, item] of Object.entries(store.notes)) {
    if (
      !NOTE_ID.test(noteId) || !item || typeof item !== "object"
      || !CODE.test(item.code ?? "") || !SOURCE.test(item.source ?? "")
      || typeof item.batch !== "string" || !item.batch
      || typeof item.captured_at !== "string" || Number.isNaN(Date.parse(item.captured_at))
    ) throw malformed();
    codes.set(noteId, { code: item.code, source: item.source, capturedAt: item.captured_at, batch: item.batch });
  }
  return codes;
}

// The one place that turns a domain profile into "how many days a stored code stays usable". Absent means
// no age limit yet (nobody has measured how long a code lives); a present value that is not a non-negative
// whole number is a configuration mistake and is reported, never read as "every code is too old".
export function sourceCodeMaxAgeDays(profile) {
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
    throw configError("SOURCE_CODE_PROFILE_REQUIRED", "a domain profile is required to decide how long a source code stays usable");
  }
  const section = profile.source_link;
  if (section === undefined) return undefined;
  if (!section || typeof section !== "object" || Array.isArray(section)) {
    throw configError("SOURCE_CODE_MAX_AGE_INVALID", `${MAX_AGE_KEY} must be a non-negative whole number`);
  }
  const value = section.code_max_age_days;
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw configError("SOURCE_CODE_MAX_AGE_INVALID", `${MAX_AGE_KEY} must be a non-negative whole number`);
  }
  return value;
}

// The stored code to build a card's post link from, or null when the card keeps its search link: no code
// stored, or a code the age setting says is too old. `today` is the build's effective date.
export function usableSourceCode(codes, noteId, { today, maxAgeDays }) {
  const stored = codes.get(noteId);
  if (!stored) return null;
  if (maxAgeDays === undefined) return stored;
  const capturedDay = Math.floor(Date.parse(stored.capturedAt) / DAY_MS);
  const currentDay = Math.floor(Date.parse(`${today}T00:00:00.000Z`) / DAY_MS);
  return capturedDay <= currentDay && currentDay - capturedDay < maxAgeDays ? stored : null;
}
