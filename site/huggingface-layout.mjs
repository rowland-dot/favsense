const CREATOR_USER_ID = /^[a-f0-9]{24}$/;
const HOST_HEADER_RESIZE_THRESHOLD = 32;

export function hasHuggingFaceMiniHeader({ framed, referrer, creatorUserId, configuredHeader }) {
  if (
    !framed
    || !CREATOR_USER_ID.test(String(creatorUserId || ""))
    || String(configuredHeader || "").toLowerCase() !== "mini"
  ) return false;

  try {
    const parentUrl = new URL(referrer);
    return parentUrl.origin === "https://huggingface.co";
  } catch {
    return false;
  }
}

export function resolveHuggingFaceHeaderLayout({ capable, outerHeight, innerHeight, baselineGap }) {
  if (!capable) return { mode: "default", baselineGap: null };

  const currentGap = Math.max(0, Number(outerHeight) - Number(innerHeight));
  const nextBaseline = baselineGap == null
    ? currentGap
    : Math.min(baselineGap, currentGap);
  const hostHeaderExpanded = currentGap - nextBaseline >= HOST_HEADER_RESIZE_THRESHOLD;

  return {
    mode: hostHeaderExpanded ? "default" : "mini",
    baselineGap: nextBaseline,
  };
}
