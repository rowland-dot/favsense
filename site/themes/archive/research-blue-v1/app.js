const DATA_URL = new URL("./data/knowledge.json", import.meta.url);

const elements = {
  notesGrid: document.querySelector("#notes-grid"),
  emptyState: document.querySelector("#empty-state"),
  resultCount: document.querySelector("#result-count"),
  activeFilterLabel: document.querySelector("#active-filter-label"),
  categoryList: document.querySelector("#category-list"),
  priorityFilter: document.querySelector("#priority-filter"),
  kindFilter: document.querySelector("#kind-filter"),
  searchInput: document.querySelector("#search-input"),
  projectSearch: document.querySelector("#project-search"),
  projectsGrid: document.querySelector("#projects-grid"),
  sortSelect: document.querySelector("#sort-select"),
  viewToggle: document.querySelector("#view-toggle"),
  dialog: document.querySelector("#detail-dialog"),
  dialogContent: document.querySelector("#dialog-content"),
  toast: document.querySelector("#toast")
};

const state = {
  data: null,
  view: "notes",
  query: "",
  projectQuery: "",
  category: "all",
  priority: "all",
  kind: "all",
  sort: "curated",
  layout: localStorage.getItem("xhs-kb-layout") || "grid",
  saved: new Set(JSON.parse(localStorage.getItem("xhs-kb-saved") || "[]"))
};

const categoryColors = ["#3158e8", "#ff5965", "#28a783", "#8069e8", "#d18b19", "#517092", "#bd4f98", "#45858a"];

function escapeHtml(value = "") {
  return String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
}

function safeUrl(value, allowedHosts) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !allowedHosts.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`))) return "#";
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

function formatDate(value) {
  if (!value) return "日期未记录";
  const normalized = value.replace("_", "T");
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return value.slice(0, 10);
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "short", day: "numeric" }).format(date);
}

function projectMap() {
  return new Map(state.data.projects.map((project) => [project.name, project]));
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add("is-visible");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => elements.toast.classList.remove("is-visible"), 2200);
}

function persistSaved() {
  localStorage.setItem("xhs-kb-saved", JSON.stringify([...state.saved]));
}

function filteredNotes() {
  const query = state.query.toLocaleLowerCase("zh-CN").trim();
  const notes = state.data.notes.filter((note) => {
    const haystack = [note.title, note.author, note.category, note.summary, note.deepSummary, note.action, ...note.themes, ...note.tools].join(" ").toLocaleLowerCase("zh-CN");
    return (!query || haystack.includes(query))
      && (state.category === "all" || note.category === state.category)
      && (state.priority === "all" || note.priority === state.priority)
      && (state.kind === "all" || note.kind === state.kind);
  });

  if (state.sort === "priority") return notes.sort((a, b) => a.priority.localeCompare(b.priority) || a.number - b.number);
  if (state.sort === "newest") return notes.sort((a, b) => String(b.publishedAt).localeCompare(String(a.publishedAt)));
  if (state.sort === "popular") return notes.sort((a, b) => parseMetric(b.collections) - parseMetric(a.collections));
  return notes.sort((a, b) => a.number - b.number);
}

function renderCategories() {
  const buttons = [{ name: "all", label: "全部主题", count: state.data.notes.length }, ...state.data.categories.map((item) => ({ ...item, label: item.name }))];
  elements.categoryList.innerHTML = buttons.map((item) => `
    <button class="category-button ${state.category === item.name ? "is-active" : ""}" type="button" data-category="${escapeHtml(item.name)}">
      <span>${escapeHtml(item.label)}</span><span>${item.count}</span>
    </button>
  `).join("");

  const kinds = [...new Set(state.data.notes.map((note) => note.kind))];
  elements.kindFilter.innerHTML = [{ value: "all", label: "全部" }, ...kinds.map((value) => ({ value, label: value }))].map((item) => `
    <button class="kind-button ${state.kind === item.value ? "is-active" : ""}" type="button" data-kind="${escapeHtml(item.value)}">${escapeHtml(item.label)}</button>
  `).join("");
}

function noteCard(note) {
  const saved = state.saved.has(note.id);
  const tools = note.tools.slice(0, 4).map((tool) => `<span class="tool-chip">${escapeHtml(tool)}</span>`).join("");
  return `
    <article class="note-card" data-note-id="${escapeHtml(note.id)}">
      <button class="bookmark-button ${saved ? "is-saved" : ""}" type="button" data-save-note="${escapeHtml(note.id)}" aria-label="${saved ? "取消保存" : "保存知识卡"}" title="${saved ? "取消保存" : "保存知识卡"}">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h12v19l-6-4-6 4V3Z" /></svg>
      </button>
      <div class="card-strip"><span class="card-number">FRAME ${String(note.number).padStart(2, "0")}</span><span class="priority-badge" data-priority="${escapeHtml(note.priority)}">${escapeHtml(note.priority)}</span></div>
      <div class="card-body">
        <p class="card-category">${escapeHtml(note.category)} · ${escapeHtml(note.kind)}</p>
        <h3 class="card-title">${escapeHtml(note.title)}</h3>
        <p class="card-summary">${escapeHtml(note.summary)}</p>
        <div class="tools-row">${tools}</div>
      </div>
      <footer class="card-footer">
        <span class="card-metrics"><span>♥ ${escapeHtml(displayMetric(note.likes))}</span><span>收藏 ${escapeHtml(displayMetric(note.collections))}</span></span>
        <button class="card-open" type="button" data-open-note="${escapeHtml(note.id)}">查看判断</button>
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
  const labels = [state.category !== "all" ? state.category : "全部知识卡", state.priority !== "all" ? `${state.priority} 级` : "", state.kind !== "all" ? state.kind : ""].filter(Boolean);
  elements.activeFilterLabel.textContent = labels.join(" · ");
}

