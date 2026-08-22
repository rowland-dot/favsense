export function validateLocalBridgeConfig(value) {
  if (!value || typeof value !== "object") throw new Error("本机同步配置不可用");

  let url;
  try {
    url = new URL(value.baseUrl);
  } catch {
    throw new Error("本机同步地址不可用");
  }
  if (
    url.protocol !== "http:"
    || url.hostname !== "127.0.0.1"
    || !url.port
    || url.username
    || url.password
    || url.pathname !== "/"
    || url.search
    || url.hash
  ) throw new Error("本机同步地址必须使用受限的 127.0.0.1 端点");

  return { baseUrl: url.origin, token: "" };
}

export function validateLocalBridgeSession(value) {
  if (!value || value.ok !== true || value.protocol_version !== 11) throw new Error("本机同步服务版本不匹配");
  if (typeof value.token !== "string" || !/^[a-f0-9]{64}$/.test(value.token)) throw new Error("本机同步凭据不可用");
  const browserSession = value.browser_session;
  if (
    !browserSession
    || typeof browserSession !== "object"
    || Array.isArray(browserSession)
    || Object.keys(browserSession).sort().join(",") !== "owner,ready"
    || browserSession.owner !== "sop-cdp"
    || typeof browserSession.ready !== "boolean"
  ) throw new Error("SOP 扫描浏览器会话不可用");
  return {
    token: value.token,
    browserSession: { owner: "sop-cdp", ready: browserSession.ready }
  };
}

export function validateLocalBridgeBoards(value) {
  if (!Array.isArray(value) || value.length > 200) throw new Error("本机收藏夹数据不可用");
  const seen = new Set();
  return value.map((board) => {
    const keys = board && typeof board === "object" && !Array.isArray(board)
      ? Object.keys(board).sort().join(",")
      : "";
    if (keys !== "advertised_count,available,captured_count,enabled,id,name") {
      throw new Error("本机收藏夹数据不可用");
    }
    if (
      typeof board.id !== "string"
      || !/^[a-z0-9]{1,80}$/.test(board.id)
      || seen.has(board.id)
      || typeof board.name !== "string"
      || !board.name.trim()
      || board.name.length > 200
      || typeof board.enabled !== "boolean"
      || typeof board.available !== "boolean"
      || !Number.isSafeInteger(board.advertised_count)
      || board.advertised_count < 0
      || board.advertised_count > 10_000_000
      || !Number.isSafeInteger(board.captured_count)
      || board.captured_count < 0
      || board.captured_count > 10_000_000
    ) throw new Error("本机收藏夹数据不可用");
    seen.add(board.id);
    return { ...board, name: board.name.trim() };
  });
}

const SYNC_STATES = new Set(["idle", "starting", "running", "completed", "failed", "safety-stopped"]);
const SYNC_NUMBERS = new Set([
  "board_count", "processed_boards", "scanned", "new", "summarized",
  "summary_total", "summary_pending", "summary_failed"
]);
const SYNC_BOOLEANS = new Set([
  "summary_plan_pending", "summary_finalizing", "core_completed"
]);
const SYNC_SHORT_TEXT = new Set([
  "started_at", "completed_at", "current_board", "publish_status", "summary_halt_reason"
]);
const SYNC_ALLOWED_KEYS = new Set([
  "ok", "state", ...SYNC_NUMBERS, ...SYNC_BOOLEANS, ...SYNC_SHORT_TEXT,
  "error", "summary_finalize_error"
]);

