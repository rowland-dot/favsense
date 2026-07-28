import { resourceGroup, resourceSortsForGroup, sortResources } from "./resource-utils.mjs";
import { validateLocalBridgeConfig, validateLocalBridgeSession } from "./local-bridge-utils.mjs";

const DATA_URL = new URL("./data/knowledge.json", import.meta.url);

const elements = {
  notesGrid: document.querySelector("#notes-grid"),
  emptyState: document.querySelector("#empty-state"),
  resultCount: document.querySelector("#result-count"),
  activeFilterLabel: document.querySelector("#active-filter-label"),
  categoryList: document.querySelector("#category-list"),
  kindFilter: document.querySelector("#kind-filter"),
  searchInput: document.querySelector("#search-input"),
  resourceSearch: document.querySelector("#resource-search"),
  resourceTypeFilter: document.querySelector("#resource-type-filter"),
  resourceSort: document.querySelector("#resource-sort"),
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
  hero: document.querySelector("#hero-overview"),
  creatorSpaceLink: document.querySelector("#creator-space-link"),
  creatorSpaceName: document.querySelector("#creator-space-name")
};

const state = {
  data: null,
  view: "notes",
  query: "",
  resourceQuery: "",
  resourceType: "all",
  resourceSort: "",
  category: "all",
  kind: "all",
  sort: "curated",
  layout: localStorage.getItem("xhs-kb-layout") || "grid",
  localBridge: null,
  boards: [],
  boardUpdatePending: false
};

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
    if (!response.ok || payload.ok !== true) throw new Error(payload.error || `HTTP ${response.status}`);
    return payload;
  } catch (error) {
    if (error.name === "AbortError") throw new Error("本机同步服务响应超时");
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

function renderBoardManager() {
  const enabledCount = state.boards.filter((board) => board.enabled).length;
  elements.boardEnabledCount.textContent = `每天同步 ${enabledCount} / ${state.boards.length}`;
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
        <span class="board-state">${board.enabled ? "每日同步" : "已忽略"}</span>
        <label class="board-toggle">
          <input type="checkbox" data-board-toggle="${escapeHtml(board.id)}" aria-label="每天同步 ${escapeHtml(board.name)}" ${board.enabled ? "checked" : ""} ${state.boardUpdatePending ? "disabled" : ""} />
          <span class="board-toggle-track" aria-hidden="true"><i></i></span>
        </label>
      </div>`;
  }).join("");
}

async function initBoardManager() {
  try {
    const runtimeResponse = await fetch("./.local/bridge.json", { cache: "no-store" });
    if (!runtimeResponse.ok) throw new Error("本机同步服务尚未连接");
    state.localBridge = validateLocalBridgeConfig(await runtimeResponse.json());
    const session = await localBridgeRequest("/local-session");
    state.localBridge.token = validateLocalBridgeSession(session);
    const payload = await localBridgeRequest("/boards");
    state.boards = payload.boards;
    renderBoardManager();
  } catch (error) {
    state.localBridge = null;
    elements.boardEnabledCount.textContent = "仅限本机";
    elements.boardList.innerHTML = '<div class="board-empty">在本机运行 FavSense 后，这里会显示你的全部收藏夹和每日同步开关。</div>';
    elements.boardManagerStatus.textContent = error.message === "本机同步服务尚未连接"
      ? "当前是公开预览；账号与收藏夹设置不会上传。"
      : "暂时无法连接本机同步服务，请确认 FavSense 已启动。";
  }
}

function filteredNotes() {
  const query = state.query.toLocaleLowerCase("zh-CN").trim();
  const notes = state.data.notes.filter((note) => {
    const haystack = [note.title, note.author, note.category, note.summary, note.deepSummary, note.action, ...note.themes, ...note.tools].join(" ").toLocaleLowerCase("zh-CN");
    return (!query || haystack.includes(query))
      && (state.category === "all" || note.category === state.category)
      && (state.kind === "all" || note.kind === state.kind);
  });

  if (state.sort === "newest") return notes.sort((a, b) => String(b.publishedAt).localeCompare(String(a.publishedAt)));
  if (state.sort === "popular") return notes.sort((a, b) => parseMetric(b.collections) - parseMetric(a.collections));
  return notes.sort((a, b) => a.number - b.number);
}

function renderCategories() {
  const buttons = [{ name: "all", label: "全部主题", count: state.data.notes.length }, ...state.data.categories.map((item) => ({ ...item, label: item.name }))];
  elements.categoryList.innerHTML = buttons.map((item) => `
    <button class="category-button ${state.category === item.name ? "is-active" : ""}" style="--accent:${categoryAccent(item.name)}" type="button" data-category="${escapeHtml(item.name)}">
      <span class="category-name"><i aria-hidden="true"></i>${escapeHtml(item.label)}</span><span>${item.count}</span>
    </button>
  `).join("");

  const kinds = [...new Set(state.data.notes.map((note) => note.kind))];
  const kindDescriptions = state.data.meta.kindLabels || {};
  elements.kindFilter.innerHTML = [{ value: "all", label: "全部" }, ...kinds.map((value) => ({ value, label: value }))].map((item) => `
    <button class="kind-button ${state.kind === item.value ? "is-active" : ""}" type="button" data-kind="${escapeHtml(item.value)}" title="${escapeHtml(kindDescriptions[item.value] || "显示全部内容形态")}">${escapeHtml(item.label)}</button>
  `).join("");

}

function noteCard(note) {
  const tools = note.tools.slice(0, 4).map((tool) => `<span class="tool-chip">${escapeHtml(tool)}</span>`).join("");
  return `
    <article class="note-card" style="--accent:${categoryAccent(note.category)}" data-note-id="${escapeHtml(note.id)}" data-kind="${escapeHtml(note.kind)}">
      <div class="card-strip"><span class="card-kind">${escapeHtml(note.category)} · ${escapeHtml(note.kind)}</span></div>
      <div class="card-body">
        <h3 class="card-title">${escapeHtml(note.title)}</h3>
        <p class="card-summary">${escapeHtml(note.summary)}</p>
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
  const labels = [state.category !== "all" ? state.category : "全部知识卡", state.kind !== "all" ? state.kind : ""].filter(Boolean);
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
  const filtered = state.data.resources
    .filter((resource) => state.resourceType === "all" || resourceGroup(resource, radar) === state.resourceType)
    .filter((resource) => !query || [resource.name, resource.type, resource.description, resourceGroup(resource, radar), ...(resource.aliases || []), ...(resource.attributes || []).flatMap((attribute) => [attribute.label, attribute.value])].join(" ").toLocaleLowerCase("zh-CN").includes(query));
  const resources = sortResources(filtered, state.resourceSort, radar);
  elements.resourcesGrid.innerHTML = resources.map(resourceCard).join("");
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

function renderDetail(note) {
  const radar = state.data.meta.resourceIndex;
  const resources = resourceMap();
  const matchedResources = (note.resources || []).map((name) => resources.get(name)).filter(Boolean);
  const resourceHtml = matchedResources.length ? `
    <section class="detail-section"><h3>${escapeHtml(radar.detail_label || "相关资源")}</h3><div class="detail-resources">
      ${matchedResources.map((resource) => {
        const action = resource.actions.find((item) => safeUrl(item.url) !== "#");
        return `<div class="detail-resource"><strong>${escapeHtml(resource.name)}</strong><span>${escapeHtml(resource.metricIcon || radar.metric?.icon || "◆")} ${escapeHtml(resource.metric || radar.metric?.missing || "暂无数据")}</span>${action ? `<a href="${safeUrl(action.url)}" target="_blank" rel="noreferrer">${escapeHtml(action.label)}</a>` : ""}</div>`;
      }).join("")}
    </div></section>
  ` : "";
  const actionHtml = note.kind === "Note" ? "" : `
    <section class="detail-section"><h3>具体用法</h3><div class="action-box"><span>下一步</span><p>${escapeHtml(note.action)}</p></div></section>
  `;
  const tags = [...note.themes, ...note.tools];
  const tagsHtml = tags.length ? `
    <section class="detail-section"><h3>相关主题与工具</h3><div class="tools-row">${tags.map((item) => `<span class="tool-chip">${escapeHtml(item)}</span>`).join("")}</div></section>
  ` : "";

  elements.dialog.style.setProperty("--accent", categoryAccent(note.category));
  elements.dialogContent.innerHTML = `
    <p class="detail-kicker"><i></i> ${escapeHtml(note.category)} · ${escapeHtml(note.kind)}</p>
    <h2 class="detail-title">${escapeHtml(note.title)}</h2>
    <div class="detail-meta"><span>${escapeHtml(note.author || "作者未记录")}</span><span>${escapeHtml(formatDate(note.publishedAt))}</span></div>
    <section class="detail-section"><h3>${note.kind === "Note" ? "原帖摘要" : "核心结论"}</h3><p>${escapeHtml(note.deepSummary)}</p></section>
    ${actionHtml}
    ${resourceHtml}
    ${tagsHtml}
    <section class="detail-section"><h3>整理依据</h3><p>${escapeHtml(note.evidence.method)}。原视频和分析画面只保存在本机，不进入公开页面。</p></section>
    <footer class="detail-footer">
      <a href="${safeUrl(note.sourceUrl, ["xiaohongshu.com"])}" target="_blank" rel="noreferrer">打开原帖</a>
      <button type="button" data-copy-note="${escapeHtml(note.id)}">复制卡片链接</button>
    </footer>
  `;
}

function openNote(noteId, updateHash = true) {
  const note = state.data.notes.find((item) => item.id === noteId);
  if (!note) return;
  renderDetail(note);
  if (typeof elements.dialog.showModal === "function") elements.dialog.showModal();
  else elements.dialog.setAttribute("open", "");
  if (updateHash) history.replaceState(null, "", `#note=${encodeURIComponent(noteId)}`);
}

function closeDialog() {
  if (elements.dialog.open) elements.dialog.close();
  history.replaceState(null, "", location.pathname + location.search);
}

function clearFilters() {
  state.query = "";
  state.category = "all";
  state.kind = "all";
  elements.searchInput.value = "";
  renderCategories();
  renderNotes();
}

function setView(view) {
  state.view = view;
  document.querySelectorAll("[data-panel]").forEach((panel) => { panel.hidden = panel.dataset.panel !== view; });
  document.querySelectorAll("[data-view]").forEach((button) => button.classList.toggle("is-active", button.dataset.view === view));
  updateHeroVisibility();
  if (view === "resources") renderResources();
  const destination = view === "notes" ? elements.hero : document.querySelector(`[data-panel="${view}"]`);
  window.scrollTo({ top: destination.offsetTop - 80, behavior: "smooth" });
}

function updateHeroVisibility() {
  const isNotesView = state.view === "notes";
  elements.hero.hidden = !isNotesView;
}

function bindEvents() {
  document.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", () => setView(button.dataset.view)));
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
  elements.searchInput.addEventListener("input", () => { state.query = elements.searchInput.value; renderNotes(); });
  elements.resourceSearch.addEventListener("input", () => { state.resourceQuery = elements.resourceSearch.value; renderResources(); });
  elements.resourceTypeFilter.addEventListener("change", () => {
    state.resourceType = elements.resourceTypeFilter.value;
    renderResourceSortOptions();
    renderResources();
  });
  elements.resourceSort.addEventListener("change", () => { state.resourceSort = elements.resourceSort.value; renderResources(); });
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
      state.boards = payload.boards;
      elements.boardManagerStatus.textContent = "设置已保存；下次自动同步会使用新的收藏夹范围。";
      showToast(enabled ? `已开启「${board.name}」每日同步` : `已忽略「${board.name}」`);
    } catch (error) {
      try {
        const authoritative = await localBridgeRequest("/boards");
        state.boards = authoritative.boards;
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
    state.layout = state.layout === "grid" ? "list" : "grid";
    localStorage.setItem("xhs-kb-layout", state.layout);
    elements.viewToggle.setAttribute("aria-label", state.layout === "grid" ? "切换列表视图" : "切换卡片视图");
    renderNotes();
  });
  elements.notesGrid.addEventListener("click", (event) => {
    const openButton = event.target.closest("[data-open-note]");
    const card = event.target.closest("[data-note-id]");
    if (openButton || card) openNote((openButton || card).dataset.openNote || card.dataset.noteId);
  });
  elements.dialogContent.addEventListener("click", async (event) => {
    const copyButton = event.target.closest("[data-copy-note]");
    if (!copyButton) return;
    const url = `${location.origin}${location.pathname}#note=${encodeURIComponent(copyButton.dataset.copyNote)}`;
    try { await navigator.clipboard.writeText(url); showToast("卡片链接已复制"); }
    catch { showToast("浏览器未允许复制，请复制地址栏链接"); }
  });
  document.querySelector("#dialog-close").addEventListener("click", closeDialog);
  elements.dialog.addEventListener("click", (event) => { if (event.target === elements.dialog) closeDialog(); });
  elements.dialog.addEventListener("close", () => history.replaceState(null, "", location.pathname + location.search));
  document.querySelector("#clear-filters").addEventListener("click", clearFilters);
  document.querySelector("#empty-clear").addEventListener("click", clearFilters);
  document.querySelector("#theme-toggle").addEventListener("click", () => {
    const dark = document.documentElement.dataset.theme !== "dark";
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    localStorage.setItem("xhs-kb-theme-xhs", dark ? "dark" : "light");
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
  const savedTheme = localStorage.getItem("xhs-kb-theme-xhs");
  document.documentElement.dataset.theme = savedTheme === "dark" ? "dark" : "light";
  updateThemeToggle();
  updateHeroVisibility();

  try {
    const response = await fetch(DATA_URL);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    state.data = await response.json();
  } catch (error) {
    elements.notesGrid.innerHTML = `<div class="empty-state"><span>知识数据没有加载成功</span><p>${escapeHtml(error.message)}。请通过本地 HTTP 服务打开站点，而不是直接双击 HTML。</p></div>`;
    return;
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
  document.title = `FavSense · 拾光台 · ${state.data.meta.title}`;
  const description = document.querySelector('meta[name="description"]');
  if (description) description.content = state.data.meta.description;
  document.querySelector("#hero-eyebrow").textContent = state.data.meta.hero?.eyebrow || `本期片场 · ${state.data.meta.sourceBoard}`;
  document.querySelector("#hero-from").textContent = state.data.meta.hero?.from || "收藏过";
  document.querySelector("#hero-to").textContent = state.data.meta.hero?.to || "判断过";
  document.querySelector("#hero-intro").textContent = state.data.meta.hero?.intro || state.data.meta.description;
  if (!state.data.meta.resourceIndexEnabled) {
    document.querySelector("#resources-nav").hidden = true;
    document.querySelector("#proof-resources-cell").hidden = true;
  }

  renderCategories();
  renderNotes();
  renderResourceControls();
  renderResources();
  bindEvents();
  await initBoardManager();

  const noteId = new URLSearchParams(location.hash.slice(1)).get("note");
  if (noteId) openNote(noteId, false);
}

init();
