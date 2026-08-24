import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { normalizeSensitiveText } from "./sensitive-data.mjs";

const SECRET_NAMES = new Set([".env", "credentials.json", "secrets.json", "id_rsa"]);
const SECRET_SUFFIXES = [".pem", ".p12", ".pfx", ".key"];
const RAW_EVIDENCE_SUFFIXES = new Set([
  ".mp4", ".mov", ".webm", ".mkv", ".avi", ".m4v",
  ".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac", ".opus",
  ".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".tif", ".tiff", ".avif"
]);
const TEXT_SUFFIXES = new Set([
  ".html", ".htm", ".css", ".js", ".mjs", ".json", ".md", ".txt",
  ".xml", ".svg", ".yml", ".yaml", ".map", ".webmanifest"
]);
const PUBLIC_FORBIDDEN = [
  /xsec[\s_-]*token\s*[:=]/i,
  /\b(?:access_token|refresh_token|authorization|password|secret)\s*[:=]\s*["']?[^\s"']{8,}/i,
  /\b(?:cookie|cookies|set-cookie)\s*[:=]\s*["']?[^\s"']{8,}/i,
  /\bBearer\s+[A-Za-z0-9._~+/-]{8,}/i,
  /xiaohongshu\.com\/(?:user\/profile|board|explore|discovery\/item)\//i,
  /(?:^|["'\s])\/(?:user\/profile|board|explore|discovery\/item)\/[A-Za-z0-9_-]{6,}/i,
  /ChromeUserData|AppData\\Local/i
];
const STRUCTURED_CREDENTIAL_KEY = /^(?:api_key|client_secret|cookie|cookies|xsec_token|token|access_token|refresh_token|authorization|password|secret)$/i;
const MIGRATION_ARTIFACT = /^(?:migration-reports|migration-backups|organization-migration|rollback-manifest(?:\.json)?|dry-run-report\.json|migration-v2\.json|.*\.backup|\.organization-tx-)/i;

function containsStructuredCredentialKey(value) {
  if (Array.isArray(value)) return value.some(containsStructuredCredentialKey);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, child]) => (
    STRUCTURED_CREDENTIAL_KEY.test(normalizeSensitiveText(key))
      || containsStructuredCredentialKey(child)
  ));
}

function secretLikeName(name) {
  const lower = name.toLowerCase();
  return SECRET_NAMES.has(lower)
    || lower.startsWith(".env.")
    || SECRET_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

export function assertPublicTextSafe(content, label, privateIdentifiers = []) {
  const normalized = normalizeSensitiveText(content);
  for (const pattern of PUBLIC_FORBIDDEN) {
    if (pattern.test(normalized)) throw new Error(`sensitive public content is not allowed: ${label}`);
  }
  for (const identifier of privateIdentifiers) {
    const privateValue = normalizeSensitiveText(String(identifier || "").trim());
    if (privateValue && normalized.includes(privateValue)) {
      throw new Error(`private source identifier is not allowed: ${label}`);
    }
  }
  if ([".json", ".webmanifest"].includes(path.extname(label).toLowerCase())) {
    try {
      if (containsStructuredCredentialKey(JSON.parse(content))) {
        throw new Error(`sensitive public content is not allowed: ${label}`);
      }
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error(`public structured document must contain valid JSON: ${label}`, { cause: error });
      }
      throw error;
    }
  }
}

export async function atomicWriteTextFile(target, content) {
  const destination = path.resolve(target);
  const directory = path.dirname(destination);
  const temporary = path.join(
    directory,
    `.${path.basename(destination)}.${process.pid}.${randomUUID()}.tmp`
  );
  await mkdir(directory, { recursive: true });
  try {
    await writeFile(temporary, content, { encoding: "utf8", flag: "wx" });
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function validatePublicTree(directory, options = {}, relative = "") {
  const root = path.resolve(directory);
  const privateIdentifiers = Array.isArray(options.privateIdentifiers) ? options.privateIdentifiers : [];
  const excludedRootNames = new Set(
    (Array.isArray(options.excludedRootNames) ? options.excludedRootNames : [".local"])
      .map((name) => String(name).toLowerCase())
  );
  const allowedRootTextNames = new Set(
    Array.isArray(options.allowedRootTextNames) ? options.allowedRootTextNames : []
  );
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (/[^\x20-\x7e]/.test(entry.name)) {
      throw new Error(`public tree paths must use printable ASCII: ${path.join(relative, entry.name)}`);
    }
    if (!relative && excludedRootNames.has(entry.name.toLowerCase())) continue;
    if (MIGRATION_ARTIFACT.test(entry.name)) {
      throw new Error(`migration artifact is not allowed in the public site: ${path.join(relative, entry.name)}`);
    }
    const entryPath = path.join(root, entry.name);
    const entryRelative = path.join(relative, entry.name);
    const metadata = await lstat(entryPath);
    if (metadata.isSymbolicLink()) throw new Error(`public site must not contain symbolic links: ${entryRelative}`);
    if (entry.isDirectory()) {
      await validatePublicTree(entryPath, {
        privateIdentifiers,
        excludedRootNames: [...excludedRootNames],
        allowedRootTextNames: [...allowedRootTextNames],
      }, entryRelative);
      continue;
    }
    if (!entry.isFile()) throw new Error(`unsupported public tree entry: ${entryRelative}`);
    if (secretLikeName(entry.name)) throw new Error(`secret-like public file is not allowed: ${entryRelative}`);
    const suffix = path.extname(entry.name).toLowerCase();
    if (RAW_EVIDENCE_SUFFIXES.has(suffix)) {
      throw new Error(`raw evidence file is not allowed in the public site: ${entryRelative}`);
    }
    if (!TEXT_SUFFIXES.has(suffix) && !(relative === "" && allowedRootTextNames.has(entry.name))) {
      throw new Error(`unsupported public file type: ${entryRelative}`);
    }
    if (metadata.size > 16 * 1024 * 1024) throw new Error(`public text file is too large to validate: ${entryRelative}`);
    assertPublicTextSafe(await readFile(entryPath, "utf8"), entryRelative, privateIdentifiers);
  }
}