const statusLabels = {
  priority: "优先验证", candidate: "候选", review: "逐项审查", restricted: "受限验证", reference: "参考索引",
  "research-only": "仅研究", commercial: "商业产品", "unverified-stars": "Star 待核实"
};

function projectCard(project, index) {
  const repo = safeUrl(project.repo, ["github.com"]);
  const download = safeUrl(project.download, ["github.com"]);
  return `
    <article class="project-card" style="--project-accent:${categoryColors[index % categoryColors.length]}">
      <div class="project-top"><span class="project-type">${escapeHtml(project.type)}</span><span class="star-count">★ ${escapeHtml(project.stars || "待核实")}</span></div>
      <h3>${escapeHtml(project.name)}</h3>
      <p class="project-risk">${escapeHtml(project.risk)}</p>
      <span class="project-status">${escapeHtml(statusLabels[project.status] || project.status)}</span>
      <div class="project-actions"><a href="${repo}" target="_blank" rel="noreferrer">官方仓库</a><a href="${download}" target="_blank" rel="noreferrer">下载 ZIP</a></div>
    </article>
  `;
}

function renderProjects() {
  const query = state.projectQuery.toLocaleLowerCase("zh-CN").trim();
  const projects = state.data.projects
    .filter((project) => !query || [project.name, project.type, project.risk, project.status].join(" ").toLocaleLowerCase("zh-CN").includes(query))
    .sort((a, b) => (b.stars_numeric || -1) - (a.stars_numeric || -1));
  elements.projectsGrid.innerHTML = projects.map(projectCard).join("");
}

