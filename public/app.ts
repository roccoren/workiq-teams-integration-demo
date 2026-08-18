// Browser app for the WorkIQ Query & Use demo.
// No framework: plain TypeScript, streamed SSE chat, markdown-lite rendering.

interface Citation { id: string; index: number; kind: string; title: string; author?: string; date?: string; url: string; snippet: string; context?: string; sensitivityLabel?: string }
interface AskResult { answer: string; citations: Citation[]; conversationId?: string; engine: "live" | "mock"; durationMs: number; account?: string; agent?: { name?: string } }
interface Meta { app: { name: string }; mode: "live" | "mock"; engine: { label: string; detail: string; account?: string; degraded?: boolean; degradedReason?: string }; warnings: string[]; suggestedPrompts: string[]; teamsBot: { enabled: boolean }; accounts: { list: string[]; default: string | null; mappedUsers: number }; sso?: { enabled: boolean; configured: boolean; identity?: { name?: string; upn?: string } } }

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

let meta: Meta | null = null;
let conversationId: string | undefined;
let currentAccount: string | undefined;
let lastCitations: Citation[] = [];
let lastAnswer = "";
let lastQuestion = "";
let brief: { question: string; answer: string; citations: Citation[] }[] = [];

// ---------- Teams SSO ----------
// The Teams host mints a token for this app; the server exchanges it (On-Behalf-Of)
// for a per-user Work IQ token. Everything here degrades to anonymous calls — without
// a token the server keeps answering with its own credentials.
const TOKEN_REFRESH_SKEW_MS = 5 * 60_000;
let ssoToken = "";
let ssoExpiresAt = 0; // epoch ms, from the JWT `exp` claim
let ssoFailure = ""; // why SSO is off; surfaced once in the notice bar
let ssoNoticeShown = false;
let requestTeamsToken: (() => Promise<string>) | null = null; // set by initTeams()

// Reads `exp` out of a JWT without validating it — the server does the validation.
function jwtExpiry(token: string): number {
  const payload = token.split(".")[1];
  if (!payload) return 0;
  const b64 = payload.replace(/-/g, "+").replace(/_/g, "/");
  try {
    const claims = JSON.parse(atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4)));
    return typeof claims.exp === "number" ? claims.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

async function ssoAccessToken(force = false): Promise<string> {
  if (!requestTeamsToken) return "";
  if (!force && ssoToken && Date.now() < ssoExpiresAt - TOKEN_REFRESH_SKEW_MS) return ssoToken;
  try {
    ssoToken = await requestTeamsToken();
    // A token whose exp is unreadable is still usable; just re-request it sooner.
    ssoExpiresAt = jwtExpiry(ssoToken) || Date.now() + 30 * 60_000;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    requestTeamsToken = null; // one failure is enough: stop asking the host
    ssoToken = "";
    ssoExpiresAt = 0;
    ssoFailure = /consent/i.test(msg)
      ? "Teams SSO needs your consent — accept the app permissions in Teams and reload."
      : "Teams SSO is unavailable — queries run with the demo's shared Work IQ account.";
    console.warn("[sso] getAuthToken failed:", msg);
  }
  return ssoToken;
}

// The single place an Authorization header is attached. A 401 is retried exactly once:
// with a freshly minted token, or anonymously when Work IQ still needs user consent.
async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  await teamsReady;
  const send = (token: string): Promise<Response> => {
    const headers = new Headers(init.headers);
    if (token) headers.set("Authorization", `Bearer ${token}`);
    return fetch(path, { ...init, headers });
  };
  const token = await ssoAccessToken();
  const res = await send(token);
  if (res.status !== 401) return res;
  const detail = (await res.clone().json().catch(() => null)) as { code?: string; hint?: string } | null;
  if (detail?.code === "OBO_CONSENT_REQUIRED") {
    requestTeamsToken = null;
    ssoToken = "";
    ssoFailure = detail.hint ?? "Work IQ needs your consent before it can answer with your own identity.";
    showSsoNotice(ssoFailure);
    return send("");
  }
  if (!token) return res;
  return send(await ssoAccessToken(true));
}

// Non-blocking and shown at most once: SSO is optional, the page stays usable without it.
function showSsoNotice(text: string): void {
  if (ssoNoticeShown) return;
  ssoNoticeShown = true;
  const bar = document.createElement("div");
  bar.className = "sso-notice";
  bar.innerHTML = `<span>🔐 ${esc(text)}</span>`;
  const close = document.createElement("button");
  close.className = "sso-notice-close";
  close.title = "Dismiss";
  close.textContent = "✕";
  close.addEventListener("click", () => bar.remove());
  bar.appendChild(close);
  $("topbar").after(bar);
}

