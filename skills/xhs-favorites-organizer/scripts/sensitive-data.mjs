const CREDENTIAL_KEY = /^(?:cookie|cookies|xsec_token|token|access_token|refresh_token|authorization|password|secret)$/i;
const CREDENTIAL_VALUE = /(?:xsec[\s_-]*token["']?\s*[:=]|\b(?:access_token|refresh_token|authorization|cookie|password|secret)\s*[:=]|\bBearer\s+[A-Za-z0-9._~+/-]{8,}|(?:(?:https?:)?\/\/)?(?:www\.)?xiaohongshu\.com\/)/i;

const NAMED_ENTITIES = new Map([
  ["amp", "&"], ["apos", "'"], ["colon", ":"], ["comma", ","],
  ["equals", "="], ["lowbar", "_"], ["num", "#"], ["period", "."],
  ["percnt", "%"], ["quest", "?"], ["quot", '"'], ["semi", ";"], ["sol", "/"]
]);

function decodeEntities(value) {
  return value.replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi, (match, decimal, hex, named) => {
    if (decimal) return String.fromCodePoint(Number.parseInt(decimal, 10));
    if (hex) return String.fromCodePoint(Number.parseInt(hex, 16));
    return NAMED_ENTITIES.get(String(named || "").toLowerCase()) || match;
  });
}

function decodePercent(value) {
  return value.replace(/(?:%[0-9a-f]{2})+/gi, (part) => {
    try { return decodeURIComponent(part); } catch { return part; }
  });
}

function decodeUnicodeEscapes(value) {
  const paired = value.replace(/\\u(d[89ab][0-9a-f]{2})\\u(d[cdef][0-9a-f]{2})/gi, (_match, high, low) => (
    String.fromCodePoint(0x10000 + ((Number.parseInt(high, 16) - 0xD800) << 10) + (Number.parseInt(low, 16) - 0xDC00))
  ));
  return paired.replace(/\\u\{([0-9a-f]{1,6})\}|\\u([0-9a-f]{4})|\\x([0-9a-f]{2})/gi, (match, braced, short, byte) => {
    const codePoint = Number.parseInt(braced || short || byte, 16);
    if (codePoint > 0x10FFFF || (codePoint >= 0xD800 && codePoint <= 0xDFFF)) return match;
    return String.fromCodePoint(codePoint);
  });
}

export function normalizeSensitiveText(value) {
  let normalized = String(value || "");
  for (let index = 0; index < 8; index += 1) {
    const next = decodePercent(decodeEntities(decodeUnicodeEscapes(normalized)))
      .normalize("NFKC")
      .replace(/\p{Cf}/gu, "");
    if (next === normalized) break;
    normalized = next;
  }
  return normalized;
}

export function containsCredentialShape(value) {
  if (typeof value === "string") return CREDENTIAL_VALUE.test(normalizeSensitiveText(value));
  if (Array.isArray(value)) return value.some(containsCredentialShape);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, child]) => (
    CREDENTIAL_KEY.test(normalizeSensitiveText(key)) || containsCredentialShape(child)
  ));
}
