import { resourceGroup, resourceSortsForGroup, sortResources, validateResourceIndex } from "./resource-utils.mjs";
import {
  validateLocalBridgeBoards,
  validateLocalBridgeConfig,
  validateLocalNoteOrganizationStatus,
  validateLocalBridgeSession,
  validateLocalBridgeSyncStatus,
  validateOrganizationStatusContract,
  normalizeLocalBridgeDiagnostic
} from "./local-bridge-utils.mjs";
import { hasHuggingFaceMiniHeader, resolveHuggingFaceHeaderLayout } from "./huggingface-layout.mjs";
import {
  MAX_DESCRIPTION_LENGTH,
  PERSONAL_DATA_VERSION,
  loadPersonalData,
  mergePersonalData,
  relatedResourceNames,
  savePersonalData,
  serializePersonalData,
  validatePersonalDataPayload
} from "./personal-store.mjs";
const DATA_URL = new URL("./data/knowledge.json", import.meta.url);
let hfPersonalSync = null;
let hfHostViewportBaseline = null;
let dialogScrollLock = null;

function lockDialogBackground() {
  if (dialogScrollLock) return;
  const scrollY = Math.max(0, Number(window.scrollY) || 0);
  dialogScrollLock = { scrollY, bodyTop: document.body.style.top };
  document.documentElement.classList.add("dialog-scroll-lock");
  document.body.classList.add("dialog-scroll-lock");
  document.body.style.top = `-${scrollY}px`;
}

function unlockDialogBackground() {
  if (!dialogScrollLock) return;
  const { scrollY, bodyTop } = dialogScrollLock;
  dialogScrollLock = null;
  document.documentElement.classList.remove("dialog-scroll-lock");
  document.body.classList.remove("dialog-scroll-lock");
  document.body.style.top = bodyTop;
  window.scrollTo({ left: 0, top: scrollY, behavior: "instant" });
}

function configureHostLayout() {
  const configuredHeader = String(window.FAVSENSE_CONFIG?.huggingFaceHeader || "default").toLowerCase();
  const miniHeaderIsPresent = hasHuggingFaceMiniHeader({
    framed: window.self !== window.top,
    referrer: document.referrer,
    creatorUserId: window.huggingface?.variables?.SPACE_CREATOR_USER_ID,
    configuredHeader,
  });
  const layout = resolveHuggingFaceHeaderLayout({
    capable: miniHeaderIsPresent,
    outerHeight: window.outerHeight,
    innerHeight: window.innerHeight,
    baselineGap: hfHostViewportBaseline,
  });
  hfHostViewportBaseline = layout.baselineGap;
  document.documentElement.dataset.hfHeader = layout.mode;
}

configureHostLayout();
window.addEventListener("resize", configureHostLayout, { passive: true });
window.visualViewport?.addEventListener("resize", configureHostLayout, { passive: true });

function emptyKnowledgeData() {
  return {
    meta: {
      noteCount: 0,
      frameEvidenceCount: 0,
      verifiedNoteCount: 0,
      resourceCount: 0,
      resourceIndexEnabled: false,
      kindLabels: {},
      resourceIndex: {
        groups: [],
        sorts: [{ id: "name-asc", label: "按名称", field: "name", type: "text", direction: "asc" }]
      }
    },
    categories: [],
    notes: [],
    resources: []
  };
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function validateKnowledgeData(value) {
  const invalid = () => { throw new Error("知识数据格式无效或不完整"); };
  if (!isRecord(value) || !isRecord(value.meta)) invalid();
  if (!Array.isArray(value.notes) || !Array.isArray(value.categories) || !Array.isArray(value.resources)) invalid();
  if (!isRecord(value.meta.kindLabels) || !isRecord(value.meta.resourceIndex)) invalid();
  try { validateResourceIndex(value.meta.resourceIndex); } catch { invalid(); }
  for (const note of value.notes) {
    if (!isRecord(note) || ![note.id, note.title, note.category, note.kind].every((item) => typeof item === "string" && item)) invalid();
    if (typeof note.publishedAt !== "string") invalid();
    if (![note.themes, note.tools, note.resources].every(isStringArray)) invalid();
    if (!isRecord(note.evidence) || typeof note.evidence.method !== "string") invalid();
  }
  for (const category of value.categories) {
    if (!isRecord(category) || typeof category.name !== "string" || !Number.isFinite(category.count)) invalid();
  }
  for (const resource of value.resources) {
    if (!isRecord(resource) || ![resource.name, resource.type, resource.description].every((item) => typeof item === "string")) invalid();
    if (!isStringArray(resource.aliases) || !Array.isArray(resource.actions) || !Array.isArray(resource.attributes)) invalid();
    if (!resource.actions.every((action) => isRecord(action) && typeof action.label === "string" && typeof action.url === "string")) invalid();
    if (!resource.attributes.every((attribute) => isRecord(attribute) && typeof attribute.label === "string" && typeof attribute.value === "string")) invalid();
  }
  return value;
}

function knowledgeLoadErrorMessage(error, currentLocation = window.location) {
  const message = String(error?.message || "");
  if (error?.name === "SyntaxError" || /格式无效|JSON/i.test(message)) {
    return "知识数据文件格式损坏或不完整。可以继续打开“同步设置”；修复数据后请重新加载页面。";
  }
  const httpStatus = message.match(/^HTTP\s+(\d{3})$/i)?.[1];
  if (httpStatus) {
    return `知识数据服务暂时不可用（HTTP ${httpStatus}）。可以继续打开“同步设置”；本机服务连接后，收藏夹管理和手动整理仍可使用。请稍后重新加载。`;
  }
  if (String(currentLocation?.protocol || "").toLowerCase() === "file:") {
    return "浏览器无法直接读取知识数据。请通过 FavSense 本地预览打开站点；同步设置仍可在本地服务中使用。";
  }
  return "知识数据暂时没有加载成功。可以继续打开“同步设置”，并在网络或本地服务恢复后重新加载页面。";
}

function safeStorageGet(key, fallback = "") {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function safeStorageSet(key, value, failureMessage) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    showToast(failureMessage);
    return false;
  }
}

function savedLayoutPreference() {
  const value = safeStorageGet("xhs-kb-layout", "grid");
  return ["grid", "list"].includes(value) ? value : "grid";
}

const elements = {
  notesGrid: document.querySelector("#notes-grid"),
  emptyState: document.querySelector("#empty-state"),
  resultCount: document.querySelector("#result-count"),
  activeFilterLabel: document.querySelector("#active-filter-label"),
  categoryList: document.querySelector("#category-list"),
  kindFilter: document.querySelector("#kind-filter"),
  bookmarkFilter: document.querySelector("#bookmark-filter"),
  bookmarkCount: document.querySelector("#bookmark-count"),
  searchInput: document.querySelector("#search-input"),
  resourceSearch: document.querySelector("#resource-search"),
  resourceTypeFilter: document.querySelector("#resource-type-filter"),
  resourceSort: document.querySelector("#resource-sort"),
  resourceBookmarkFilter: document.querySelector("#resource-bookmark-filter"),
  resourceBookmarkCount: document.querySelector("#resource-bookmark-count"),
  resourceResultCount: document.querySelector("#resource-result-count"),
  resourcesGrid: document.querySelector("#resources-grid"),
  sortSelect: document.querySelector("#sort-select"),
  viewToggle: document.querySelector("#view-toggle"),
  dialog: document.querySelector("#detail-dialog"),
  dialogContent: document.querySelector("#dialog-content"),
  toast: document.querySelector("#toast"),
  boardManager: document.querySelector("#board-manager"),
  boardList: document.querySelector("#board-list"),
  boardEnabledCount: document.querySelector("#board-enabled-count"),
  boardManagerStatus: document.querySelector("#board-manager-status"),
  manualSyncControl: document.querySelector("#manual-sync-control"),
  manualSyncStart: document.querySelector("#manual-sync-start"),
  manualSyncTitle: document.querySelector("#manual-sync-title"),
  manualSyncDetail: document.querySelector("#manual-sync-detail"),
  personalBookmarkCount: document.querySelector("#personal-bookmark-count"),
  personalEditCount: document.querySelector("#personal-edit-count"),
  personalExport: document.querySelector("#personal-data-export"),
  personalImport: document.querySelector("#personal-data-import"),
  personalImportInput: document.querySelector("#personal-data-import-input"),
  cloudSyncRow: document.querySelector("#cloud-sync-row"),
  cloudSyncStatus: document.querySelector("#cloud-sync-status"),
  cloudSyncLogin: document.querySelector("#cloud-sync-login"),
  cloudSyncLogout: document.querySelector("#cloud-sync-logout"),
  hero: document.querySelector("#hero-overview"),
  creatorSpaceLink: document.querySelector("#creator-space-link"),
  creatorSpaceName: document.querySelector("#creator-space-name")
};