// Signed-in user, rendered as one more chip in the existing top-bar badge row.
function renderSsoIdentity(identity?: { name?: string; upn?: string }): void {
  let chip = document.getElementById("sso-identity");
  if (!identity) { chip?.remove(); return; }
  if (!chip) {
    chip = document.createElement("span");
    chip.id = "sso-identity";
    chip.className = "badge sso-chip";
    $("mode-badge").before(chip);
  }
  chip.textContent = `👤 ${identity.name ?? identity.upn ?? "signed in"}`;
  chip.title = identity.upn ? `Signed in with Teams SSO as ${identity.upn}` : "Signed in with Teams SSO";
}

// ---------- tiny markdown renderer ----------
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function renderInline(s: string): string {
  let out = esc(s);
  out = out.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/\*(.+?)\*/g, "<em>$1</em>");
  out = out.replace(/`(.+?)`/g, "<code>$1</code>");
  // bare links -> anchors
  out = out.replace(/(https?:\/\/[^\s<]+)/g, (m) => {
    if (m.includes("](")) return m;
    return `<a href="${m}" target="_blank" rel="noopener">${m.slice(0, 48)}…</a>`;
  });
  return out;
}
function renderMarkdown(md: string): string {
  const lines = md.split("\n");
  const html: string[] = [];
  let list: string[] | null = null;
  const flushList = () => {
    if (list) { html.push(list[0] === "- " ? `<ul>${list.slice(1).map((l) => `<li>${l}</li>`).join("")}</ul>` : `<ol>${list.slice(1).map((l) => `<li>${l}</li>`).join("")}</ol>`); list = null; }
  };
  for (const line of lines) {
    const m = line.match(/^(#{1,4})\s+(.*)/);
    const l = line.match(/^\s*([-*]|\d+\.)\s+(.*)/);
    if (m) { flushList(); html.push(`<h${m[1].length}>${renderInline(m[2])}</h${m[1].length}>`); }
    else if (l) { if (!list) list = [l[1].match(/\d/) ? "1. " : "- "]; list.push(renderInline(l[2])); }
    else if (!line.trim()) { flushList(); }
    else { flushList(); html.push(`<p>${renderInline(line)}</p>`); }
  }
  flushList();
  return html.join("");
}
// turn [n](url) into citation chips; returns {html, cites: {n, url}[]}
function renderWithCites(md: string): { html: string; cites: { n: number; url: string }[] } {
  const cites: { n: number; url: string }[] = [];
  const html = renderMarkdown(md).replace(/\[(\d+)\]\((https?:\/\/[^)\s]+)\)/g, (_all, n: string, url: string) => {
    cites.push({ n: Number(n), url });
    return ` <sup class="cite" data-n="${n}" data-url="${url}" title="${url}">[${n}]</sup>`;
  });
  return { html, cites };
}

// ---------- chat ----------
const chatEl = $("chat");
const inputEl = $<HTMLTextAreaElement>("input");
const sendBtn = $<HTMLButtonElement>("send");
const chatScroll = $("chat-scroll");

function scrollBottom(): void { chatScroll.scrollTop = chatScroll.scrollHeight; }

function welcome(): void {
  const w = $("welcome");
  if (!w) return;
  const chips = $("suggested");
  chips.innerHTML = "";
  for (const p of meta?.suggestedPrompts ?? []) {
    const b = document.createElement("button");
    b.className = "chip";
    b.textContent = p;
    b.onclick = () => { w.remove(); send(p); };
    chips.appendChild(b);
  }
}

function addUserMsg(text: string): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "msg user";
  wrap.innerHTML = `<div class="avatar">🧑</div><div class="bubble"></div>`;
  wrap.querySelector(".bubble")!.textContent = text;
  chatEl.appendChild(wrap);
  scrollBottom();
  return wrap;
}

function addAssistantMsg(status = "Thinking…"): { bubble: HTMLElement; wrap: HTMLElement } {
  const wrap = document.createElement("div");
  wrap.className = "msg assistant";
  wrap.innerHTML = `<div class="avatar">🧠</div><div class="bubble"><div class="status-line"><span class="status-text">${esc(status)}</span><span class="caret"></span></div></div>`;
  chatEl.appendChild(wrap);
  scrollBottom();
  return { bubble: wrap.querySelector(".bubble") as HTMLElement, wrap };
}