function renderDetail(note) {
  const projects = projectMap();
  const matchedProjects = note.projects.map((name) => projects.get(name)).filter(Boolean);
  const projectHtml = matchedProjects.length ? `
    <section class="detail-section"><h3>官方项目核验</h3><div class="detail-projects">
      ${matchedProjects.map((project) => `<div class="detail-project"><strong>${escapeHtml(project.name)}</strong><span>★ ${escapeHtml(project.stars || "待核实")}</span><a href="${safeUrl(project.repo, ["github.com"])}" target="_blank" rel="noreferrer">GitHub</a></div>`).join("")}
    </div></section>
  ` : "";

  elements.dialogContent.innerHTML = `
    <p class="detail-kicker"><i></i> FRAME ${String(note.number).padStart(2, "0")} · ${escapeHtml(note.category)}</p>
    <h2 class="detail-title">${escapeHtml(note.title)}</h2>
    <div class="detail-meta"><span>${escapeHtml(note.author || "作者未记录")}</span><span>${escapeHtml(formatDate(note.publishedAt))}</span><span>${escapeHtml(note.kind)}</span><span>${escapeHtml(note.priority)} 级价值</span><span>${escapeHtml(note.risk)} risk</span></div>
    <section class="detail-section"><h3>视频核验后的判断</h3><p>${escapeHtml(note.deepSummary)}</p></section>
    <section class="detail-section"><h3>下一步行动</h3><div class="action-box"><span>DO →</span><p>${escapeHtml(note.action)}</p></div></section>
    ${projectHtml}
    <section class="detail-section"><h3>主题与工具</h3><div class="tools-row">${[...note.themes, ...note.tools].map((item) => `<span class="tool-chip">${escapeHtml(item)}</span>`).join("")}</div></section>
    <section class="detail-section"><h3>证据方法</h3><p>${escapeHtml(note.evidence.method)}。原始视频与帧证据仅保存在本机，不进入公开站点。</p></section>
    <footer class="detail-footer">
      <a href="${safeUrl(note.sourceUrl, ["xiaohongshu.com"])}" target="_blank" rel="noreferrer">打开原帖</a>
      <button type="button" data-copy-note="${escapeHtml(note.id)}">复制卡片链接</button>
      <button type="button" data-save-note="${escapeHtml(note.id)}">${state.saved.has(note.id) ? "取消保存" : "保存到本机"}</button>
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
  state.priority = "all";
  state.kind = "all";
  elements.searchInput.value = "";
  document.querySelectorAll("[data-priority]").forEach((button) => button.classList.toggle("is-active", button.dataset.priority === "all"));
  renderCategories();
  renderNotes();
}

function setView(view) {
  state.view = view;
  document.querySelectorAll("[data-panel]").forEach((panel) => { panel.hidden = panel.dataset.panel !== view; });
  document.querySelectorAll("[data-view]").forEach((button) => button.classList.toggle("is-active", button.dataset.view === view));
  if (view === "projects") renderProjects();
  window.scrollTo({ top: document.querySelector(`[data-panel="${view}"]`).offsetTop - 80, behavior: "smooth" });
}

function toggleSaved(noteId) {
  if (state.saved.has(noteId)) {
    state.saved.delete(noteId);
    showToast("已从本机收藏中移除");
  } else {
    state.saved.add(noteId);
    showToast("已保存在当前浏览器");
  }
  persistSaved();
  renderNotes();
  const note = state.data.notes.find((item) => item.id === noteId);
  if (elements.dialog.open && note) renderDetail(note);
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
  elements.priorityFilter.addEventListener("click", (event) => {
    const button = event.target.closest("[data-priority]");
    if (!button) return;
    state.priority = button.dataset.priority;
    elements.priorityFilter.querySelectorAll("button").forEach((item) => item.classList.toggle("is-active", item === button));
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
  elements.projectSearch.addEventListener("input", () => { state.projectQuery = elements.projectSearch.value; renderProjects(); });
  elements.sortSelect.addEventListener("change", () => { state.sort = elements.sortSelect.value; renderNotes(); });
  elements.viewToggle.addEventListener("click", () => {
    state.layout = state.layout === "grid" ? "list" : "grid";
    localStorage.setItem("xhs-kb-layout", state.layout);
    elements.viewToggle.setAttribute("aria-label", state.layout === "grid" ? "切换列表视图" : "切换卡片视图");
    renderNotes();
  });
  elements.notesGrid.addEventListener("click", (event) => {
    const saveButton = event.target.closest("[data-save-note]");
    if (saveButton) return toggleSaved(saveButton.dataset.saveNote);
    const openButton = event.target.closest("[data-open-note]");
    const card = event.target.closest("[data-note-id]");
    if (openButton || card) openNote((openButton || card).dataset.openNote || card.dataset.noteId);
  });
  elements.dialogContent.addEventListener("click", async (event) => {
    const saveButton = event.target.closest("[data-save-note]");
    if (saveButton) return toggleSaved(saveButton.dataset.saveNote);
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
    localStorage.setItem("xhs-kb-theme", dark ? "dark" : "light");
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "/" && !/input|textarea|select/i.test(document.activeElement.tagName)) {
      event.preventDefault();
      setView("notes");
      elements.searchInput.focus();
    }
  });
}

async function init() {
  const savedTheme = localStorage.getItem("xhs-kb-theme");
  if (savedTheme) document.documentElement.dataset.theme = savedTheme;
  else if (matchMedia("(prefers-color-scheme: dark)").matches) document.documentElement.dataset.theme = "dark";

  try {
    const response = await fetch(DATA_URL);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    state.data = await response.json();
  } catch (error) {
    elements.notesGrid.innerHTML = `<div class="empty-state"><span>知识数据没有加载成功</span><p>${escapeHtml(error.message)}。请通过本地 HTTP 服务打开站点，而不是直接双击 HTML。</p></div>`;
    return;
  }

  const configuredRepository = window.SHIGUANG_CONFIG?.repositoryUrl
    || window.huggingface?.variables?.GITHUB_REPOSITORY_URL
    || "";
  const repositoryUrl = safeUrl(configuredRepository, ["github.com"]);
  const sourceButton = document.querySelector("#source-button");
  if (repositoryUrl !== "#") {
    sourceButton.href = repositoryUrl;
    sourceButton.hidden = false;
  }

  document.querySelector("#stat-notes").textContent = state.data.meta.noteCount;
  document.querySelector("#stat-frames").textContent = new Intl.NumberFormat("zh-CN").format(state.data.meta.frameEvidenceCount);
  document.querySelector("#proof-videos").textContent = state.data.meta.noteCount;
  document.querySelector("#proof-frames").textContent = new Intl.NumberFormat("zh-CN").format(state.data.meta.frameEvidenceCount);
  document.querySelector("#proof-projects").textContent = state.data.meta.projectCount;
  document.querySelector("#project-verified-date").textContent = `Star 核验于 ${state.data.meta.projectsVerifiedAt}`;

  renderCategories();
  renderNotes();
  renderProjects();
  bindEvents();

  const noteId = new URLSearchParams(location.hash.slice(1)).get("note");
  if (noteId) openNote(noteId, false);
}

init();