const state = {
  data: emptyKnowledgeData(),
  knowledgeReady: false,
  personalStoreReady: false,
  view: "notes",
  query: "",
  resourceQuery: "",
  resourceType: "all",
  resourceSort: "",
  category: "all",
  kind: "all",
  bookmarksOnly: false,
  resourceBookmarksOnly: false,
  bookmarks: new Set(),
  bookmarkStates: {},
  descriptionOverrides: {},
  editingDescriptionId: null,
  cloud: { available: false, authenticated: false, username: "", repository: "", ready: false, oauth: null },
  sort: "newest",
  layout: savedLayoutPreference(),
  localBridge: null,
  statusContract: null,
  boards: [],
  boardUpdatePending: false,
  manualSync: { state: "idle" },
  manualSyncStartedHere: false,
  noteOrganizationStatus: new Map(),
  noteOrganizationPending: new Set(),
  manualSyncPoll: 0
};

function sopBrowserReady() {
  return state.localBridge?.browserSession?.owner === "sop-cdp"
    && state.localBridge.browserSession.ready === true;
}

function bookmarkIcon() {
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 4.5c0-1.1.9-2 2-2h7c1.1 0 2 .9 2 2v17L12 18l-5.5 3.5v-17Z" /></svg>';
}

function validNoteIds() {
  return new Set(state.data?.notes.map((note) => note.id) || []);
}

function personalData() {
  return {
    version: PERSONAL_DATA_VERSION,
    bookmarks: [...state.bookmarks],
    bookmarkStates: Object.fromEntries(Object.entries(state.bookmarkStates).map(([id, entry]) => [id, { ...entry }])),
    descriptionOverrides: Object.fromEntries(Object.entries(state.descriptionOverrides).map(([id, entry]) => [id, { ...entry }]))
  };
}

function persistPersonalData(candidate = personalData()) {
  if (!state.knowledgeReady || !state.personalStoreReady) {
    showToast("知识数据或个人存储尚未就绪，个人数据未被读取或更改");
    return false;
  }
  try {
    const saved = savePersonalData(localStorage, candidate, validNoteIds());
    state.bookmarks = new Set(saved.bookmarks);
    state.bookmarkStates = saved.bookmarkStates;
    state.descriptionOverrides = saved.descriptionOverrides;
    renderPersonalControls();
    queueCloudSave();
    return true;
  } catch {
    showToast("浏览器无法保存个人数据，请先导出备份");
    return false;
  }
}

function noteDescription(note) {
  const override = state.descriptionOverrides[note.id];
  return (!override?.deleted && override?.description) || note.deepSummary || note.summary;
}

function renderPersonalControls() {
  const bookmarkCount = state.bookmarks.size;
  const editCount = Object.values(state.descriptionOverrides).filter((entry) => !entry.deleted).length;
  elements.bookmarkCount.textContent = bookmarkCount;
  elements.bookmarkFilter.classList.toggle("is-active", state.bookmarksOnly);
  elements.bookmarkFilter.setAttribute("aria-pressed", String(state.bookmarksOnly));
  elements.resourceBookmarkCount.textContent = relatedResourceNames(state.data?.notes, state.bookmarks).size;
  elements.resourceBookmarkFilter.classList.toggle("is-active", state.resourceBookmarksOnly);
  elements.resourceBookmarkFilter.setAttribute("aria-pressed", String(state.resourceBookmarksOnly));
  elements.personalBookmarkCount.textContent = bookmarkCount;
  elements.personalEditCount.textContent = editCount;
}

function renderCloudStatus(message = "") {
  elements.cloudSyncRow.hidden = !state.cloud.available;
  if (!state.cloud.available) return;
  elements.cloudSyncLogin.hidden = state.cloud.authenticated;
  elements.cloudSyncLogout.hidden = !state.cloud.authenticated;
  if (message) elements.cloudSyncStatus.textContent = message;
  else if (!state.cloud.authenticated) elements.cloudSyncStatus.textContent = "登录后可在不同设备之间同步书签与修订。";
  else elements.cloudSyncStatus.textContent = `已同步到 HF 私有数据集 · ${state.cloud.username}`;
}

async function flushCloudSaves() {
  if (flushCloudSaves.running || !state.cloud.ready || !state.cloud.authenticated) return;
  flushCloudSaves.running = true;
  try {
    while (flushCloudSaves.dirty && state.cloud.ready && state.cloud.authenticated) {
      flushCloudSaves.dirty = false;
      renderCloudStatus("正在同步个人数据…");
      const remoteMerged = await hfPersonalSync.saveHfPersonalData(state.cloud, personalData());
      const currentMerged = mergePersonalData(remoteMerged, personalData(), validNoteIds());
      const saved = savePersonalData(localStorage, currentMerged, validNoteIds());
      state.bookmarks = new Set(saved.bookmarks);
      state.bookmarkStates = saved.bookmarkStates;
      state.descriptionOverrides = saved.descriptionOverrides;
      renderPersonalControls();
      renderNotes();
      renderResources();
    }
    renderCloudStatus();
  } catch {
    flushCloudSaves.dirty = false;
    renderCloudStatus("HF 同步已停止；请确认个人 Dataset 仍为私有。浏览器本地版本已保留。");
  } finally {
    flushCloudSaves.running = false;
  }
}

function queueCloudSave() {
  if (!state.cloud.ready || !state.cloud.authenticated) return;
  flushCloudSaves.dirty = true;
  window.clearTimeout(queueCloudSave.timer);
  queueCloudSave.timer = window.setTimeout(flushCloudSaves, 300);
}

async function initCloudSync() {
  try {
    if (!window.huggingface?.variables?.OAUTH_CLIENT_ID) return;
    hfPersonalSync ||= await import("./hf-personal-sync.mjs");
    state.cloud = { ...(await hfPersonalSync.initializeHfPersonalSync()), ready: false };
    if (state.cloud.loginUrl) elements.cloudSyncLogin.href = state.cloud.loginUrl;
    renderCloudStatus();
    if (!state.cloud.authenticated) return;

    const remote = await hfPersonalSync.loadHfPersonalData(state.cloud);
    const merged = mergePersonalData(remote || {}, personalData(), validNoteIds());
    state.cloud.ready = true;
    if (!persistPersonalData(merged)) {
      state.cloud.ready = false;
      renderCloudStatus("浏览器无法保存合并后的个人数据；HF 同步已停止。请先导出当前备份。");
      return;
    }
    renderNotes();
    renderResources();
  } catch {
    if (state.cloud.available) renderCloudStatus("HF 私有数据集暂时不可用；浏览器本地版本仍可正常使用。");
  }
}

const stationeryPalette = ["#3569e8", "#6f3cc3", "#d9368b", "#e66b00", "#b58b00", "#6b9e1b", "#008f66", "#00889a"];
const categoryAccents = new Map([
  ["信息采集与搜索", "#3569e8"],
  ["Skills与工作流", "#6f3cc3"],
  ["Agent与自动化", "#d9368b"],
  ["知识管理与记忆", "#16803c"],
  ["开发部署与Vibe Coding", "#e66b00"],
  ["内容增长与商业", "#d14b31"],
  ["AI设计与多媒体", "#b54335"],
  ["本地模型与成本", "#007c91"],
  ["垂直工具与数据", "#b58b00"]
]);

function categoryAccent(category) {
  if (category === "all") return "#ff2442";
  if (categoryAccents.has(category)) return categoryAccents.get(category);
  const hash = [...String(category)].reduce((total, char) => total + char.codePointAt(0), 0);
  return stationeryPalette[hash % stationeryPalette.length];
}

function escapeHtml(value = "") {
  return String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
}

function splitLongSummaryParagraph(text, maxLength = 180) {
  if (text.length <= maxLength) return [text];
  const sentences = text.match(/[^。！？!?；;]+[。！？!?；;]?/g)?.map((item) => item.trim()).filter(Boolean) || [];
  if (sentences.length < 2) return [text];
  return sentences.reduce((paragraphs, sentence) => {
    const last = paragraphs.at(-1) || "";
    if (!last || last.length + sentence.length > maxLength) return [...paragraphs, sentence];
    return [...paragraphs.slice(0, -1), `${last}${sentence}`];
  }, []);
}