function setStatus(bubble: HTMLElement, text: string): void {
  const st = bubble.querySelector(".status-text");
  if (st) { st.textContent = text; }
}

function finishMessage(wrap: HTMLElement, result: AskResult): void {
  const bubble = wrap.querySelector(".bubble") as HTMLElement;
  const { html } = renderWithCites(result.answer);
  bubble.innerHTML = html;
  const metaRow = document.createElement("div");
  metaRow.className = "msg-meta";
  metaRow.innerHTML = [
    `<span class="engine-tag">${result.engine === "live" ? "Work IQ · live" : "Work IQ · demo"}${result.account ? ` · ${esc(result.account)}` : ""}</span>`,
    `<span>${(result.durationMs / 1000).toFixed(1)}s</span>`,
    `<span>${result.citations.length} sources</span>`,
    '<button data-act="copy">Copy</button>',
    '<button data-act="brief">Save to brief</button>',
  ].join("");
  metaRow.querySelector('[data-act="copy"]')!.addEventListener("click", async () => {
    await navigator.clipboard.writeText(result.answer);
  });
  metaRow.querySelector('[data-act="brief"]')!.addEventListener("click", () => {
    brief.push({ question: lastQuestion, answer: result.answer, citations: result.citations });
    renderBrief();
  });
  bubble.appendChild(metaRow);
  attachCiteHandlers(bubble);
}

function attachCiteHandlers(root: HTMLElement): void {
  root.querySelectorAll<HTMLElement>(".cite").forEach((el) => {
    el.addEventListener("click", () => {
      const n = Number(el.dataset.n);
      const cards = $("sources-list").querySelectorAll<HTMLElement>(".src-card");
      cards.forEach((c) => c.classList.remove("flash"));
      const card = cards[n - 1];
      if (card) { card.classList.add("flash"); card.scrollIntoView({ behavior: "smooth", block: "nearest" }); setTimeout(() => card.classList.remove("flash"), 1200); }
    });
  });
}

function renderSources(): void {
  const list = $("sources-list");
  const count = $("sources-count");
  if (!lastCitations.length) { list.innerHTML = '<div class="empty">Ask a question to see grounded sources.</div>'; count.textContent = ""; return; }
  count.textContent = `${lastCitations.length} grounded`;
  list.innerHTML = "";
  const kinds: Record<string, string> = { document: "📄 Document", email: "✉️ Email", meeting: "🗓 Meeting", chat: "💬 Teams", person: "👤 Person", link: "🔗 Link" };
  for (const c of lastCitations) {
    const card = document.createElement("div");
    card.className = "src-card";
    card.innerHTML = [
      `<div class="src-kind">${kinds[c.kind] ?? c.kind} ${c.sensitivityLabel ? `· ${esc(c.sensitivityLabel)}` : ""}</div>`,
      `<div class="src-title">[${c.index}] ${esc(c.title)}</div>`,
      c.snippet ? `<div class="src-snippet">${esc(c.snippet)}</div>` : "",
      `<div class="src-date">${c.author ? esc(c.author) + " · " : ""}${c.date ? esc(c.date) : ""}</div>`,
      `<div class="src-actions"><a href="${c.url}" target="_blank" rel="noopener">Open in M365 ↗</a><button data-copy="${esc(c.url)}">Copy link</button></div>`,
    ].join("");
    card.querySelector('[data-copy]')!.addEventListener("click", (e) => {
      const btn = e.currentTarget as HTMLButtonElement;
      void navigator.clipboard.writeText(btn.dataset.copy ?? "");
      btn.textContent = "Copied ✓";
      setTimeout(() => (btn.textContent = "Copy link"), 1200);
    });
    list.appendChild(card);
  }
}

