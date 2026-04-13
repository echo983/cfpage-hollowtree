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
        <span>${item.nbssfid || "inline"}</span>
      </div>
      <div class="snippet">${escapeHtml(item.text || "")}</div>
    </article>
  `).join("");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
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
      </div>
      <div class="detail-actions">
        <a href="/">返回搜索</a>
      </div>
    </div>
    <div class="detail-body">${escapeHtml(item.bodyText || item.text || "")}</div>
  `;
}

async function loadDetail(noteId, status) {
  status.textContent = "加载详情中...";
  const detail = document.getElementById("detail");
  const results = document.getElementById("results");
  results.innerHTML = "";
  try {
    const payload = await fetchJson(`/api/notes/${encodeURIComponent(noteId)}`);
    renderDetail(payload);
    status.textContent = "详情已加载";
  } catch (error) {
    detail.classList.remove("hidden");
    detail.innerHTML = `<div class="hero empty">加载详情失败：${escapeHtml(error.message)}</div>`;
    status.textContent = "详情加载失败";
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
  renderAuth(me);

  const url = new URL(window.location.href);
  const noteId = url.searchParams.get("note");
  if (noteId) {
    await loadDetail(noteId, status);
    return;
  }

  const form = document.getElementById("search-form");
  const input = document.getElementById("query-input");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const query = input.value.trim();
    if (!query) return;
    status.textContent = "搜索中...";
    try {
      const result = await fetchJson("/api/search", {
        method: "POST",
        body: JSON.stringify({ query, limit: 8, vectorLimit: 30 }),
      });
      status.textContent = `命中 ${result.resultCount} 条`;
      renderResults(result);
    } catch (error) {
      status.textContent = `搜索失败：${error.message}`;
    }
  });
}

boot();