function summaryTokens(value) {
  const normalized = String(value ?? "").replace(/\r\n?/g, "\n").trim();
  if (!normalized) return [];
  const knownSectionHeading = /^(?:核心(?:结论|逻辑|思路|要点)|主要内容|具体方法|实操方法|操作步骤|三步实操方法|案例与价值|适用场景|注意事项|风险提醒|补充提醒|总结)$/;
  const numberedMarker = /(?:^|[\s：:；;。])\d{1,2}\s*[、，.)．]\s*/g;
  let expanded = (normalized.match(numberedMarker) || []).length >= 2
    ? normalized.replace(/([^\n])\s+(?=\d{1,2}\s*[、，.)．]\s*)/g, "$1\n")
    : normalized;
  expanded = expanded.replace(
    /(^|\s)(核心(?:结论|逻辑|思路|要点)|主要内容|具体方法|实操方法|操作步骤|三步实操方法|案例与价值|适用场景|注意事项|风险提醒|补充提醒|总结)(?=\s)/g,
    "$1\n$2\n",
  ).replace(/\n{3,}/g, "\n\n").trim();
  return expanded.split("\n").flatMap((rawLine) => {
    const line = rawLine.trim();
    if (!line) return [{ type: "break", text: "" }];
    const markdownHeading = line.match(/^#{1,6}\s+(.+)$/);
    const emphasizedHeading = line.match(/^\*\*([^*]+)\*\*[：:]?$/);
    const shortHeading = line.length <= 36 && /[：:]$/.test(line);
    if (markdownHeading || emphasizedHeading || shortHeading || knownSectionHeading.test(line)) {
      return [{ type: "heading", text: (markdownHeading?.[1] || emphasizedHeading?.[1] || line).replace(/[：:]$/, "").trim() }];
    }
    const ordered = line.match(/^(\d{1,2})\s*[、，.)．]\s*(.+)$/);
    if (ordered) return [{ type: "ordered", number: Number(ordered[1]), text: ordered[2].trim() }];
    const unordered = line.match(/^(?:[-*•·]|[（(]?[A-Za-z][)）.、])\s*(.+)$/);
    if (unordered) return [{ type: "unordered", text: unordered[1].trim() }];
    return splitLongSummaryParagraph(line).map((text) => ({ type: "paragraph", text }));
  });
}

function formatSummaryHtml(value) {
  const blocks = [];
  let list = null;
  const flushList = () => {
    if (!list) return;
    const start = list.type === "ordered" && list.start !== 1 ? ` start="${list.start}"` : "";
    const tag = list.type === "ordered" ? "ol" : "ul";
    blocks.push(`<${tag}${start}>${list.items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</${tag}>`);
    list = null;
  };
  for (const token of summaryTokens(value)) {
    if (["ordered", "unordered"].includes(token.type)) {
      if (!list || list.type !== token.type) {
        flushList();
        list = { type: token.type, start: token.number || 1, items: [] };
      }
      list = { ...list, items: [...list.items, token.text] };
      continue;
    }
    flushList();
    if (token.type === "heading") blocks.push(`<h4>${escapeHtml(token.text)}</h4>`);
    if (token.type === "paragraph") blocks.push(`<p>${escapeHtml(token.text)}</p>`);
  }
  flushList();
  return blocks.join("");
}

function summarySourcePresentation(note) {
  const summaryStatus = String(
    note.summaryState || note.summary_state || note.summaryStatus || note.summary_status || "not_started"
  );
  const reason = String(
    note.summaryReasonCode || note.summary_reason_code || note.summaryReason || note.summary_reason || ""
  );
  if (summaryStatus === "failed") return {
    label: "本篇总结失败，可在下次继续",
    tone: "warning",
    explanation: "核心收藏已保存；本篇深度总结已尝试但未完成。"
  };
  if (summaryStatus === "batch_aborted") return {
    label: "本次未尝试，可继续整理",
    tone: "warning",
    explanation: "核心收藏已保存；本轮在处理本篇前已经停止。"
  };
  if (summaryStatus === "stale" && reason === "unknown_legacy") return {
    label: "历史整理状态待确认，等待重新整理",
    tone: "warning",
    explanation: "核心收藏已保留；旧版记录无法确认是否曾完成总结。"
  };
  if (summaryStatus === "stale") return {
    label: reason === "evidence_changed"
        ? "证据已变化，等待重新审核"
        : "正文已变化，等待重新审核",
    tone: "warning",
    explanation: "历史整理结果仍保留，但不会作为当前正式总结展示。"
  };
  if (note.deepSummarySource === "xiaohongshu-diandian") return {
    label: "点点 AI 深度总结",
    tone: "diandian",
    explanation: "这份内容来自点点 AI 对原帖的总结，并已通过当前知识卡的整理检查。"
  };
  if (summaryStatus === "captured") return {
    label: "总结已捕获，等待审核",
    tone: "warning",
    explanation: "点点总结已安全保存在本机；审核通过前不会替换当前公开内容。"
  };
  if (note.deepSummarySource === "curation") return {
    label: "使用其他证据整理",
    tone: "evidence",
    explanation: "未获得可用于这张卡的点点总结；当前内容根据已记录的其他证据整理。"
  };
  return {
    label: "尚未开始深度整理",
    tone: "metadata",
    explanation: "核心收藏已保存；这张卡尚未完成深度总结。"
  };
}