// ---------- SSE chat ----------
async function send(question: string): Promise<void> {
  const q = question.trim();
  if (!q) return;
  const w = $("welcome");
  if (w) w.remove();
  inputEl.value = "";
  inputEl.style.height = "auto";
  sendBtn.disabled = true;
  addUserMsg(q);
  const { bubble, wrap } = addAssistantMsg("Connecting…");
  lastQuestion = q;

  const res = await apiFetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question: q, conversationId, account: currentAccount }),
  });
  if (!res.ok || !res.body) {
    setStatus(bubble, "Failed to reach the server.");
    sendBtn.disabled = false;
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let answer = "";
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    sendBtn.disabled = false;
    scrollBottom();
  };
  while (true) {
    const { value, done: streamDone } = await reader.read();
    if (streamDone) break;
    buf += decoder.decode(value, { stream: true });
    const events = buf.split("\n\n");
    buf = events.pop() ?? "";
    for (const raw of events) {
      const evType = raw.match(/^event: (.+)$/m)?.[1];
      const dataRaw = raw.match(/^data: (.+)$/m)?.[1];
      if (!evType || !dataRaw) continue;
      let data: any;
      try { data = JSON.parse(dataRaw); } catch { continue; }
      if (evType === "meta") {
        // engine info
      } else if (evType === "status") {
        setStatus(bubble, data.message);
      } else if (evType === "token") {
        if (bubble.querySelector(".caret")) bubble.querySelector(".caret")!.remove();
        if (!bubble.querySelector(".status-line")) bubble.innerHTML = "";
        answer += data.text;
        const { html } = renderWithCites(answer);
        bubble.innerHTML = html + '<span class="caret"></span>';
        scrollBottom();
      } else if (evType === "citations") {
        lastCitations = data.citations;
        renderSources();
      } else if (evType === "done") {
        conversationId = data.conversationId;
        if (data.account) currentAccount = data.account;
        finishMessage(wrap, { answer, citations: lastCitations, conversationId, engine: data.engine, durationMs: data.durationMs, agent: data.agent });
        finish();
      } else if (evType === "error") {
        setStatus(bubble, "⚠️ " + (data.message ?? "Unknown error") + (data.hint ? " — " + data.hint : ""));
        finish();
      }
    }
  }
  finish();
}

// ---------- brief ----------
function renderBrief(): void {
  const drawer = $("brief-drawer");
  const fab = $("brief-toggle");
  const count = $("brief-count");
  const list = $("brief-list");
  count.textContent = brief.length ? `${brief.length} item${brief.length > 1 ? "s" : ""}` : "";
  fab.hidden = brief.length === 0;
  list.innerHTML = "";
  for (const item of brief) {
    const div = document.createElement("div");
    div.className = "brief-item";
    div.innerHTML = `<div class="q">${esc(item.question)}</div><div class="a">${esc(item.answer.slice(0, 180))}…</div>`;
    list.appendChild(div);
  }
}
$("brief-toggle").addEventListener("click", () => {
  $("brief-drawer").hidden = false;
  $("brief-toggle").hidden = true;
});
$("brief-export").addEventListener("click", async () => {
  const res = await apiFetch("/api/brief", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Work IQ Brief", items: brief }),
  });
  const { markdown } = await res.json();
  const blob = new Blob([markdown], { type: "text/markdown" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "workiq-brief.md";
  a.click();
  URL.revokeObjectURL(a.href);
});
$("brief-clear").addEventListener("click", () => { brief = []; renderBrief(); $("brief-drawer").hidden = true; });

// ---------- grounding explorer ----------
const gResults = $("g-results");
$("g-go").addEventListener("click", runGrounding);
$<HTMLTextAreaElement>("g-query").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); runGrounding(); } });

