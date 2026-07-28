import {
  checkRepoAccess,
  createRepo,
  datasetInfo,
  downloadFile,
  oauthHandleRedirectIfPresent,
  oauthLoginUrl,
  uploadFile
} from "https://cdn.jsdelivr.net/npm/@huggingface/hub@2.14.2/+esm";
import { emptyPersonalData, mergePersonalData } from "./personal-store.mjs";
import { assertPrivateDataset, repositoryIsMissing, repositoryWriteConflict } from "./hf-sync-guard.mjs";

const OAUTH_STORAGE_KEY = "favsense-hf-oauth-v1";
const DATA_FILE = "personal.json";

function readStoredOAuth() {
  try {
    const result = JSON.parse(localStorage.getItem(OAUTH_STORAGE_KEY) || "null");
    const expiresAt = new Date(result?.accessTokenExpiresAt || 0).getTime();
    if (!result?.accessToken || !result?.userInfo || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      localStorage.removeItem(OAUTH_STORAGE_KEY);
      return null;
    }
    return result;
  } catch {
    localStorage.removeItem(OAUTH_STORAGE_KEY);
    return null;
  }
}

function oauthAvailable() {
  return Boolean(window.huggingface?.variables?.OAUTH_CLIENT_ID);
}

function usernameFrom(result) {
  return result?.userInfo?.preferredUsername || result?.userInfo?.preferred_username || result?.userInfo?.name || "";
}

function repositoryFor(result) {
  const username = usernameFrom(result);
  const clientId = String(window.huggingface?.variables?.OAUTH_CLIENT_ID || "favsense")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 8);
  return { type: "dataset", name: `${username}/favsense-personal-${clientId || "data"}` };
}

async function ensurePrivateRepository(result) {
  const repo = repositoryFor(result);
  let info;
  try {
    info = await datasetInfo({ name: repo.name, accessToken: result.accessToken, additionalFields: ["sha"] });
  } catch (error) {
    if (!repositoryIsMissing(error)) throw error;
    await createRepo({
      repo,
      accessToken: result.accessToken,
      private: true,
      files: [{
        path: DATA_FILE,
        content: new Blob([JSON.stringify(emptyPersonalData(), null, 2)], { type: "application/json" })
      }]
    });
    info = await datasetInfo({ name: repo.name, accessToken: result.accessToken, additionalFields: ["sha"] });
  }
  assertPrivateDataset(info);
  await checkRepoAccess({ repo, accessToken: result.accessToken });
  return { repo, info };
}

function personalNoteIds(...items) {
  return new Set(items.flatMap((item) => [
    ...(Array.isArray(item?.bookmarks) ? item.bookmarks : []),
    ...Object.keys(item?.bookmarkStates || {}),
    ...Object.keys(item?.descriptionOverrides || {})
  ]));
}

async function downloadPersonalData(repo, oauth, revision) {
  const response = await downloadFile({
    repo,
    path: DATA_FILE,
    revision,
    accessToken: oauth.accessToken
  });
  return response ? JSON.parse(await response.text()) : null;
}

export async function initializeHfPersonalSync() {
  if (!oauthAvailable()) return { available: false, authenticated: false };
  let oauth = readStoredOAuth();
  if (!oauth) {
    oauth = await oauthHandleRedirectIfPresent();
    if (oauth) localStorage.setItem(OAUTH_STORAGE_KEY, JSON.stringify(oauth));
  }
  const scopes = window.huggingface?.variables?.OAUTH_SCOPES || "openid profile contribute-repos";
  return {
    available: true,
    authenticated: Boolean(oauth),
    username: usernameFrom(oauth),
    loginUrl: oauth ? "" : `${await oauthLoginUrl({ scopes })}&prompt=consent`,
    repository: oauth ? repositoryFor(oauth).name : "",
    oauth
  };
}

export async function loadHfPersonalData(session) {
  if (!session?.oauth) throw new Error("Hugging Face login is required");
  const { repo, info } = await ensurePrivateRepository(session.oauth);
  try {
    return await downloadPersonalData(repo, session.oauth, info.sha);
  } catch (error) {
    if (/404|not found|entry not found/i.test(String(error?.message || error))) return null;
    throw error;
  }
}

export async function saveHfPersonalData(session, data) {
  if (!session?.oauth) throw new Error("Hugging Face login is required");
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const { repo, info } = await ensurePrivateRepository(session.oauth);
    const remote = await downloadPersonalData(repo, session.oauth, info.sha);
    const merged = mergePersonalData(remote || {}, data, personalNoteIds(remote, data));
    try {
      await uploadFile({
        repo,
        accessToken: session.oauth.accessToken,
        parentCommit: info.sha,
        file: {
          path: DATA_FILE,
          content: new Blob([JSON.stringify(merged, null, 2)], { type: "application/json" })
        },
        commitTitle: "Update FavSense personal curation"
      });
      return merged;
    } catch (error) {
      if (attempt === 2 || !repositoryWriteConflict(error)) throw error;
    }
  }
  throw new Error("FavSense personal sync conflict retry limit reached");
}

export function signOutHfPersonalSync() {
  localStorage.removeItem(OAUTH_STORAGE_KEY);
}