function safeUrl(value, allowedHosts = null) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return "#";
    if (allowedHosts && !allowedHosts.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`))) return "#";
    return url.href;
  } catch {
    return "#";
  }
}

function parseMetric(value) {
  const text = String(value || "").trim().toLowerCase();
  const number = Number.parseFloat(text.replace(/,/g, "")) || 0;
  if (text.includes("万")) return number * 10000;
  if (text.includes("k")) return number * 1000;
  return number;
}

function displayMetric(value) {
  if (!value) return "—";
  return String(value);
}

function renderConfiguredTitle(element, value) {
  const parts = String(value || "").split(/<br\s*\/?>/i);
  element.replaceChildren(...parts.flatMap((part, index) => index ? [document.createElement("br"), part] : [part]));
}

function formatDate(value) {
  if (!value) return "日期未记录";
  const normalized = value.replace("_", "T");
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return value.slice(0, 10);
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "short", day: "numeric" }).format(date);
}

function resourceMap() {
  return new Map(state.data.resources.map((resource) => [resource.name, resource]));
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add("is-visible");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => elements.toast.classList.remove("is-visible"), 2200);
}

function renderKnowledgeLoadError(error) {
  elements.resultCount.textContent = "0";
  elements.activeFilterLabel.textContent = "知识数据暂不可用";
  elements.emptyState.hidden = true;
  elements.notesGrid.innerHTML = `
    <div class="empty-state knowledge-load-error" role="alert">
      <span>知识卡暂时无法显示</span>
      <p>${escapeHtml(knowledgeLoadErrorMessage(error))}</p>
      <button type="button" data-retry-knowledge>重新加载知识数据</button>
    </div>`;
}

async function localBridgeRequest(path, options = {}) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(`${state.localBridge.baseUrl}${path}`, {
      ...options,
      cache: "no-store",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...(state.localBridge.token ? { "X-XHS-Bridge-Token": state.localBridge.token } : {}),
        ...(options.headers || {})
      }
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok !== true) {
      throw new Error(normalizeLocalBridgeDiagnostic(payload.error) || `HTTP ${response.status}`);
    }
    return payload;
  } catch (error) {
    if (error.name === "AbortError") throw new Error("本机同步服务响应超时");
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

function renderBoardManager() {
  const enabledCount = state.boards.filter((board) => board.enabled && board.available !== false).length;
  elements.boardEnabledCount.textContent = `已选择 ${enabledCount} / ${state.boards.length}`;
  elements.boardList.innerHTML = state.boards.map((board) => {
    const count = Number.isFinite(board.advertised_count) && board.advertised_count > 0
      ? `${board.captured_count || 0} / ${board.advertised_count} 篇已收录`
      : `${board.captured_count || 0} 篇已收录`;
    return `
      <div class="board-row">
        <div class="board-identity">
          <strong>${escapeHtml(board.name)}</strong>
          <span>${count}</span>
        </div>
        <span class="board-state">${board.available === false ? "本轮不可见" : (board.enabled ? "已纳入" : "已忽略")}</span>
        <label class="board-toggle">
          <input type="checkbox" data-board-toggle="${escapeHtml(board.id)}" aria-label="整理时纳入 ${escapeHtml(board.name)}" ${board.enabled ? "checked" : ""} ${state.boardUpdatePending || board.available === false ? "disabled" : ""} />
          <span class="board-toggle-track" aria-hidden="true"><i></i></span>
        </label>
      </div>`;
  }).join("");
}

function renderManualSync(status = state.manualSync) {
  state.manualSync = status;
  const v2 = status.schema_version === 2 && status.phases;
  const active = v2
    ? Object.values(status.phases).some((phase) => phase.status === "running")
    : ["starting", "running"].includes(status.state);
  const completed = v2
    ? ["organization_ready", "published"].includes(status.state)
    : status.state === "completed";
  const failed = status.state === "failed" && !active;
  const safetyStopped = ["safety-stopped", "safety_stopped"].includes(status.state);
  elements.manualSyncControl.classList.toggle("is-running", active);
  elements.manualSyncControl.classList.toggle("is-complete", completed);
  elements.manualSyncControl.classList.toggle("is-failed", failed || safetyStopped);
  elements.manualSyncStart.disabled = active || !sopBrowserReady();
  elements.manualSyncStart.textContent = active
    ? "整理中…"
    : (safetyStopped ? "检查后重试" : (completed || failed ? "再次整理" : "开始整理"));
  const singleNoteButton = elements.dialogContent.querySelector("[data-summarize-note]");
  if (singleNoteButton) singleNoteButton.disabled = active || !sopBrowserReady();

  if (v2) {
    const copy = state.statusContract?.copy || {};
    const phases = status.phases;
    if (safetyStopped) {
      elements.manualSyncTitle.textContent = copy.safety_stopped;
    } else if (phases.core.status === "running") {
      elements.manualSyncTitle.textContent = copy.core_running;
    } else if (phases.core.status === "not_started") {
      elements.manualSyncTitle.textContent = copy.core_not_started;
    } else if (phases.core.status === "failed") {
      elements.manualSyncTitle.textContent = copy.core_failed;
    } else if (phases.build.status === "failed") {
      elements.manualSyncTitle.textContent = copy.build_failed;
    } else if (phases.publish.status === "failed") {
      elements.manualSyncTitle.textContent = copy.publish_failed;
    } else if (phases.publish.status === "unchanged") {
      elements.manualSyncTitle.textContent = copy.publish_unchanged;
    } else if (phases.summary.status === "failed") {
      elements.manualSyncTitle.textContent = copy.summary_failed;
    } else if (phases.summary.status === "batch_aborted") {
      elements.manualSyncTitle.textContent = copy.summary_batch_aborted;
    } else if (["missing", "partial", "blocked"].includes(phases.evidence.status)) {
      elements.manualSyncTitle.textContent = copy.evidence_missing;
    } else if (phases.summary.status === "not_started") {
      elements.manualSyncTitle.textContent = copy.summary_not_started;
    } else {
      elements.manualSyncTitle.textContent = copy.core_completed;
    }
    elements.manualSyncDetail.textContent = phases.core.status === "completed"
      ? `${copy.core_completed}；已扫描 ${status.counts.scanned} 条，新增 ${status.counts.new} 条。`
      : `已扫描 ${status.counts.scanned} 条，新增 ${status.counts.new} 条。`;
  } else if (status.state === "starting") {
    elements.manualSyncTitle.textContent = "正在使用 SOP 小红书扫描浏览器";
    elements.manualSyncDetail.textContent = "请在 SOP 扫描浏览器中保持小红书登录；扫描与整理进度会自动回到这里。";
  } else if (status.state === "running") {
    if (status.summary_plan_pending) {
      elements.manualSyncTitle.textContent = "核心入库完成，正在确认深度整理";
      elements.manualSyncDetail.textContent = "本地知识库已保留；正在确认本轮点点 AI 计划，请保持 SOP 扫描浏览器开启。";
    } else {
      elements.manualSyncTitle.textContent = status.current_board ? `正在整理「${status.current_board}」` : "正在整理收藏";
      elements.manualSyncDetail.textContent = `已完成 ${status.processed_boards || 0} / ${status.board_count || state.boards.length} 个收藏夹，请保持 SOP 扫描浏览器开启。`;
    }
  } else if (completed) {
    elements.manualSyncTitle.textContent = "本次整理完成";
    const publishMessage = status.publish_status === "published"
      ? "，Hugging Face 已更新"
      : status.publish_status === "unchanged"
        ? "，Hugging Face 内容无变化"
        : "";
    elements.manualSyncDetail.textContent = `共扫描 ${status.scanned || 0} 条，新增 ${status.new || 0} 条；本地知识库与网页已经更新${publishMessage}。`;
  } else if (failed) {
    elements.manualSyncTitle.textContent = status.core_completed === true
      ? "核心整理已完成，点点增强未完成"
      : "本次整理未完成";
    elements.manualSyncDetail.textContent = normalizeLocalBridgeDiagnostic(status.error)
      || "请检查 SOP 扫描浏览器的登录状态后再次整理。";
  } else if (safetyStopped) {
    elements.manualSyncTitle.textContent = "已因小红书安全限制停止";
    elements.manualSyncDetail.textContent = normalizeLocalBridgeDiagnostic(status.error)
      || "核心入库结果已经保留。请先在 SOP 扫描浏览器中完成验证或等待访问恢复，再由你手动重试；系统不会自动重试。";
  } else {
    elements.manualSyncTitle.textContent = "准备好后再开始";
    elements.manualSyncDetail.textContent = sopBrowserReady()
      ? "点击一次即可同步已开启的收藏夹、增量去重，并更新知识库与公开网页。"
      : "SOP 扫描浏览器未就绪。请先启动并登录该浏览器；FavSense 不会改用主浏览器或另建登录窗口。";
  }
}

async function refreshManualSyncStatus() {
  const status = validateLocalBridgeSyncStatus(await localBridgeRequest("/sync/status"), state.statusContract);
  renderManualSync(status);
  const v2 = status.schema_version === 2 && status.phases;
  const active = v2
    ? Object.values(status.phases).some((phase) => phase.status === "running")
    : ["starting", "running"].includes(status.state);
  if (!active) {
    window.clearInterval(state.manualSyncPoll);
    state.manualSyncPoll = 0;
    const corePreserved = v2
      ? status.phases.core.status === "completed"
      : (status.state === "completed" || status.core_completed === true);
    if (corePreserved && state.manualSyncStartedHere) {
      state.manualSyncStartedHere = false;
      const refreshMessage = ["safety-stopped", "safety_stopped"].includes(status.state)
        ? "核心整理结果已保留；已因小红书安全限制停止，正在刷新知识库"
        : v2 && status.phases.build.status === "failed"
          ? "核心收藏已保存；构建失败，已保留上一版"
          : v2 && status.phases.publish.status === "failed"
            ? "本地整理已保留；发布失败，远端仍为上一版"
            : v2 && status.state === "organization_partial"
              ? "核心收藏已保存；部分整理未完成，正在刷新可用结果"
        : status.core_completed === true && status.state !== "completed"
          ? "核心整理完成，点点增强未完成；正在刷新知识库"
          : "整理完成，正在刷新知识库";
      showToast(refreshMessage);
      window.setTimeout(() => location.reload(), 900);
    }
  }
  return status;
}

function watchManualSync() {
  window.clearInterval(state.manualSyncPoll);
  state.manualSyncPoll = window.setInterval(() => {
    refreshManualSyncStatus().catch(() => {
      window.clearInterval(state.manualSyncPoll);
      state.manualSyncPoll = 0;
      renderManualSync({ state: "failed", error: "暂时无法读取本机整理进度，请确认工作台仍在运行。" });
    });
  }, 2000);
}

async function startManualSync() {
  if (!state.localBridge || !sopBrowserReady() || ["starting", "running"].includes(state.manualSync.state)) return;
  elements.manualSyncStart.disabled = true;
  renderManualSync({ state: "starting" });
  try {
    const status = validateLocalBridgeSyncStatus(
      await localBridgeRequest("/sync/start", { method: "POST", body: "{}" }), state.statusContract
    );
    state.manualSyncStartedHere = true;
    renderManualSync(status);
    watchManualSync();
    showToast("已在 SOP 扫描浏览器中开始整理收藏");
  } catch (error) {
    renderManualSync({ state: "failed", error: error.message });
    showToast("没有开始整理");
  }
}

async function startSingleNoteSync(noteId) {
  if (!state.localBridge?.diandianAvailable || !sopBrowserReady() || ["starting", "running"].includes(state.manualSync.state)) return false;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(String(noteId || ""))) {
    showToast("这张卡无法开始本机校验");
    return false;
  }
  renderManualSync({ state: "starting" });
  try {
    const status = validateLocalBridgeSyncStatus(await localBridgeRequest("/sync/start", {
      method: "POST",
      body: JSON.stringify({ note_id: noteId })
    }), state.statusContract);
    state.manualSyncStartedHere = true;
    renderManualSync(status);
    watchManualSync();
    showToast("已在 SOP 扫描浏览器中仅校验并重新总结这张卡；不会发布");
    return true;
  } catch (error) {
    renderManualSync({ state: "failed", error: error.message });
    showToast("没有开始这张卡的本机校验");
    return false;
  }
}

async function initBoardManager() {
  try {
    const runtimeResponse = await fetch("./.local/bridge.json", { cache: "no-store" });
    if (!runtimeResponse.ok) throw new Error("本机同步服务尚未连接");
    state.localBridge = validateLocalBridgeConfig(await runtimeResponse.json());
    const session = await localBridgeRequest("/local-session");
    const validatedSession = validateLocalBridgeSession(session);
    state.localBridge.token = validatedSession.token;
    state.localBridge.browserSession = validatedSession.browserSession;
    state.localBridge.diandianAvailable = session.diandian_available === true;
    const payload = await localBridgeRequest("/boards");
    state.boards = validateLocalBridgeBoards(payload.boards);
    renderBoardManager();
    const openNote = state.data?.notes.find((note) => note.id === elements.dialogContent.dataset.noteId);
    if (elements.dialog.open && openNote) renderDetail(openNote);
    elements.manualSyncControl.hidden = false;
    const syncStatus = await refreshManualSyncStatus();
    if (["starting", "running"].includes(syncStatus.state)) watchManualSync();
  } catch (error) {
    state.localBridge = null;
    elements.boardEnabledCount.textContent = "仅限本机";
    elements.manualSyncControl.hidden = true;
    elements.boardList.innerHTML = '<div class="board-empty">在本机运行 FavSense 后，这里会显示你的全部收藏夹和按需整理开关。</div>';
    elements.boardManagerStatus.textContent = error.message === "本机同步服务尚未连接"
      ? "当前是公开预览；账号与收藏夹设置不会上传。"
      : "暂时无法连接本机同步服务，请确认 FavSense 已启动。";
  }
}

function filteredNotes() {
  const query = state.query.toLocaleLowerCase("zh-CN").trim();
  const notes = state.data.notes.filter((note) => {
    const haystack = [note.title, note.author, note.category, note.suggestedCategory, note.summary, noteDescription(note), note.action, ...note.themes, ...note.tools].join(" ").toLocaleLowerCase("zh-CN");
    return (!query || haystack.includes(query))
      && (state.category === "all" || note.category === state.category)
      && (state.kind === "all" || note.kind === state.kind)
      && (!state.bookmarksOnly || state.bookmarks.has(note.id));
  });

  if (state.sort === "newest") return notes.sort((a, b) => String(b.publishedAt).localeCompare(String(a.publishedAt)));
  if (state.sort === "popular") return notes.sort((a, b) => parseMetric(b.collections) - parseMetric(a.collections));
  return notes.sort((a, b) => a.number - b.number);
}

function renderCategories() {
  const buttons = [{ name: "all", label: "全部主题", count: state.data.notes.length }, ...state.data.categories.map((item) => ({ ...item, label: item.name }))];
  elements.categoryList.innerHTML = buttons.map((item) => `
    <button class="category-button ${state.category === item.name ? "is-active" : ""}" style="--accent:${categoryAccent(item.name)}" type="button" data-category="${escapeHtml(item.name)}" aria-pressed="${state.category === item.name}">
      <span class="category-name"><i aria-hidden="true"></i>${escapeHtml(item.label)}</span><span>${item.count}</span>
    </button>
  `).join("");

  const kinds = [...new Set(state.data.notes.map((note) => note.kind))];
  const kindDescriptions = state.data.meta.kindLabels || {};
  elements.kindFilter.innerHTML = [{ value: "all", label: "全部" }, ...kinds.map((value) => ({ value, label: value }))].map((item) => `
    <button class="kind-button ${state.kind === item.value ? "is-active" : ""}" type="button" data-kind="${escapeHtml(item.value)}" aria-pressed="${state.kind === item.value}" title="${escapeHtml(kindDescriptions[item.value] || "显示全部内容形态")}">${escapeHtml(item.label)}</button>
  `).join("");

}

function noteCard(note) {
  const tools = note.tools.slice(0, 4).map((tool) => `<span class="tool-chip">${escapeHtml(tool)}</span>`).join("");
  const bookmarked = state.bookmarks.has(note.id);
  const summarySource = summarySourcePresentation(note);
  const personallyEdited = Boolean(state.descriptionOverrides[note.id] && !state.descriptionOverrides[note.id].deleted);
  return `
    <article class="note-card" style="--accent:${categoryAccent(note.category)}" data-note-id="${escapeHtml(note.id)}" data-kind="${escapeHtml(note.kind)}">
      <div class="card-strip">
        <span class="card-kind">${escapeHtml(note.category)} · ${escapeHtml(note.kind)}</span>
        <button class="bookmark-button ${bookmarked ? "is-active" : ""}" type="button" data-bookmark-note="${escapeHtml(note.id)}" aria-pressed="${bookmarked}" aria-label="${bookmarked ? "移除书签" : "添加书签"}" title="${bookmarked ? "移除书签" : "添加书签"}">${bookmarkIcon()}</button>
      </div>
      <div class="card-body">
        <h3 class="card-title">${escapeHtml(note.title)}</h3>
        <p class="card-summary-source card-summary-source--${summarySource.tone}"><i aria-hidden="true"></i>${personallyEdited ? "个人修订 · " : ""}${escapeHtml(summarySource.label)}</p>
        <div class="card-summary structured-summary structured-summary--card">${formatSummaryHtml(noteDescription(note))}</div>
        <div class="tools-row">${tools}</div>
      </div>
      <footer class="card-footer">
        <span class="card-metrics"><span>♥ ${escapeHtml(displayMetric(note.likes))}</span><span>收藏 ${escapeHtml(displayMetric(note.collections))}</span></span>
        <button class="card-open" type="button" data-open-note="${escapeHtml(note.id)}">查看总结</button>
      </footer>
    </article>
  `;
}

function renderNotes() {
  const notes = filteredNotes();
  elements.notesGrid.classList.toggle("is-list", state.layout === "list");
  elements.notesGrid.innerHTML = notes.map(noteCard).join("");
  elements.resultCount.textContent = notes.length;
  elements.emptyState.hidden = notes.length > 0;
  const labels = [state.bookmarksOnly ? "我的书签" : (state.category !== "all" ? state.category : "全部知识卡"), state.kind !== "all" ? state.kind : ""].filter(Boolean);
  elements.activeFilterLabel.textContent = labels.join(" · ");
}

function resourceCard(resource) {
  const radar = state.data.meta.resourceIndex;
  const group = resourceGroup(resource, radar);
  const metric = resource.metric || radar.metric?.missing || "暂无数据";
  const actions = resource.actions
    .map((action) => ({ ...action, url: safeUrl(action.url) }))
    .filter((action) => action.url !== "#");
  const attributes = (resource.attributes || []).map((attribute) => `
    <span><small>${escapeHtml(attribute.label)}</small>${escapeHtml(attribute.value)}</span>
  `).join("");
  return `
    <article class="resource-card" style="--accent:${categoryAccent(group)}">
      <div class="resource-top"><span class="resource-type">${escapeHtml(resource.type)}</span><span class="resource-metric">${escapeHtml(resource.metricIcon || radar.metric?.icon || "◆")} ${escapeHtml(metric)}</span></div>
      <h3>${escapeHtml(resource.name)}</h3>
      <p class="resource-description">${escapeHtml(resource.description)}</p>
      ${attributes ? `<div class="resource-attributes">${attributes}</div>` : ""}
      <div class="resource-actions">${actions.map((action) => `<a href="${action.url}" target="_blank" rel="noreferrer">${escapeHtml(action.label)}</a>`).join("")}</div>
    </article>
  `;
}

function renderResources() {
  const radar = state.data.meta.resourceIndex;
  const query = state.resourceQuery.toLocaleLowerCase("zh-CN").trim();
  const bookmarkedResourceNames = relatedResourceNames(state.data.notes, state.bookmarks);
  const filtered = state.data.resources
    .filter((resource) => state.resourceType === "all" || resourceGroup(resource, radar) === state.resourceType)
    .filter((resource) => !state.resourceBookmarksOnly || bookmarkedResourceNames.has(resource.name))
    .filter((resource) => !query || [resource.name, resource.type, resource.description, resourceGroup(resource, radar), ...(resource.aliases || []), ...(resource.attributes || []).flatMap((attribute) => [attribute.label, attribute.value])].join(" ").toLocaleLowerCase("zh-CN").includes(query));
  const resources = sortResources(filtered, state.resourceSort, radar);
  elements.resourcesGrid.innerHTML = resources.length
    ? resources.map(resourceCard).join("")
    : `<div class="resource-empty"><strong>${state.resourceBookmarksOnly ? "还没有书签关联资源" : "没有找到匹配的资源"}</strong><p>${state.resourceBookmarksOnly ? "先在知识卡上添加书签；卡片中提到的工具、项目与网站会出现在这里。" : "换一个关键词或资源类型试试。"}</p></div>`;
  elements.resourceResultCount.textContent = `显示 ${resources.length} / ${state.data.resources.length} 个${radar.entity_label || "资源"}`;
}

function renderResourceControls() {
  const radar = state.data.meta.resourceIndex;
  const counts = new Map();
  for (const resource of state.data.resources) {
    const group = resourceGroup(resource, radar);
    counts.set(group, (counts.get(group) || 0) + 1);
  }
  const options = [...counts].sort(([left], [right]) => left.localeCompare(right, "zh-CN"));
  elements.resourceTypeFilter.innerHTML = [
    `<option value="all">全部类型（${state.data.resources.length}）</option>`,
    ...options.map(([group, count]) => `<option value="${escapeHtml(group)}">${escapeHtml(group)}（${count}）</option>`)
  ].join("");
  renderResourceSortOptions();
}

function renderResourceSortOptions() {
  const radar = state.data.meta.resourceIndex;
  const sorts = resourceSortsForGroup(radar, state.resourceType);
  elements.resourceSort.innerHTML = sorts.map((sort) => `<option value="${escapeHtml(sort.id)}">${escapeHtml(sort.label)}</option>`).join("");
  if (!sorts.some((sort) => sort.id === state.resourceSort)) state.resourceSort = sorts[0]?.id || "name-asc";
  elements.resourceSort.value = state.resourceSort;
}

function descriptionSection(note) {
  const override = state.descriptionOverrides[note.id]?.deleted ? null : state.descriptionOverrides[note.id];
  const heading = note.kind === "Note" ? "原帖摘要" : "核心结论";
  const summarySource = summarySourcePresentation(note);
  const provenance = `
    <div class="summary-provenance summary-provenance--${summarySource.tone}">
      <strong>${escapeHtml(summarySource.label)}</strong>
      <span>${override ? "正文已使用你的个人修订。原系统内容：" : ""}${escapeHtml(summarySource.explanation)}</span>
    </div>`;
  if (state.editingDescriptionId === note.id) {
    return `
      <section class="detail-section">
        ${provenance}
        <form class="description-editor" data-description-form="${escapeHtml(note.id)}">
          <label for="description-${escapeHtml(note.id)}">知识卡描述</label>
          <textarea id="description-${escapeHtml(note.id)}" name="description" maxlength="${MAX_DESCRIPTION_LENGTH}" rows="8">${escapeHtml(noteDescription(note))}</textarea>
          <p>这是你的个人修订，不会进入公开知识库；登录 HF 后会同步到你的私有 Dataset。</p>
          <div class="description-editor-actions">
            <button class="editor-primary" type="submit">保存修改</button>
            <button type="button" data-cancel-description>取消</button>
            ${override ? '<button type="button" data-restore-description>恢复系统版本</button>' : ""}
          </div>
        </form>
      </section>`;
  }
  return `
    <section class="detail-section">
      <div class="detail-section-heading">
        <h3>${heading}</h3>
        <button type="button" data-edit-description="${escapeHtml(note.id)}">编辑描述</button>
      </div>
      ${provenance}
      <div class="structured-summary">${formatSummaryHtml(noteDescription(note))}</div>
      ${override ? '<span class="personal-edit-label">已使用你的个人修订</span>' : ""}
    </section>`;
}

function isLocalWorkbenchLocation(locationValue = window.location) {
  const protocol = String(locationValue?.protocol || "").toLowerCase();
  const hostname = String(locationValue?.hostname || "").toLowerCase();
  return protocol === "file:"
    || hostname === "127.0.0.1"
    || hostname === "localhost"
    || hostname === "[::1]";
}

async function initStatusContract() {
  const response = await fetch("./organization-status-contract.json", { cache: "no-store" });
  if (!response.ok) throw new Error("整理状态契约不可用");
  state.statusContract = validateOrganizationStatusContract(await response.json());
}

function renderDetail(note) {
  const radar = state.data.meta.resourceIndex;
  const resources = resourceMap();
  const matchedResources = (note.resources || []).map((name) => resources.get(name)).filter(Boolean);
  const resourceHtml = matchedResources.length ? `
    <section class="detail-section"><h3>${escapeHtml(radar.detail_label || "相关资源")}</h3><div class="detail-resources">
      ${matchedResources.map((resource) => {
        const actions = resource.actions
          .map((action) => ({ ...action, url: safeUrl(action.url) }))
          .filter((action) => action.url !== "#");
        return `<div class="detail-resource"><strong>${escapeHtml(resource.name)}</strong><span>${escapeHtml(resource.metricIcon || radar.metric?.icon || "◆")} ${escapeHtml(resource.metric || radar.metric?.missing || "暂无数据")}</span><div class="detail-resource-actions">${actions.map((action) => `<a href="${action.url}" target="_blank" rel="noreferrer" aria-label="${escapeHtml(`${resource.name} ${action.label}`)}">${escapeHtml(action.label)}</a>`).join("")}</div></div>`;
      }).join("")}
    </div></section>
  ` : "";
  const localOrganization = state.noteOrganizationStatus?.get(note.id);
  const localOrganizationHtml = localOrganization ? `
    <section class="detail-section pending-evidence-overlay" role="status" aria-label="本机待审核证据">
      <div class="pending-evidence-heading"><span>仅本机</span><strong>${escapeHtml(state.statusContract.copy.summary_captured)}</strong></div>
      <div class="structured-summary">${formatSummaryHtml(localOrganization.display_summary)}</div>
      <p>证据：${localOrganization.evidence_methods.map((evidence) => evidence.method === "point" ? "点点总结" : escapeHtml(evidence.method)).join(" · ")}。尚未通过审核，不会进入公开知识库。</p>
    </section>
  ` : "";
  const actionHtml = note.kind === "Note" || !String(note.action || "").trim() ? "" : `
    <section class="detail-section"><h3>具体用法</h3><div class="action-box"><span>下一步</span><p>${escapeHtml(note.action)}</p></div></section>
  `;
  const tags = [...note.themes, ...note.tools];
  const tagsHtml = tags.length ? `
    <section class="detail-section"><h3>相关主题与工具</h3><div class="tools-row">${tags.map((item) => `<span class="tool-chip">${escapeHtml(item)}</span>`).join("")}</div></section>
  ` : "";
  const categorySuggestionHtml = note.suggestedCategory && note.suggestedCategory !== note.category ? `
    <p class="category-suggestion"><span>内容建议分类</span>${escapeHtml(note.suggestedCategory)}<small>当前仍按收藏夹“${escapeHtml(note.category)}”归档</small></p>
  ` : "";
  const sourceActionHtml = state.localBridge && sopBrowserReady()
    ? `<button type="button" data-open-source-note="${escapeHtml(note.id)}">打开原帖</button>`
    : state.localBridge
      ? '<button type="button" disabled title="请先启动并登录 SOP 扫描浏览器">SOP 扫描浏览器未就绪</button>'
    : isLocalWorkbenchLocation()
      ? '<button type="button" disabled title="请先启动 FavSense 本地服务">请先启动 FavSense 本地服务</button>'
      : `<a href="${safeUrl(note.sourceUrl, ["xiaohongshu.com"])}" target="_blank" rel="noreferrer">在小红书搜索原帖</a>`;
  const singleNoteActionHtml = state.localBridge?.diandianAvailable && sopBrowserReady() ? `
    <button type="button" data-summarize-note="${escapeHtml(note.id)}" ${["starting", "running"].includes(state.manualSync.state) ? "disabled" : ""}>仅在本机校验并用点点重新总结此卡（不会发布）</button>
  ` : state.localBridge
    ? '<button type="button" disabled title="请检查点点 Skill 设置">点点总结当前不可用</button>'
    : "";

  elements.dialog.style.setProperty("--accent", categoryAccent(note.category));
  elements.dialogContent.dataset.noteId = note.id;
  elements.dialogContent.innerHTML = `
    <p class="detail-kicker"><i></i> ${escapeHtml(note.category)} · ${escapeHtml(note.kind)}</p>
    <h2 class="detail-title" id="detail-title">${escapeHtml(note.title)}</h2>
    <div class="detail-meta"><span>${escapeHtml(note.author || "作者未记录")}</span><span>${escapeHtml(formatDate(note.publishedAt))}</span></div>
    ${categorySuggestionHtml}
    ${localOrganizationHtml}
    ${descriptionSection(note)}
    ${actionHtml}
    ${resourceHtml}
    ${tagsHtml}
    <section class="detail-section"><h3>整理依据</h3><p>${escapeHtml(note.evidence.method)}。原视频和分析画面只保存在本机，不进入公开页面。</p></section>
    <footer class="detail-footer">
      ${sourceActionHtml}
      ${singleNoteActionHtml}
      <button type="button" data-copy-note="${escapeHtml(note.id)}">复制卡片链接</button>
      <button class="detail-bookmark ${state.bookmarks.has(note.id) ? "is-active" : ""}" type="button" data-bookmark-note="${escapeHtml(note.id)}" aria-pressed="${state.bookmarks.has(note.id)}">${bookmarkIcon()} ${state.bookmarks.has(note.id) ? "已加书签" : "添加书签"}</button>
    </footer>
  `;
}

async function loadLocalNoteOrganizationStatus(note) {
  if (
    !state.localBridge
    || !state.statusContract
    || note.summaryStatus === "accepted"
    || state.noteOrganizationStatus.has(note.id)
    || state.noteOrganizationPending.has(note.id)
  ) return;
  state.noteOrganizationPending.add(note.id);
  try {
    const payload = await localBridgeRequest("/notes/organization-status", {
      method: "POST",
      body: JSON.stringify({ note_id: note.id })
    });
    const status = validateLocalNoteOrganizationStatus(payload, state.statusContract);
    if (status.note_id !== note.id) throw new Error("本机单篇整理状态不匹配");
    state.noteOrganizationStatus.set(note.id, status);
    if (elements.dialog.open && elements.dialogContent.dataset.noteId === note.id) renderDetail(note);
  } catch {
    // A missing or stale private overlay must not replace the published safe fallback.
  } finally {
    state.noteOrganizationPending.delete(note.id);
  }
}

function openNote(noteId, updateHash = true) {
  const note = state.data.notes.find((item) => item.id === noteId);
  if (!note) return;
  renderDetail(note);
  if (!elements.dialog.open) {
    if (typeof elements.dialog.showModal === "function") elements.dialog.showModal();
    else elements.dialog.setAttribute("open", "");
  }
  lockDialogBackground();
  if (typeof loadLocalNoteOrganizationStatus === "function") void loadLocalNoteOrganizationStatus(note);
  if (updateHash) history.replaceState(null, "", `#note=${encodeURIComponent(noteId)}`);
}

