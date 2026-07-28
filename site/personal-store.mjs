export const PERSONAL_STORE_KEY = "favsense-personal-v1";
export const LEGACY_BOOKMARK_KEY = "xhs-kb-saved";
export const PERSONAL_DATA_VERSION = 2;
export const MAX_DESCRIPTION_LENGTH = 4000;

export function emptyPersonalData() {
  return { version: PERSONAL_DATA_VERSION, bookmarks: [], bookmarkStates: {}, descriptionOverrides: {} };
}

function knownIdSet(validNoteIds) {
  return validNoteIds instanceof Set ? validNoteIds : new Set(validNoteIds || []);
}

function normalizeDescription(value) {
  return typeof value === "string" ? value.trim().slice(0, MAX_DESCRIPTION_LENGTH) : "";
}

function normalizeTimestamp(value) {
  const timestamp = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : "";
}

function newestRecord(left, right) {
  if (!left) return right;
  if (!right) return left;
  const leftTime = Date.parse(left.updatedAt || 0) || 0;
  const rightTime = Date.parse(right.updatedAt || 0) || 0;
  return rightTime >= leftTime ? right : left;
}

export function normalizePersonalData(value, validNoteIds = []) {
  const knownIds = knownIdSet(validNoteIds);
  const input = value && typeof value === "object" ? value : {};
  const bookmarkStates = {};
  const descriptionOverrides = {};

  if (input.bookmarkStates && typeof input.bookmarkStates === "object" && !Array.isArray(input.bookmarkStates)) {
    for (const [id, entry] of Object.entries(input.bookmarkStates)) {
      if (!knownIds.has(id) || !entry || typeof entry !== "object") continue;
      bookmarkStates[id] = {
        bookmarked: entry.bookmarked === true,
        updatedAt: normalizeTimestamp(entry.updatedAt)
      };
    }
  }

  const legacyTimestamp = normalizeTimestamp(input.updatedAt || input.exportedAt);
  for (const id of [...new Set(Array.isArray(input.bookmarks) ? input.bookmarks : [])]) {
    if (typeof id !== "string" || !knownIds.has(id) || bookmarkStates[id]) continue;
    bookmarkStates[id] = { bookmarked: true, updatedAt: legacyTimestamp };
  }

  if (input.descriptionOverrides && typeof input.descriptionOverrides === "object" && !Array.isArray(input.descriptionOverrides)) {
    for (const [id, entry] of Object.entries(input.descriptionOverrides)) {
      if (!knownIds.has(id)) continue;
      const description = normalizeDescription(typeof entry === "string" ? entry : entry?.description);
      const deleted = entry?.deleted === true;
      if (!description && !deleted) continue;
      descriptionOverrides[id] = {
        description,
        deleted,
        updatedAt: normalizeTimestamp(entry?.updatedAt)
      };
    }
  }

  const bookmarks = Object.entries(bookmarkStates)
    .filter(([, entry]) => entry.bookmarked)
    .map(([id]) => id);
  return { version: PERSONAL_DATA_VERSION, bookmarks, bookmarkStates, descriptionOverrides };
}

export function loadPersonalData(storage, validNoteIds = []) {
  const knownIds = knownIdSet(validNoteIds);
  try {
    const current = storage.getItem(PERSONAL_STORE_KEY);
    if (current) return normalizePersonalData(JSON.parse(current), knownIds);

    const legacy = storage.getItem(LEGACY_BOOKMARK_KEY);
    if (!legacy) return emptyPersonalData();
    const migrated = normalizePersonalData({ bookmarks: JSON.parse(legacy) }, knownIds);
    storage.setItem(PERSONAL_STORE_KEY, JSON.stringify(migrated));
    storage.removeItem(LEGACY_BOOKMARK_KEY);
    return migrated;
  } catch {
    return emptyPersonalData();
  }
}

export function savePersonalData(storage, data, validNoteIds = []) {
  const normalized = normalizePersonalData(data, validNoteIds);
  storage.setItem(PERSONAL_STORE_KEY, JSON.stringify(normalized));
  return normalized;
}

export function mergePersonalData(current, incoming, validNoteIds = []) {
  const left = normalizePersonalData(current, validNoteIds);
  const right = normalizePersonalData(incoming, validNoteIds);
  const bookmarkStates = {};
  const descriptionOverrides = {};

  for (const id of new Set([...Object.keys(left.bookmarkStates), ...Object.keys(right.bookmarkStates)])) {
    bookmarkStates[id] = newestRecord(left.bookmarkStates[id], right.bookmarkStates[id]);
  }
  for (const id of new Set([...Object.keys(left.descriptionOverrides), ...Object.keys(right.descriptionOverrides)])) {
    descriptionOverrides[id] = newestRecord(left.descriptionOverrides[id], right.descriptionOverrides[id]);
  }

  return normalizePersonalData({
    bookmarkStates,
    descriptionOverrides
  }, validNoteIds);
}

export function serializePersonalData(data, validNoteIds = []) {
  return JSON.stringify({
    ...normalizePersonalData(data, validNoteIds),
    exportedAt: new Date().toISOString()
  }, null, 2);
}

export function relatedResourceNames(notes, bookmarks) {
  const bookmarked = bookmarks instanceof Set ? bookmarks : new Set(bookmarks || []);
  return new Set((notes || [])
    .filter((note) => bookmarked.has(note.id))
    .flatMap((note) => Array.isArray(note.resources) ? note.resources : [])
    .filter((name) => typeof name === "string" && name));
}
