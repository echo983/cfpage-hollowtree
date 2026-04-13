const state = {
  me: null,
  query: "",
  page: 1,
  limit: 8,
  bodyMode: "all",
  minRerankScore: 0.15,
  activeTags: [],
  lastResult: null,
};

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    credentials: "include",
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers || {}),
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `http_${response.status}`);
  }
  return data;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function summarizeSnippet(value) {
  const compact = String(value || "")
    .replace(/\s+/g, " ")
    .trim();
  if (compact.length <= 240) {
    return compact;
  }
  return `${compact.slice(0, 240).trimEnd()}...`;
}

function renderTags(tags, clickable = false) {
  const items = Array.isArray(tags) ? tags.filter((item) => typeof item === "string" && item.trim()) : [];
  if (!items.length) {
    return "";
  }
  return `<div class="tag-row">${items.map((tag) => {
    const active = state.activeTags.includes(tag);
    const className = `tag${active ? " active" : ""}${clickable ? " tag-filter" : ""}`;
    if (!clickable) {
      return `<span class="${className}">${escapeHtml(tag)}</span>`;
    }
    return `<button type="button" class="${className}" data-tag="${escapeHtml(tag)}">${escapeHtml(tag)}</button>`;
  }).join("")}</div>`;
}

function bindTagFilters(root) {
  root.querySelectorAll("[data-tag]").forEach((node) => {
    node.addEventListener("click", async () => {
      const tag = node.getAttribute("data-tag");
      if (!tag) return;
      state.activeTags = [tag];
      state.page = 1;
      await runSearch();
    });
  });
}

function renderActiveFilters() {
  const root = document.getElementById("active-filters");
  if (!state.activeTags.length) {
    root.classList.add("hidden");
    root.innerHTML = "";
    return;
  }
  root.classList.remove("hidden");
  root.innerHTML = `
    <div class="filter-bar">
      <span class="meta">标签过滤</span>
      ${renderTags(state.activeTags)}
      <button type="button" id="clear-tag-filter-btn" class="clear-filter-btn">清除</button>
    </div>
  `;
  document.getElementById("clear-tag-filter-btn")?.addEventListener("click", async () => {
    state.activeTags = [];
    state.page = 1;
    await runSearch();
  });
}

function renderAuth(me) {
  const area = document.getElementById("auth-area");
  if (!me || !me.ok || !me.authenticated) {
    area.innerHTML = `
      <div class="auth-box">
        <a class="login-btn" href="/auth/google/login">使用 Google 登录</a>
      </div>
    `;
    return;
  }
  area.innerHTML = `
    <div class="auth-box">
      <div><strong>${me.email || ""}</strong></div>
      <div class="meta">namespace: ${me.namespaceId || ""}</div>
      <button class="logout-btn" id="logout-btn">退出</button>
    </div>
  `;
  document.getElementById("logout-btn").addEventListener("click", async () => {
    await fetch("/auth/logout", { method: "POST", credentials: "include" });
    window.location.reload();
  });
}

function renderResults(payload) {
  const root = document.getElementById("results");
  const items = payload.items || [];
  if (!items.length) {
    root.innerHTML = `<div class="hero empty">没有结果</div>`;
    return;
  }
  root.innerHTML = items.map((item) => `
    <article class="result-card">
      <h2><a href="/?note=${encodeURIComponent(item.id)}">${escapeHtml(item.meta?.title || item.meta?.sourceId || item.id)}</a></h2>
      <div class="score-row">
        <span>rerank: ${item.rerankScore?.toFixed ? item.rerankScore.toFixed(4) : item.rerankScore}</span>
        <span>vector: ${item.score?.toFixed ? item.score.toFixed(4) : item.score}</span>
        <span>${item.meta?.createdAt || ""}</span>
        <span>${item.nbssfid ? "长文" : "短文"}</span>
      </div>
      ${renderTags(item.meta?.tags, true)}
      <div class="snippet">${escapeHtml(summarizeSnippet(item.text || ""))}</div>
    </article>
  `).join("");
  bindTagFilters(root);
}