function closeDialog() {
  state.editingDescriptionId = null;
  if (elements.dialog.open) elements.dialog.close();
  unlockDialogBackground();
  history.replaceState(null, "", location.pathname + location.search);
}

function clearFilters() {
  state.query = "";
  state.category = "all";
  state.kind = "all";
  state.bookmarksOnly = false;
  elements.searchInput.value = "";
  renderCategories();
  renderNotes();
}

function setView(view) {
  state.view = view;
  document.querySelectorAll("[data-panel]").forEach((panel) => { panel.hidden = panel.dataset.panel !== view; });
  document.querySelectorAll("[data-view]").forEach((button) => {
    const selected = button.dataset.view === view;
    button.classList.toggle("is-active", selected);
    if (selected) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  updateHeroVisibility();
  if (view === "resources") renderResources();
  const destination = view === "notes" ? elements.hero : document.querySelector(`[data-panel="${view}"]`);
  window.scrollTo({ top: destination.offsetTop - 80, behavior: "smooth" });
}

function updateHeroVisibility() {
  const isNotesView = state.view === "notes";
  elements.hero.hidden = !isNotesView;
}

function toggleBookmark(noteId) {
  if (!validNoteIds().has(noteId)) return;
  const adding = !state.bookmarks.has(noteId);
  const candidate = personalData();
  candidate.bookmarks = adding
    ? [...new Set([...candidate.bookmarks, noteId])]
    : candidate.bookmarks.filter((id) => id !== noteId);
  candidate.bookmarkStates[noteId] = { bookmarked: adding, updatedAt: new Date().toISOString() };
  if (!persistPersonalData(candidate)) return;
  renderNotes();
  renderResources();
  const openNote = state.data.notes.find((note) => note.id === elements.dialogContent.dataset.noteId);
  if (elements.dialog.open && openNote) renderDetail(openNote);
  showToast(adding ? "已添加书签" : "已移除书签");
}

function exportPersonalData() {
  if (!state.knowledgeReady || !state.personalStoreReady) {
    showToast("知识数据或个人存储尚未就绪，无法安全导出个人数据");
    return;
  }
  const blob = new Blob([serializePersonalData(personalData(), validNoteIds())], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `favsense-personal-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  URL.revokeObjectURL(url);
  showToast("个人数据备份已导出");
}

async function importPersonalData(file) {
  if (!file) return;
  if (!state.knowledgeReady || !state.personalStoreReady) throw new Error("知识数据或个人存储尚未就绪，未导入任何个人数据");
  if (file.size > 256 * 1024) throw new Error("备份文件不能超过 256 KB");
  const incoming = validatePersonalDataPayload(JSON.parse(await file.text()));
  const merged = mergePersonalData(personalData(), incoming, validNoteIds());
  if (!persistPersonalData(merged)) return;
  renderNotes();
  renderResources();
  showToast("书签与个人修订已导入");
}

function bindEvents() {
  document.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", () => setView(button.dataset.view)));
  document.querySelector("[data-home-link]")?.addEventListener("click", (event) => {
    event.preventDefault();
    setView("notes");
    history.replaceState(null, "", location.pathname + location.search);
  });
  elements.categoryList.addEventListener("click", (event) => {
    const button = event.target.closest("[data-category]");
    if (!button) return;
    state.category = button.dataset.category;
    renderCategories();
    renderNotes();
  });
  elements.kindFilter.addEventListener("click", (event) => {
    const button = event.target.closest("[data-kind]");
    if (!button) return;
    state.kind = button.dataset.kind;
    renderCategories();
    renderNotes();
  });
  elements.bookmarkFilter.addEventListener("click", () => {
    state.bookmarksOnly = !state.bookmarksOnly;
    renderPersonalControls();
    renderNotes();
  });
  elements.searchInput.addEventListener("input", () => { state.query = elements.searchInput.value; renderNotes(); });
  elements.resourceSearch.addEventListener("input", () => { state.resourceQuery = elements.resourceSearch.value; renderResources(); });
  elements.resourceTypeFilter.addEventListener("change", () => {
    state.resourceType = elements.resourceTypeFilter.value;
    renderResourceSortOptions();
    renderResources();
  });
  elements.resourceSort.addEventListener("change", () => { state.resourceSort = elements.resourceSort.value; renderResources(); });
  elements.resourceBookmarkFilter.addEventListener("click", () => {
    state.resourceBookmarksOnly = !state.resourceBookmarksOnly;
    renderPersonalControls();
    renderResources();
  });
  elements.boardList.addEventListener("change", async (event) => {
    const toggle = event.target.closest("[data-board-toggle]");
    if (!toggle || !state.localBridge || state.boardUpdatePending) return;
    const board = state.boards.find((item) => item.id === toggle.dataset.boardToggle);
    if (!board) return;
    const enabled = toggle.checked;
    state.boardUpdatePending = true;
    elements.boardList.querySelectorAll("[data-board-toggle]").forEach((input) => { input.disabled = true; });
    elements.boardManagerStatus.textContent = `正在更新「${board.name}」…`;
    try {
      const payload = await localBridgeRequest("/boards", {
        method: "POST",
        body: JSON.stringify({ board_id: board.id, enabled })
      });
      state.boards = validateLocalBridgeBoards(payload.boards);
      elements.boardManagerStatus.textContent = "设置已保存；下次点击“开始整理”时会使用新的收藏夹范围。";
      showToast(enabled ? `整理时将纳入「${board.name}」` : `已忽略「${board.name}」`);
    } catch (error) {
      try {
        const authoritative = await localBridgeRequest("/boards");
        state.boards = validateLocalBridgeBoards(authoritative.boards);
        const current = state.boards.find((item) => item.id === board.id);
        elements.boardManagerStatus.textContent = `连接出现异常，已重新读取本机设置：「${board.name}」当前${current?.enabled ? "开启" : "关闭"}。`;
        showToast(`已重新读取「${board.name}」状态`);
      } catch {
        toggle.checked = !enabled;
        elements.boardManagerStatus.textContent = `没有保存：${error.message}`;
        showToast(`没有保存「${board.name}」`);
      }
    } finally {
      state.boardUpdatePending = false;
      renderBoardManager();
    }
  });
  elements.sortSelect.addEventListener("change", () => { state.sort = elements.sortSelect.value; renderNotes(); });
  elements.viewToggle.addEventListener("click", () => {
    const nextLayout = state.layout === "grid" ? "list" : "grid";
    if (!safeStorageSet("xhs-kb-layout", nextLayout, "浏览器无法保存视图设置，布局没有更改")) return;
    state.layout = nextLayout;
    elements.viewToggle.setAttribute("aria-label", state.layout === "grid" ? "切换列表视图" : "切换卡片视图");
    renderNotes();
  });
  elements.notesGrid.addEventListener("click", (event) => {
    if (event.target.closest("[data-retry-knowledge]")) {
      window.location.reload();
      return;
    }
    const bookmarkButton = event.target.closest("[data-bookmark-note]");
    if (bookmarkButton) {
      event.stopPropagation();
      toggleBookmark(bookmarkButton.dataset.bookmarkNote);
      return;
    }
    const openButton = event.target.closest("[data-open-note]");
    const card = event.target.closest("[data-note-id]");
    if (openButton || card) openNote((openButton || card).dataset.openNote || card.dataset.noteId);
  });
  elements.dialogContent.addEventListener("click", async (event) => {
    const bookmarkButton = event.target.closest("[data-bookmark-note]");
    if (bookmarkButton) {
      toggleBookmark(bookmarkButton.dataset.bookmarkNote);
      return;
    }
    const editButton = event.target.closest("[data-edit-description]");
    if (editButton) {
      state.editingDescriptionId = editButton.dataset.editDescription;
      renderDetail(state.data.notes.find((note) => note.id === state.editingDescriptionId));
      elements.dialogContent.querySelector("textarea")?.focus();
      return;
    }
    if (event.target.closest("[data-cancel-description]")) {
      state.editingDescriptionId = null;
      renderDetail(state.data.notes.find((note) => note.id === elements.dialogContent.dataset.noteId));
      return;
    }
    if (event.target.closest("[data-restore-description]")) {
      const noteId = elements.dialogContent.dataset.noteId;
      const candidate = personalData();
      candidate.descriptionOverrides[noteId] = { description: "", deleted: true, updatedAt: new Date().toISOString() };
      if (!persistPersonalData(candidate)) return;
      state.editingDescriptionId = null;
      renderNotes();
      renderDetail(state.data.notes.find((note) => note.id === noteId));
      showToast("已恢复系统版本");
      return;
    }
    const summarizeButton = event.target.closest("[data-summarize-note]");
    if (summarizeButton) {
      summarizeButton.disabled = true;
      await startSingleNoteSync(summarizeButton.dataset.summarizeNote);
      summarizeButton.disabled = ["starting", "running"].includes(state.manualSync.state);
      return;
    }
    const sourceButton = event.target.closest("[data-open-source-note]");
    if (sourceButton) {
      if (!sopBrowserReady()) return;
      sourceButton.disabled = true;
      try {
        await localBridgeRequest("/notes/open", {
          method: "POST",
          body: JSON.stringify({ note_id: sourceButton.dataset.openSourceNote })
        });
        showToast("已在 SOP 扫描浏览器中定位原帖");
      } catch (error) {
        showToast(`没有打开原帖：${error.message}`);
      } finally {
        sourceButton.disabled = false;
      }
      return;
    }
    const copyButton = event.target.closest("[data-copy-note]");
    if (!copyButton) return;
    const url = `${location.origin}${location.pathname}#note=${encodeURIComponent(copyButton.dataset.copyNote)}`;
    try { await navigator.clipboard.writeText(url); showToast("卡片链接已复制"); }
    catch { showToast("浏览器未允许复制，请复制地址栏链接"); }
  });
  elements.dialogContent.addEventListener("submit", (event) => {
    const form = event.target.closest("[data-description-form]");
    if (!form) return;
    event.preventDefault();
    const description = String(new FormData(form).get("description") || "").trim();
    if (!description) {
      showToast("描述不能为空；也可以选择恢复系统版本");
      return;
    }
    const noteId = form.dataset.descriptionForm;
    const candidate = personalData();
    candidate.descriptionOverrides[noteId] = { description, deleted: false, updatedAt: new Date().toISOString() };
    if (!persistPersonalData(candidate)) return;
    state.editingDescriptionId = null;
    renderNotes();
    renderDetail(state.data.notes.find((note) => note.id === noteId));
    showToast(state.cloud.authenticated ? "描述已保存并等待私有同步" : "描述已保存到当前浏览器");
  });
  elements.personalExport.addEventListener("click", exportPersonalData);
  elements.manualSyncStart.addEventListener("click", startManualSync);
  elements.personalImport.addEventListener("click", () => elements.personalImportInput.click());
  elements.personalImportInput.addEventListener("change", async () => {
    try { await importPersonalData(elements.personalImportInput.files?.[0]); }
    catch (error) { showToast(`导入失败：${error.message}`); }
    finally { elements.personalImportInput.value = ""; }
  });
  elements.cloudSyncLogout.addEventListener("click", (event) => {
    event.preventDefault();
    hfPersonalSync?.signOutHfPersonalSync();
    state.cloud = { available: true, authenticated: false, username: "", repository: "", ready: false, oauth: null };
    renderCloudStatus("已退出 HF 同步；浏览器本地数据仍然保留。");
    initCloudSync();
  });
  window.addEventListener("focus", () => {
    if (!state.cloud.authenticated) initCloudSync();
  });
  document.querySelector("#dialog-close").addEventListener("click", closeDialog);
  elements.dialog.addEventListener("click", (event) => { if (event.target === elements.dialog) closeDialog(); });
  elements.dialog.addEventListener("close", () => {
    unlockDialogBackground();
    history.replaceState(null, "", location.pathname + location.search);
  });
  document.querySelector("#empty-clear").addEventListener("click", clearFilters);
  document.querySelector("#theme-toggle").addEventListener("click", () => {
    const dark = document.documentElement.dataset.theme !== "dark";
    if (!safeStorageSet("xhs-kb-theme-xhs", dark ? "dark" : "light", "浏览器无法保存主题设置，主题没有更改")) return;
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    updateThemeToggle();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "/" && !/input|textarea|select/i.test(document.activeElement.tagName)) {
      event.preventDefault();
      setView("notes");
      elements.searchInput.focus();
    }
  });
}

