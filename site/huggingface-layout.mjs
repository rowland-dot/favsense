const CREATOR_USER_ID = /^[a-f0-9]{24}$/;

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