function renderPagination(payload) {
  const root = document.getElementById("pagination");
  if (!payload || !payload.totalCount) {
    root.classList.add("hidden");
    root.innerHTML = "";
    return;
  }
  const from = (payload.page - 1) * payload.limit + 1;
  const to = from + (payload.items?.length || 0) - 1;
  root.classList.remove("hidden");
  root.innerHTML = `
    <div class="meta">第 ${payload.page} 页 · 显示 ${from}-${Math.max(from, to)} / ${payload.totalCount} 条</div>
    <div class="pagination-actions">
      <button id="prev-page-btn" ${payload.page <= 1 ? "disabled" : ""}>上一页</button>
      <button id="next-page-btn" ${payload.hasMore ? "" : "disabled"}>下一页</button>
    </div>
  `;
  document.getElementById("prev-page-btn")?.addEventListener("click", () => {
    if (state.page > 1) {
      state.page -= 1;
      runSearch();
    }
  });
  document.getElementById("next-page-btn")?.addEventListener("click", () => {
    if (payload.hasMore) {
      state.page += 1;
      runSearch();
    }
  });
}

function renderDetail(payload) {
  const root = document.getElementById("detail");
  const item = payload.item;
  if (!item) {
    root.classList.remove("hidden");
    root.innerHTML = `<div class="hero empty">没有找到这条笔记</div>`;
    return;
  }
  root.classList.remove("hidden");
  root.innerHTML = `
    <div class="detail-header">
      <div>
        <h2 class="detail-title">${escapeHtml(item.meta?.title || item.meta?.sourceId || item.id)}</h2>
        <div class="detail-meta">
          <span>${escapeHtml(item.meta?.createdAt || "")}</span>
          <span>${escapeHtml(item.meta?.sourceType || "")}</span>
          <span>${escapeHtml(item.nbssfid || "inline")}</span>
          <span>${escapeHtml(item.bodySource || "inline")}</span>
        </div>
        ${renderTags(item.meta?.tags, true)}
      </div>
      <div class="detail-actions">
        <a href="/">返回搜索</a>
      </div>
    </div>
    <div class="detail-body">${escapeHtml(item.bodyText || item.text || "")}</div>
  `;
  bindTagFilters(root);
}

function clearDetailView() {
  const detail = document.getElementById("detail");
  detail.classList.add("hidden");
  detail.innerHTML = "";
}

function syncControlsFromState() {
  document.getElementById("limit-select").value = String(state.limit);
  document.getElementById("body-mode-select").value = state.bodyMode;
  document.getElementById("min-score-input").value = String(state.minRerankScore);
}

function clearResultsView() {
  document.getElementById("results").innerHTML = "";
  document.getElementById("pagination").classList.add("hidden");
  document.getElementById("pagination").innerHTML = "";
  renderActiveFilters();
}

async function loadDetail(noteId, status) {
  status.textContent = "加载详情中...";
  clearResultsView();
  try {
    const payload = await fetchJson(`/api/notes/${encodeURIComponent(noteId)}`);
    renderDetail(payload);
    status.textContent = "详情已加载";
  } catch (error) {
    const detail = document.getElementById("detail");
    detail.classList.remove("hidden");
    detail.innerHTML = `<div class="hero empty">加载详情失败：${escapeHtml(error.message)}</div>`;
    status.textContent = "详情加载失败";
  }
}

async function runSearch() {
  const status = document.getElementById("status");
  if (!state.query) return;
  status.textContent = "搜索中...";
  clearDetailView();
  const url = new URL(window.location.href);
  url.searchParams.delete("note");
  window.history.replaceState({}, "", url.toString());
  try {
    const vectorLimit = Math.min(Math.max((state.page * state.limit * 4), 30), 50);
    const result = await fetchJson("/api/search", {
      method: "POST",
      body: JSON.stringify({
        query: state.query,
        page: state.page,
      limit: state.limit,
      vectorLimit,
      minRerankScore: state.minRerankScore,
      bodyMode: state.bodyMode,
      tags: state.activeTags,
      }),
    });
    state.lastResult = result;
    const suffix = state.activeTags.length ? `，标签：${state.activeTags.join(" / ")}` : "";
    status.textContent = `命中 ${result.totalCount} 条，第 ${result.page} 页${suffix}`;
    renderActiveFilters();
    renderResults(result);
    renderPagination(result);
  } catch (error) {
    clearResultsView();
    status.textContent = `搜索失败：${error.message}`;
  }
}