async function runGrounding(): Promise<void> {
  const ta = $<HTMLTextAreaElement>("g-query");
  const queries = ta.value.split("\n").map((s) => s.trim()).filter(Boolean);
  if (!queries.length) return;
  gResults.innerHTML = '<div class="status-line"><span class="caret"></span> Retrieving grounding…</div>';
  const res = await apiFetch("/api/retrieve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ queries, account: currentAccount }),
  });
  if (!res.ok) { gResults.innerHTML = '<div class="empty">Retrieval failed.</div>'; return; }
  const data = await res.json();
  const kinds: Record<string, string> = { email: "✉️", chat: "💬", document: "📄", meeting: "🗓", person: "👤", link: "🔗" };
  gResults.innerHTML = "";
  const summary = document.createElement("div");
  summary.className = "g-summary";
  summary.innerHTML = `<b>${data.resultCount}</b> hits · ${(data.durationMs / 1000).toFixed(1)}s · engine ${meta?.mode}`;
  gResults.appendChild(summary);
  const grid = document.createElement("div");
  grid.className = "g-grid";
  for (const h of data.hits) {
    const card = document.createElement("div");
    card.className = "g-card";
    const metaLine = [h.date, h.sensitivityLabel].filter(Boolean).join(" · ");
    card.innerHTML = [
      `<div class="src-kind">${kinds[h.kind] ?? "🔗"} ${h.kind}</div>`,
      `<div class="src-title">${esc(h.title)}</div>`,
      h.snippet ? `<div class="src-snippet">${esc(h.snippet)}</div>` : "",
      metaLine ? `<div class="src-date">${esc(metaLine)}</div>` : "",
      `<div class="src-actions"><a href="${h.url}" target="_blank" rel="noopener">Open in M365 ↗</a><button data-blob="${h.kind === "document" ? h.id : ""}">Fetch content</button></div>`,
    ].join("");
    const blobBtn = card.querySelector('[data-blob]') as HTMLButtonElement;
    if (blobBtn.dataset.blob) {
      blobBtn.addEventListener("click", async () => {
        blobBtn.textContent = "Fetching…";
        const r = await apiFetch("/api/fetch-blob", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: `/documents/${blobBtn.dataset.blob}/content`, account: currentAccount }),
        });
        const b = await r.json();
        if (b.base64) {
          const text = atob(b.base64);
          blobBtn.textContent = "Fetched ✓";
          const pre = document.createElement("pre");
          pre.className = "g-markdown";
          pre.textContent = text.slice(0, 1500);
          card.appendChild(pre);
        } else {
          blobBtn.textContent = "No content";
        }
      });
    } else {
      blobBtn.disabled = true;
      blobBtn.style.opacity = ".4";
      blobBtn.title = "Content retrieval is available for documents";
    }
    grid.appendChild(card);
  }
  gResults.appendChild(grid);
  if (data.markdown) {
    const head = document.createElement("div");
    head.className = "g-summary";
    head.textContent = "Grounding markdown (as returned by Work IQ retrieve):";
    gResults.appendChild(head);
    const pre = document.createElement("pre");
    pre.className = "g-markdown";
    pre.textContent = data.markdown;
    gResults.appendChild(pre);
  }
}

// ---------- Microsoft Teams host ----------
// Only runs when the page is framed by Teams (personal tab or task module).
// Every failure degrades to the plain web page — the SDK is optional chrome.
const teamsParams = new URLSearchParams(location.search);
const isInTeams = teamsParams.has("inTeams") || window.parent !== window;

function applyTeamsTheme(theme: string): void {
  const known = theme === "dark" || theme === "contrast" ? theme : "default";
  document.body.classList.remove("teams-theme-default", "teams-theme-dark", "teams-theme-contrast");
  document.body.classList.add(`teams-theme-${known}`);
}

async function initTeams(): Promise<void> {
  if (!isInTeams) return;
  document.body.classList.add("in-teams");
  if (teamsParams.has("dialog")) document.body.classList.add("in-dialog");
  try {
    // Dynamic on purpose: @microsoft/teams-js probes the embedding frame on module
    // evaluation, so it must never execute on the plain-web (non-framed) path.
    const { app, authentication } = await import("@microsoft/teams-js");
    await app.initialize();
    app.notifySuccess();
    // The host caches and silently renews this token, so the same call is also the
    // refresh path once the current one nears expiry.
    requestTeamsToken = () => authentication.getAuthToken();
    await ssoAccessToken();
    const context = await app.getContext();
    document.body.classList.add("teams");
    document.body.dataset.teamsHost = context.app.host.name;
    applyTeamsTheme(context.app.theme);
    app.registerOnThemeChangeHandler(applyTeamsTheme);
  } catch (e) {
    console.warn("[teams] host SDK unavailable — running as a plain web page:", e);
  }
}

// Started before boot() so the very first /api call already carries the SSO token.
const teamsReady = initTeams();

// ---------- boot ----------
async function boot(): Promise<void> {
  try {
    const res = await apiFetch("/api/meta");
    meta = await res.json();
  } catch {
    meta = null;
  }
  bootUi(meta);
}