export function normalizeLocalBridgeDiagnostic(value) {
  if (typeof value !== "string" || value.length > 1500) return "";
  let normalized = value;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const previous = normalized;
    normalized = normalized
      .replace(/&(?:nbsp|ensp|emsp|thinsp);/gi, " ")
      .replace(/&#(?:x([0-9a-f]{1,6})|(\d{1,7}));?/gi, (source, hex, decimal) => {
        const codePoint = Number.parseInt(hex || decimal, hex ? 16 : 10);
        return Number.isSafeInteger(codePoint) && codePoint <= 0x10ffff
          && !(codePoint >= 0xd800 && codePoint <= 0xdfff)
          ? String.fromCodePoint(codePoint)
          : source;
      });
    try { normalized = decodeURIComponent(normalized); } catch { /* Keep malformed percent text visible. */ }
    normalized = normalized.replace(/[\p{Cf}\p{Cc}]+/gu, " ");
    if (normalized === previous) break;
  }
  const visible = normalized.replace(/\s+/gu, " ").trim();
  return /^No diagnostic output was returned\.?$/i.test(visible) ? "" : visible;
}

function organizationContract(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.schema_version !== 2) {
    throw new Error("本机整理状态契约不可用");
  }
  for (const key of ["overall_states", "phase_statuses", "note_statuses", "reason_codes", "copy"]) {
    if (!value[key] || typeof value[key] !== "object") throw new Error("本机整理状态契约不可用");
  }
  return value;
}

export function validateOrganizationStatusContract(value) {
  return organizationContract(value);
}

const LOCAL_EVIDENCE_METHODS = new Set(["point", "ocr", "transcription", "description", "comments"]);
const SENSITIVE_LOCAL_TEXT = /(?:cookie|xsec[_-]?token|authorization|bearer|bridge[_-]?token)\s*[:=]/iu;

export function validateLocalNoteOrganizationStatus(value, sourceContract) {
  const contract = organizationContract(sourceContract);
  const keys = Object.keys(value || {}).sort().join(",");
  if (keys !== "blockers,display_summary,evidence_methods,note_id,ok,reason_code,schema_version,status") {
    throw new Error("本机单篇整理状态不可用");
  }
  if (
    value.ok !== true
    || value.schema_version !== 2
    || value.status !== "pending_review"
    || !contract.note_statuses.curation.includes(value.status)
    || !contract.reason_codes.includes(value.reason_code)
    || typeof value.note_id !== "string"
    || !/^[A-Za-z0-9_-]{1,128}$/.test(value.note_id)
    || typeof value.display_summary !== "string"
    || !value.display_summary.trim()
    || value.display_summary.length > 200_000
    || SENSITIVE_LOCAL_TEXT.test(value.display_summary)
    || !Array.isArray(value.blockers)
    || value.blockers.length > 20
    || !value.blockers.every((reason) => typeof reason === "string" && reason && contract.reason_codes.includes(reason))
    || !Array.isArray(value.evidence_methods)
    || value.evidence_methods.length < 1
    || value.evidence_methods.length > 20
  ) throw new Error("本机单篇整理状态不可用");
  const evidenceMethods = value.evidence_methods.map((evidence) => {
    if (
      !evidence
      || typeof evidence !== "object"
      || Array.isArray(evidence)
      || Object.keys(evidence).sort().join(",") !== "method,provider,result_sha256,version"
      || !LOCAL_EVIDENCE_METHODS.has(evidence.method)
      || typeof evidence.provider !== "string"
      || !/^[A-Za-z0-9._-]{1,80}$/.test(evidence.provider)
      || typeof evidence.version !== "string"
      || !/^[A-Za-z0-9._-]{1,40}$/.test(evidence.version)
      || typeof evidence.result_sha256 !== "string"
      || !/^[a-f0-9]{64}$/.test(evidence.result_sha256)
    ) throw new Error("本机单篇整理状态不可用");
    return { ...evidence };
  });
  return {
    ...value,
    display_summary: value.display_summary.trim(),
    evidence_methods: evidenceMethods,
    blockers: [...value.blockers]
  };
}

