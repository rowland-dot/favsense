#!/usr/bin/env node

import { readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const root = resolve(dirname(scriptPath), "..");
const governedPrefixes = ["skills/", "scripts/", "site/", "config/", ".github/workflows/"];
const labels = {
  spec: ["Spec"], plan: ["Plan"], test: ["RED/GREEN evidence", "TDD"], review: ["Review"],
  qa: ["QA"], audit: ["Audit"], brief: ["Review brief", "Brief"],
};
const failureIds = {
  plan: "LIFECYCLE_PLAN_MISSING", test: "LIFECYCLE_TEST_MISSING", review: "LIFECYCLE_REVIEW_MISSING",
  qa: "LIFECYCLE_QA_MISSING", audit: "LIFECYCLE_AUDIT_MISSING", brief: "LIFECYCLE_BRIEF_MISSING",
};

function normalizeChanged(event) {
  const raw = event?.pull_request?.changed_files;
  return Array.isArray(raw) ? raw.map((value) => String(value).replaceAll("\\", "/")) : [];
}

function extract(body, names) {
  for (const name of names) {
    const match = String(body || "").match(new RegExp(`^\\s*${name.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}\\s*:\\s*(\\S+)`, "im"));
    if (match) return match[1].replace(/^`|`$/g, "");
  }
  return "";
}

async function validateEvidencePath(workspace, value) {
  if (!value || /^https?:\/\//i.test(value) || isAbsolute(value)) return false;
  const target = resolve(workspace, value);
  const rel = relative(workspace, target).replaceAll("\\", "/");
  if (!rel || rel.startsWith("../") || rel === "..") return false;
  try { return (await stat(target)).isFile(); } catch { return false; }
}

export async function verifyDevelopmentLifecycle({ root: workspace, event }) {
  const changed = normalizeChanged(event);
  const governed = changed.some((file) => governedPrefixes.some((prefix) => file.startsWith(prefix)));
  if (!governed) return { ok: true, governed: false, failures: [] };
  const body = String(event?.pull_request?.body || "");
  const values = Object.fromEntries(Object.entries(labels).map(([key, names]) => [key, extract(body, names)]));
  const failures = [];
  if (!values.spec || !(await validateEvidencePath(workspace, values.spec))) {
    failures.push({ id: "LIFECYCLE_SPEC_MISSING" });
  } else {
    const spec = await readFile(resolve(workspace, values.spec), "utf8");
    if (!/\bAPPROVED\b/i.test(spec) || /\bDRAFT\b/i.test(spec)) failures.push({ id: "LIFECYCLE_SPEC_NOT_APPROVED" });
  }
  for (const key of ["plan", "test", "review", "qa", "audit", "brief"]) {
    if (!values[key]) failures.push({ id: failureIds[key] });
    else if (!(await validateEvidencePath(workspace, values[key]))) failures.push({ id: `LIFECYCLE_${key.toUpperCase()}_INVALID` });
  }
  if (values.plan && await validateEvidencePath(workspace, values.plan) && values.spec) {
    const plan = await readFile(resolve(workspace, values.plan), "utf8");
    if (!plan.includes(values.spec)) failures.push({ id: "LIFECYCLE_PLAN_SPEC_MISMATCH" });
  }
  if (values.brief && await validateEvidencePath(workspace, values.brief)) {
    const brief = await readFile(resolve(workspace, values.brief), "utf8");
    if (!/RED\/GREEN evidence\s*:\s*\S+/i.test(brief)) failures.push({ id: "LIFECYCLE_BRIEF_TDD_MISSING" });
  }
  if (!/^\s*Rollback\s*:\s*\S+/im.test(body)) failures.push({ id: "LIFECYCLE_ROLLBACK_MISSING" });
  else if (!/-\s*\[x\]\s*Rollback reviewed/i.test(body)) failures.push({ id: "LIFECYCLE_ROLLBACK_UNCHECKED" });
  return { ok: failures.length === 0, governed: true, failures };
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  try {
    const eventPath = process.env.GITHUB_EVENT_PATH;
    if (!eventPath) throw new Error("LIFECYCLE_EVENT_MISSING: GITHUB_EVENT_PATH is required");
    const event = JSON.parse(await readFile(eventPath, "utf8"));
    const result = await verifyDevelopmentLifecycle({ root, event });
    if (!result.ok) {
      for (const item of result.failures) console.error(item.id);
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(String(error.message || error));
    process.exitCode = 1;
  }
}