async function createNote() {
  const status = document.getElementById("status");
  const titleInput = document.getElementById("title-input");
  const bodyInput = document.getElementById("body-input");
  const title = titleInput.value.trim();
  const body = bodyInput.value.trim();
  if (!title) {
    status.textContent = "请先填写标题";
    return;
  }
  if (!body) {
    status.textContent = "请先填写正文";
    return;
  }

  status.textContent = "写入笔记中...";
  try {
    const payload = await fetchJson("/api/notes", {
      method: "POST",
      body: JSON.stringify({ title, body }),
    });
    titleInput.value = "";
    bodyInput.value = "";
    const item = payload.item;
    if (item?.id) {
      const url = new URL(window.location.href);
      url.searchParams.set("note", item.id);
      window.history.replaceState({}, "", url.toString());
      clearResultsView();
      clearDetailView();
      renderDetail({ item });
      status.textContent = "笔记已保存";
      return;
    }
    status.textContent = "笔记已保存";
  } catch (error) {
    status.textContent = `写入失败：${error.message}`;
  }
}

async function createAutoNote() {
  const status = document.getElementById("status");
  const bodyInput = document.getElementById("auto-body-input");
  const body = bodyInput.value.trim();
  if (!body) {
    status.textContent = "请先填写正文";
    return;
  }

  status.textContent = "生成标题和标签中...";
  try {
    const payload = await fetchJson("/api/notes/auto", {
      method: "POST",
      body: JSON.stringify({ body }),
    });
    bodyInput.value = "";
    const item = payload.item;
    if (item?.id) {
      const url = new URL(window.location.href);
      url.searchParams.set("note", item.id);
      window.history.replaceState({}, "", url.toString());
      clearResultsView();
      clearDetailView();
      renderDetail({ item });
      const tags = Array.isArray(item.meta?.tags) && item.meta.tags.length ? `，标签 ${item.meta.tags.length} 个` : "";
      status.textContent = `半自动笔记已保存${tags}`;
      return;
    }
    status.textContent = "半自动笔记已保存";
  } catch (error) {
    status.textContent = `生成失败：${error.message}`;
  }
}

async function boot() {
  const status = document.getElementById("status");
  let me = null;
  try {
    me = await fetchJson("/api/me");
  } catch {
    me = { ok: true, authenticated: false };
  }
  state.me = me;
  renderAuth(me);
  syncControlsFromState();

  const form = document.getElementById("search-form");
  const createForm = document.getElementById("create-form");
  const autoCreateForm = document.getElementById("auto-create-form");
  const input = document.getElementById("query-input");
  const limitSelect = document.getElementById("limit-select");
  const bodyModeSelect = document.getElementById("body-mode-select");
  const minScoreInput = document.getElementById("min-score-input");
  renderActiveFilters();

  createForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    await createNote();
  });

  autoCreateForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    await createAutoNote();
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const query = input.value.trim();
    if (!query) return;
    state.query = query;
    state.page = 1;
    state.limit = Number(limitSelect.value) || 8;
    state.bodyMode = bodyModeSelect.value || "all";
    state.minRerankScore = Number(minScoreInput.value);
    if (!Number.isFinite(state.minRerankScore) || state.minRerankScore < 0) {
      state.minRerankScore = 0.15;
    }
    await runSearch();
  });

  limitSelect.addEventListener("change", async () => {
    state.limit = Number(limitSelect.value) || 8;
    state.page = 1;
    if (state.query) {
      await runSearch();
    }
  });

  bodyModeSelect.addEventListener("change", async () => {
    state.bodyMode = bodyModeSelect.value || "all";
    state.page = 1;
    if (state.query) {
      await runSearch();
    }
  });

  minScoreInput.addEventListener("change", async () => {
    const value = Number(minScoreInput.value);
    state.minRerankScore = Number.isFinite(value) && value >= 0 ? value : 0.15;
    state.page = 1;
    if (state.query) {
      await runSearch();
    }
  });

  const url = new URL(window.location.href);
  const noteId = url.searchParams.get("note");
  if (noteId) {
    await loadDetail(noteId, status);
    return;
  }
}

boot();