function updateThemeToggle() {
  const toggle = document.querySelector("#theme-toggle");
  const dark = document.documentElement.dataset.theme === "dark";
  const label = dark ? "当前为深色模式，切换到浅色模式" : "当前为浅色模式，切换到深色模式";
  toggle.setAttribute("aria-label", label);
  toggle.title = label;
}

async function init() {
  const savedTheme = safeStorageGet("xhs-kb-theme-xhs");
  document.documentElement.dataset.theme = savedTheme === "dark" ? "dark" : "light";
  updateThemeToggle();
  updateHeroVisibility();
  bindEvents();
  await initStatusContract();
  const boardManagerReady = initBoardManager();

  try {
    const response = await fetch(DATA_URL);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    state.data = validateKnowledgeData(await response.json());
    state.knowledgeReady = true;
  } catch (error) {
    state.knowledgeReady = false;
    for (const control of [elements.personalExport, elements.personalImport, elements.personalImportInput]) {
      control.disabled = true;
      control.title = "知识数据加载成功后才可安全使用个人数据";
    }
    renderCategories();
    renderResourceControls();
    renderPersonalControls();
    renderResources();
    renderKnowledgeLoadError(error);
    await boardManagerReady;
    return;
  }

  try {
    const storedPersonalData = loadPersonalData(localStorage, validNoteIds());
    state.bookmarks = new Set(storedPersonalData.bookmarks);
    state.bookmarkStates = storedPersonalData.bookmarkStates;
    state.descriptionOverrides = storedPersonalData.descriptionOverrides;
    state.personalStoreReady = true;
  } catch {
    state.personalStoreReady = false;
    for (const control of [elements.personalExport, elements.personalImport, elements.personalImportInput]) {
      control.disabled = true;
      control.title = "个人存储无法安全读取；请先修复或清理损坏数据，再重新加载";
    }
    showToast("个人存储无法安全读取，已切换为只读模式且不会覆盖原数据");
  }

  const configuredRepository = window.FAVSENSE_CONFIG?.repositoryUrl
    || window.huggingface?.variables?.GITHUB_REPOSITORY_URL
    || "";
  const repositoryUrl = safeUrl(configuredRepository, ["github.com"]);
  const configuredCreator = window.FAVSENSE_CONFIG?.creatorGitHubUrl
    || window.huggingface?.variables?.CREATOR_GITHUB_URL
    || configuredRepository;
  const creatorGitHubUrl = safeUrl(configuredCreator, ["github.com"]);
  if (creatorGitHubUrl !== "#") {
    elements.creatorSpaceLink.href = creatorGitHubUrl;
    elements.creatorSpaceName.textContent = window.FAVSENSE_CONFIG?.creatorName
      || window.huggingface?.variables?.CREATOR_NAME
      || "FavSense / GitHub";
    elements.creatorSpaceLink.hidden = false;
  }

  document.querySelector("#stat-notes").textContent = state.data.meta.noteCount;
  document.querySelector("#stat-frames").textContent = new Intl.NumberFormat("zh-CN").format(state.data.meta.frameEvidenceCount);
  document.querySelector("#proof-videos").textContent = state.data.meta.verifiedNoteCount;
  document.querySelector("#proof-frames").textContent = new Intl.NumberFormat("zh-CN").format(state.data.meta.frameEvidenceCount);
  const generatedAt = new Date(state.data.meta.generatedAt);
  document.querySelector("#proof-updated-at").textContent = Number.isNaN(generatedAt.getTime())
    ? ""
    : `本次更新：${generatedAt.toLocaleString("zh-CN", { dateStyle: "medium", timeStyle: "short" })}`;
  const radar = state.data.meta.resourceIndex || {};
  document.querySelector("#proof-resources").textContent = state.data.meta.resourceCount;
  document.querySelector("#proof-resources-label").textContent = `个来源明确的${radar.entity_label || "资源"}`;
  document.querySelector("#resource-verified-date").textContent = `${radar.verified_label || "资料更新于"} ${state.data.meta.resourcesVerifiedAt || "暂无日期"}`;
  document.querySelector("#resources-nav").textContent = radar.label || "资源索引";
  document.querySelector("#resource-eyebrow").textContent = radar.eyebrow || "来源明确的相关资源";
  renderConfiguredTitle(document.querySelector("#resource-title"), radar.title || "从收藏里的名字，<br />直达可靠来源。");
  document.querySelector("#resource-description").textContent = radar.description || "集中查看资源的用途、适用条件与可靠来源。";
  elements.resourceSearch.placeholder = radar.search_placeholder || "搜索资源名称、类型或用途…";
  document.querySelector("#resource-filter-label").textContent = radar.filter_label || "类型";
  const pageTitle = String(state.data.meta.title || "").trim() || "小红书收藏知识工作台";
  document.title = `FavSense · 拾光台 · ${pageTitle}`;
  const description = document.querySelector('meta[name="description"]');
  if (description) description.content = state.data.meta.description;
  const sourceBoard = String(state.data.meta.sourceBoard || "").trim() || "收藏知识库";
  document.querySelector("#hero-eyebrow").textContent = state.data.meta.hero?.eyebrow || `本期片场 · ${sourceBoard}`;
  document.querySelector("#hero-from").textContent = state.data.meta.hero?.from || "收藏过";
  document.querySelector("#hero-to").textContent = state.data.meta.hero?.to || "判断过";
  document.querySelector("#hero-intro").textContent = state.data.meta.hero?.intro || state.data.meta.description;
  if (!state.data.meta.resourceIndexEnabled) {
    document.querySelector("#resources-nav").hidden = true;
    document.querySelector("#proof-resources-cell").hidden = true;
  }

  elements.sortSelect.value = state.sort;
  renderCategories();
  renderNotes();
  renderResourceControls();
  renderPersonalControls();
  renderResources();
  await Promise.all([boardManagerReady, state.personalStoreReady ? initCloudSync() : Promise.resolve()]);

  const noteId = new URLSearchParams(location.hash.slice(1)).get("note");
  if (noteId) openNote(noteId, false);
}

init();