function validateV2SyncStatus(value, sourceContract) {
  const contract = organizationContract(sourceContract);
  const keys = Object.keys(value).sort().join(",");
  if (keys !== "build_version,counts,ok,phases,run_id,schema_version,state") throw new Error("本机整理状态不可用");
  if (value.ok !== true || value.schema_version !== 2 || !contract.overall_states.includes(value.state)) throw new Error("本机整理状态不可用");
  if (typeof value.run_id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value.run_id)) throw new Error("本机整理状态不可用");
  if (typeof value.build_version !== "string" || (value.build_version && !/^[a-f0-9]{64}$/.test(value.build_version))) throw new Error("本机整理状态不可用");
  if (!value.phases || Object.keys(value.phases).sort().join(",") !== "build,core,curation,evidence,publish,summary") throw new Error("本机整理状态不可用");
  const phases = {};
  for (const [name, statuses] of Object.entries(contract.phase_statuses)) {
    const phase = value.phases[name];
    if (!phase || typeof phase !== "object" || Array.isArray(phase)) throw new Error("本机整理状态不可用");
    const allowedKeys = new Set(["status", "reason_code", "updated_at", ...(name === "build" || name === "publish" ? ["artifact_status"] : [])]);
    if (Object.keys(phase).some((key) => !allowedKeys.has(key)) || !statuses.includes(phase.status)) throw new Error("本机整理状态不可用");
    if (!contract.reason_codes.includes(phase.reason_code) || typeof phase.updated_at !== "string" || Number.isNaN(Date.parse(phase.updated_at))) throw new Error("本机整理状态不可用");
    if ("artifact_status" in phase && phase.artifact_status !== "held_previous") throw new Error("本机整理状态不可用");
    phases[name] = { ...phase };
  }
  const countKeys = ["scanned", "new", "summary_captured", "summary_failed", "summary_batch_aborted", "curation_accepted", "curation_pending"];
  if (!value.counts || Object.keys(value.counts).sort().join(",") !== [...countKeys].sort().join(",")) throw new Error("本机整理状态不可用");
  for (const key of countKeys) if (!Number.isSafeInteger(value.counts[key]) || value.counts[key] < 0 || value.counts[key] > 10_000_000) throw new Error("本机整理状态不可用");
  return { ...value, phases, counts: { ...value.counts } };
}

export function validateLocalBridgeSyncStatus(value, contract = null) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.ok !== true) {
    throw new Error("本机整理状态不可用");
  }
  if (contract) {
    if (value.schema_version === 2) return validateV2SyncStatus(value, contract);
    if (value.state === "completed") {
      return { ok: true, schema_version: 2, state: "completed_with_warnings", reason_code: "unknown_legacy", legacy: true };
    }
    const legacy = validateLocalBridgeSyncStatus(value);
    return { ...legacy, schema_version: 2, state: "completed_with_warnings", reason_code: "unknown_legacy", legacy: true };
  }
  if (Object.keys(value).some((key) => !SYNC_ALLOWED_KEYS.has(key)) || !SYNC_STATES.has(value.state)) {
    throw new Error("本机整理状态不可用");
  }
  for (const key of SYNC_NUMBERS) {
    if (key in value && (!Number.isSafeInteger(value[key]) || value[key] < 0 || value[key] > 10_000_000)) {
      throw new Error("本机整理状态不可用");
    }
  }
  for (const key of SYNC_BOOLEANS) {
    if (key in value && typeof value[key] !== "boolean") throw new Error("本机整理状态不可用");
  }
  for (const key of SYNC_SHORT_TEXT) {
    if (key in value && (typeof value[key] !== "string" || value[key].length > 500)) {
      throw new Error("本机整理状态不可用");
    }
  }

  const status = { ...value };
  for (const key of ["error", "summary_finalize_error"]) {
    if (!(key in status)) continue;
    if (typeof status[key] !== "string" || status[key].length > 1500) {
      throw new Error("本机整理状态不可用");
    }
    const visible = normalizeLocalBridgeDiagnostic(status[key]);
    if (visible) status[key] = visible;
    else delete status[key];
  }
  return status;
}