function bootUi(m: Meta | null): void {
  const badge = $("mode-badge");
  const detail = $("engine-detail");
  if (m) {
    badge.textContent = m.mode === "live" ? "● LIVE — Work IQ tenant" : "● DEMO — simulated";
    badge.className = `badge ${m.mode}`;
    detail.textContent = m.engine.detail;
    if (m.teamsBot.enabled) $("teams-badge").hidden = false;
    $("btn-enroll").hidden = m.mode !== "live";
    const aboutEngine = $("about-engine");
    if (aboutEngine) aboutEngine.textContent = m.warnings.length ? m.warnings.join(" · ") : `Engine: ${m.engine.label}`;
    renderSsoIdentity(m.sso?.identity);
    if (m.sso?.enabled && !ssoToken) {
      showSsoNotice(ssoFailure || "Not signed in with Teams SSO — queries use the demo's shared Work IQ account.");
    }
    // per-user account switcher
    const sel = $<HTMLSelectElement>("account-select");
    const prevAccount = currentAccount;
    sel.innerHTML = "";
    for (const acc of m.accounts.list) {
      const opt = document.createElement("option");
      opt.value = acc;
      opt.textContent = acc;
      sel.appendChild(opt);
    }
    sel.hidden = m.accounts.list.length === 0;
    if (m.accounts.list.length > 0) {
      currentAccount = prevAccount && m.accounts.list.includes(prevAccount) ? prevAccount : (m.accounts.default ?? m.accounts.list[0]);
      sel.value = currentAccount;
      sel.title = `Work IQ 账号：${currentAccount} 用自己的权限查询`;
      sel.onchange = () => {
        currentAccount = sel.value;
        conversationId = undefined; // conversation ids are per-account
        sel.title = `Work IQ 账号：${currentAccount} 用自己的权限查询`;
      };
    }
  } else {
    badge.textContent = "offline";
  }
  welcome();
}

// tabs
document.querySelectorAll<HTMLButtonElement>(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
    tab.classList.add("active");
    $(tab.dataset.tab === "grounding" ? "panel-grounding" : "panel-chat").classList.add("active");
  });
});

// composer
sendBtn.addEventListener("click", () => void send(inputEl.value));
inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(inputEl.value); }
});
inputEl.addEventListener("input", () => {
  inputEl.style.height = "auto";
  inputEl.style.height = Math.min(inputEl.scrollHeight, 140) + "px";
});

// ---------- self-service account enrollment ----------
const enrollModal = $("enroll-modal");
$("btn-enroll").addEventListener("click", () => {
  $<HTMLInputElement>("enroll-email").value = "";
  $("enroll-progress").hidden = true;
  $("enroll-status").textContent = "";
  enrollModal.hidden = false;
});
$("enroll-close").addEventListener("click", () => { enrollModal.hidden = true; });
enrollModal.addEventListener("click", (e) => { if (e.target === enrollModal) enrollModal.hidden = true; });

$("enroll-start").addEventListener("click", async () => {
  const email = $<HTMLInputElement>("enroll-email").value.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { $("enroll-status").textContent = "请输入有效的邮箱地址"; return; }
  const statusEl = $("enroll-status");
  const codeEl = $("enroll-code");
  const urlEl = $<HTMLAnchorElement>("enroll-url");
  const startBtn = $<HTMLButtonElement>("enroll-start");
  startBtn.disabled = true;
  statusEl.textContent = "正在启动登录流程…";
  $("enroll-progress").hidden = false;
  try {
    const res = await apiFetch("/api/enroll", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email }) });
    const data = await res.json();
    if (!res.ok) { statusEl.textContent = "❌ " + (data.error ?? "失败"); startBtn.disabled = false; return; }
    const id = data.id;
    const poll = async () => {
      const r = await apiFetch("/api/enroll/" + id);
      const s = await r.json();
      if (s.deviceUrl && s.deviceCode) { urlEl.href = s.deviceUrl; urlEl.textContent = "打开授权页面 ↗"; codeEl.textContent = s.deviceCode; }
      if (s.status === "pending") { statusEl.textContent = `请在浏览器完成授权…（${s.elapsedSec}s）`; setTimeout(poll, 2000); return; }
      if (s.status === "complete") {
        statusEl.textContent = "✅ 登录成功！你的账号已可用于查询（切换到上方账号下拉即可）。";
        startBtn.disabled = false;
        const m = await (await apiFetch("/api/meta")).json();
        meta = m; bootUi(m); setTimeout(() => enrollModal.hidden = true, 2500);
        return;
      }
      statusEl.textContent = "❌ " + (s.error ?? s.status) + " — 查看下方日志：" + (s.lastLines ?? []).join(" | ");
      startBtn.disabled = false;
    };
    setTimeout(poll, 1500);
  } catch (e) {
    statusEl.textContent = "❌ " + (e instanceof Error ? e.message : String(e));
    startBtn.disabled = false;
  }
});

// about modal
$("btn-about").addEventListener("click", () => { $("about-modal").hidden = false; });
$("about-close").addEventListener("click", () => { $("about-modal").hidden = true; });
$("about-modal").addEventListener("click", (e) => { if (e.target === $("about-modal")) $("about-modal").hidden = true; });

void boot();