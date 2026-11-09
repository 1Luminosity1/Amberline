import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ask, message, open } from "@tauri-apps/plugin-dialog";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import "./style.css";

/* ================= types ================= */
interface ToolStat { calls: number; failed: number; ms: number }
interface StepStat {
  step: number; model_ms: number; first_token_ms: number; prompt_tokens: number;
  completion_tokens: number; tool_calls: number; tool_ms: number;
}
interface Summary {
  provider: string; key_id: string; model: string;
  duration_ms: number; model_ms: number; tool_ms: number; approval_wait_ms: number;
  steps: number; tools: Record<string, ToolStat>; step_stats: StepStat[];
  files_changed: string[]; lines_added: number; lines_removed: number; bytes_written: number;
  prompt_tokens: number; completion_tokens: number; cache_hit_tokens: number; cost_usd: number | null;
  approvals_allowed: number; approvals_denied: number; errors: number; cancelled: boolean;
}
interface Totals {
  runs: number; steps: number; duration_ms: number; model_ms: number; tool_ms: number;
  prompt_tokens: number; completion_tokens: number; cache_hit_tokens: number; cost_usd: number;
  tool_calls: number; tool_failed: number; files_changed: number; lines_added: number;
  lines_removed: number; cancelled: number; errors: number;
}
interface Stats {
  total: Totals; by_model: Record<string, Totals>; by_key: Record<string, Totals>;
  by_day: Record<string, Totals>; by_tool: Record<string, ToolStat>;
}
interface Entry { name: string; is_dir: boolean }
interface SessionInfo { id: string; title: string; workspace: string; kind: string; created: number; updated: number; running: boolean; runs: number }
interface SessionData { info: SessionInfo; history: any[]; summaries: Summary[] }
type Ev =
  | { type: "text"; delta: string }
  | { type: "reasoning"; delta: string }
  | { type: "tool_start"; id: string; name: string; args: Record<string, any> }
  | { type: "tool_end"; id: string; ok: boolean; output: string; ms: number }
  | { type: "approval"; id: string; name: string; args: Record<string, any> }
  | { type: "usage"; prompt: number; completion: number }
  | { type: "done"; summary: Summary }
  | { type: "error"; message: string };
type Env = Ev & { session: string };

/* ================= providers & settings store ================= */
interface Profile { id: string; name: string; baseUrl: string; apiKey: string; model: string; priceIn: string; priceOut: string }
interface Store { active: string; autoApprove: boolean; fontSize: number; items: Profile[] }
interface Settings {
  apiKey: string; baseUrl: string; model: string; autoApprove: boolean;
  provider: string; keyId: string; priceIn: number | null; priceOut: number | null;
}
const PRESETS: Record<string, { name: string; baseUrl: string; model: string }> = {
  gemini: { name: "Google Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", model: "gemini-2.0-flash" },
  openrouter: { name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", model: "anthropic/claude-3.5-sonnet" },
  deepseek: { name: "DeepSeek", baseUrl: "https://api.deepseek.com", model: "deepseek-chat" },
  openai: { name: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "gpt-4o" },
  grok: { name: "xAI (Grok)", baseUrl: "https://api.x.ai/v1", model: "grok-2-latest" },
  groq: { name: "Groq (Fast)", baseUrl: "https://api.groq.com/openai/v1", model: "llama-3.3-70b-versatile" },
  mistral: { name: "Mistral AI", baseUrl: "https://api.mistral.ai/v1", model: "codestral-latest" },
  together: { name: "Together AI", baseUrl: "https://api.together.xyz/v1", model: "meta-llama/Llama-3.3-70B-Instruct-Turbo" },
  perplexity: { name: "Perplexity AI", baseUrl: "https://api.perplexity.ai", model: "sonar-pro" },
  cohere: { name: "Cohere", baseUrl: "https://api.cohere.com/v2", model: "command-r-plus" },
  ollama: { name: "Ollama (local)", baseUrl: "http://localhost:11434/v1", model: "qwen2.5-coder" },
  lmstudio: { name: "LM Studio (local)", baseUrl: "http://localhost:1234/v1", model: "" },
  custom: { name: "Custom (OpenAI-compatible)", baseUrl: "", model: "" },
};
const uid = () => Math.random().toString(36).slice(2, 8);
const newProfile = (preset: string): Profile => ({ id: uid(), apiKey: "", priceIn: "", priceOut: "", ...PRESETS[preset] });

function getSaved(key: string): string | null {
  return localStorage.getItem("mistline." + key) ?? localStorage.getItem("amberline." + key);
}
function setSaved(key: string, val: string): void {
  localStorage.setItem("mistline." + key, val);
}

function loadStore(): Store {
  try {
    const raw = getSaved("profiles");
    if (raw) {
      const s = JSON.parse(raw) as Partial<Store>;
      if (s.items?.length) {
        return { active: s.active ?? s.items[0].id, autoApprove: !!s.autoApprove, fontSize: s.fontSize ?? 13, items: s.items };
      }
    }
    const old = JSON.parse(getSaved("settings") || "null");
    if (old) {
      const p = { ...newProfile("deepseek"), apiKey: old.apiKey || "", baseUrl: old.baseUrl, model: old.model };
      return { active: p.id, autoApprove: !!old.autoApprove, fontSize: 13, items: [p] };
    }
  } catch { /* use defaults */ }
  const p: Profile = { id: uid(), name: "None", baseUrl: "", apiKey: "", model: "", priceIn: "", priceOut: "" };
  return { active: p.id, autoApprove: false, fontSize: 13, items: [p] };
}
let store = loadStore();
const activeProfile = () => store.items.find(p => p.id === store.active) ?? store.items[0];
const isLocal = (u: string) => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/i.test(u);
const num = (s: string) => { const n = parseFloat(s.replace(",", ".")); return Number.isFinite(n) ? n : null; };
function toSettings(p: Profile): Settings {
  return {
    apiKey: p.apiKey, baseUrl: p.baseUrl, model: p.model, autoApprove: store.autoApprove,
    provider: p.name, keyId: p.apiKey ? `${p.name} …${p.apiKey.slice(-4)}` : `${p.name} (no key)`,
    priceIn: num(p.priceIn), priceOut: num(p.priceOut),
  };
}
const applyFont = () => document.documentElement.style.setProperty("--fs", `${store.fontSize}px`);

/* ================= dom & helpers ================= */
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const feeds = $("feeds"), timelines = $("timelines"), tabsEl = $("tabs"), input = $<HTMLTextAreaElement>("input");
const stateEl = $("state"), modelEl = $("model"), treeEl = $("tree"), wsBtn = $("ws");
const panel = $("panel"), panelSession = $("panel-session"), panelLast = $("panel-last");
const dlg = $<HTMLDialogElement>("settings");

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
function parseInline(str: string): string {
  let s = esc(str);
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
  s = s.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
  s = s.replace(/__([^_]+)__/g, "<b>$1</b>");
  s = s.replace(/\*([^*\n]+)\*/g, "<i>$1</i>");
  s = s.replace(/(^|[^\w])_([^_]+)_([^\w]|$)/g, "$1<i>$2</i>$3");
  return s;
}

function parseBlocks(text: string): string {
  const lines = text.split("\n");
  let out = "";
  let inList = false;
  let inQuote = false;

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];

    if (rawLine.startsWith("> ")) {
      if (!inQuote) { out += "<blockquote>"; inQuote = true; }
      out += parseInline(rawLine.slice(2)) + "<br>";
      continue;
    } else if (inQuote) {
      out += "</blockquote>";
      inQuote = false;
    }

    const listMatch = rawLine.match(/^(\s*)([-*]|\d+\.)\s+(.+)$/);
    if (listMatch) {
      if (!inList) { out += "<ul>"; inList = true; }
      out += `<li>${parseInline(listMatch[3])}</li>`;
      continue;
    } else if (inList) {
      out += "</ul>";
      inList = false;
      if (!rawLine.trim()) continue;
    }

    if (rawLine.startsWith("### ")) {
      out += `<h4>${parseInline(rawLine.slice(4))}</h4>`;
      continue;
    }
    if (rawLine.startsWith("## ")) {
      out += `<h3>${parseInline(rawLine.slice(3))}</h3>`;
      continue;
    }
    if (rawLine.startsWith("# ")) {
      out += `<h2>${parseInline(rawLine.slice(2))}</h2>`;
      continue;
    }
    if (rawLine.trim() === "---" || rawLine.trim() === "***") {
      out += `<hr>`;
      continue;
    }

    if (!rawLine.trim()) {
      out += `<div class="p-gap"></div>`;
    } else {
      out += `<p>${parseInline(rawLine)}</p>`;
    }
  }

  if (inList) out += "</ul>";
  if (inQuote) out += "</blockquote>";
  return out;
}

function md(src: string): string {
  const parts = src.split(/(```[\s\S]*?```)/g);
  return parts.map(part => {
    if (part.startsWith("```") && part.endsWith("```")) {
      const match = part.match(/^```(\w+)?\n?([\s\S]*?)```$/);
      const lang = (match?.[1] || "code").toLowerCase();
      const code = match?.[2] || "";
      return `<div class="code-box"><div class="code-head"><span class="code-lang">${esc(lang)}</span><button type="button" class="btn-copy">Copy</button></div><pre><code>${esc(code)}</code></pre></div>`;
    }
    if (part.startsWith("```")) {
      const match = part.match(/^```(\w+)?\n?([\s\S]*)$/);
      const lang = (match?.[1] || "code").toLowerCase();
      const code = match?.[2] || "";
      return `<div class="code-box"><div class="code-head"><span class="code-lang">${esc(lang)}</span><button type="button" class="btn-copy">Copy</button></div><pre><code>${esc(code)}</code></pre></div>`;
    }
    return parseBlocks(part);
  }).join("");
}
const el = (tag: string, cls = "", html = "") => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html) e.innerHTML = html;
  return e;
};
const fmtMs = (ms: number) =>
  ms < 1000 ? `${ms}ms` : ms < 60000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
const fmtN = (n: number) => n.toLocaleString();
const fmtCost = (c: number | null | undefined) => (!c ? "–" : "$" + (c < 0.01 ? c.toFixed(4) : c.toFixed(2)));
const kv = (k: string, v: string) => `<div class="kv"><span>${k}</span><b>${v}</b></div>`;
const sub = (t: string) => `<div class="sub">${t}</div>`;
const nearBottom = (f: HTMLElement) => f.scrollHeight - f.scrollTop - f.clientHeight < 80;
const stick = (f: HTMLElement, was: boolean) => { if (was) f.scrollTop = f.scrollHeight; };
const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() || p;

/* ================= sessions ================= */
interface Seg { kind: "text" | "reason"; el: HTMLElement; buf: string }
interface UI {
  id: string; title: string; workspace: string; kind: "chat" | "agent"; running: boolean; hasMessages: boolean; loaded: boolean;
  feed: HTMLElement; timeline: HTMLElement; assistant: HTMLElement | null; seg: Seg | null;
  tools: Map<string, HTMLDetailsElement>; t0: number; summaries: Summary[];
  thinkEl: HTMLDetailsElement | null; thinkStart: number; thinkDuration: number;
  inThoughtTag: boolean;
}
const sessions = new Map<string, UI>();
let order: string[] = [];
let activeId = "";
const cur = () => sessions.get(activeId);
let currentSpace: "chats" | "projects" = (getSaved("space") as "chats" | "projects") || "chats";

/* ================= recent projects & workspace hub ================= */
interface RecentProject {
  path: string;
  name: string;
  lastOpened: number;
}

function getRecentProjects(): RecentProject[] {
  try {
    const raw = localStorage.getItem("mistline.recent_projects");
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function addRecentProject(dirPath: string) {
  if (!dirPath) return;
  const list = getRecentProjects().filter(p => p.path !== dirPath);
  list.unshift({
    path: dirPath,
    name: baseName(dirPath),
    lastOpened: Date.now(),
  });
  localStorage.setItem("mistline.recent_projects", JSON.stringify(list.slice(0, 15)));
}

function removeRecentProject(dirPath: string) {
  const list = getRecentProjects().filter(p => p.path !== dirPath);
  localStorage.setItem("mistline.recent_projects", JSON.stringify(list));
}

async function attachProject(ui: UI, path: string) {
  try {
    await invoke<SessionInfo>("convert_to_agent", { id: ui.id, workspace: path });
    ui.workspace = path;
    ui.kind = "agent";
    addRecentProject(path);
    await refreshWorkspace();
    showEmpty(ui);
    renderTabs();
  } catch (e) {
    await message(`Cannot connect to folder: ${e}`, { title: "Project error", kind: "error" });
    removeRecentProject(path);
    if (!ui.workspace) renderProjectHub(ui);
  }
}

function renderProjectHub(ui: UI) {
  const recents = getRecentProjects();
  let recentsHtml = "";
  if (recents.length === 0) {
    recentsHtml = `<div class="hub-empty-recents">No recent projects yet. Create a quick project or open an existing directory.</div>`;
  } else {
    recentsHtml = recents.map(r => `
      <div class="hub-recent-row" data-path="${esc(r.path)}">
        <div class="hub-recent-main">
          <span class="hub-recent-name">${esc(r.name)}</span>
          <span class="hub-recent-path" title="${esc(r.path)}">${esc(r.path)}</span>
        </div>
        <button type="button" class="hub-recent-del" data-del="${esc(r.path)}" title="Remove from recents">✕</button>
      </div>
    `).join("");
  }

  ui.feed.innerHTML = `
    <div class="project-hub">
      <div class="hub-header">
        <div class="hub-tag">AGENT WORKSPACE</div>
        <h2 class="hub-title">Mistline Project Hub</h2>
        <p class="hub-sub">Autonomous coding agent environment with full workspace access, tool execution, and local terminal execution.</p>
      </div>

      <div class="hub-grid">
        <div class="hub-card">
          <div>
            <div class="hub-card-head">
              <div class="hub-card-title">1-Click Quick Project</div>
              <span class="hub-card-badge">DEFAULT FOLDER</span>
            </div>
            <div class="hub-card-desc">Creates a ready-to-use workspace inside <code>Documents/Mistline/Projects/</code>.</div>
          </div>
          <div class="hub-input-row">
            <input type="text" id="hub-project-name" placeholder="Project name (optional)" autocomplete="off" spellcheck="false" />
            <button type="button" class="hub-btn-primary" id="hub-btn-create">Create Project</button>
          </div>
        </div>

        <div class="hub-card">
          <div>
            <div class="hub-card-head">
              <div class="hub-card-title">Open Existing Folder</div>
              <span class="hub-card-badge">LOCAL DISK</span>
            </div>
            <div class="hub-card-desc">Open an existing repository, codebase, or directory from any drive on this PC.</div>
          </div>
          <div class="hub-input-row">
            <button type="button" class="hub-btn-sec" id="hub-btn-open">Browse Folder...</button>
            <button type="button" class="hub-btn-text" id="hub-btn-explore">Open Projects Folder</button>
          </div>
        </div>
      </div>

      <div class="hub-recents-wrap">
        <div class="hub-recents-head">
          <span>RECENT PROJECTS</span>
          <span style="font-size: 10px; color: var(--dim);">${recents.length} saved</span>
        </div>
        <div class="hub-recents-list" id="hub-recents-list">
          ${recentsHtml}
        </div>
      </div>
    </div>
  `;

  const nameInput = ui.feed.querySelector<HTMLInputElement>("#hub-project-name");
  const createBtn = ui.feed.querySelector<HTMLButtonElement>("#hub-btn-create");
  const openBtn = ui.feed.querySelector<HTMLButtonElement>("#hub-btn-open");
  const exploreBtn = ui.feed.querySelector<HTMLButtonElement>("#hub-btn-explore");

  const doCreate = async () => {
    const name = nameInput ? nameInput.value.trim() : "";
    try {
      const createdPath = await invoke<string>("create_project", { name: name || null });
      await attachProject(ui, createdPath);
    } catch (e) {
      await message(String(e), { title: "Cannot create project", kind: "error" });
    }
  };

  if (createBtn) createBtn.onclick = doCreate;
  if (nameInput) {
    nameInput.onkeydown = e => {
      if (e.key === "Enter") {
        e.preventDefault();
        doCreate();
      }
    };
  }

  if (openBtn) {
    openBtn.onclick = async () => {
      const dir = await open({ directory: true });
      if (typeof dir !== "string") return;
      await attachProject(ui, dir);
    };
  }

  if (exploreBtn) {
    exploreBtn.onclick = async () => {
      try {
        const defaultDir = await invoke<string>("get_default_projects_dir");
        await invoke("open_in_explorer", { path: defaultDir });
      } catch (e) {
        await message(String(e), { title: "Cannot open folder", kind: "error" });
      }
    };
  }

  const recentsList = ui.feed.querySelector("#hub-recents-list");
  if (recentsList) {
    recentsList.addEventListener("click", async e => {
      const target = e.target as HTMLElement;
      const delBtn = target.closest<HTMLButtonElement>(".hub-recent-del");
      if (delBtn) {
        e.stopPropagation();
        const p = delBtn.getAttribute("data-del");
        if (p) {
          removeRecentProject(p);
          renderProjectHub(ui);
        }
        return;
      }
      const row = target.closest<HTMLElement>(".hub-recent-row");
      if (row) {
        const p = row.getAttribute("data-path");
        if (p) {
          await attachProject(ui, p);
        }
      }
    });
  }
}

function showEmpty(ui: UI) {
  if (ui.kind === "chat") {
    ui.feed.innerHTML = `<div class="empty"><b>Mistline Chat</b><br>Ask anything. Pure conversational mode without folder access.<br>Click "Connect Project" above if you want to turn this into a coding agent.</div>`;
  } else if (!ui.workspace) {
    renderProjectHub(ui);
  } else {
    ui.feed.innerHTML = `<div class="empty"><b>Mistline Agent</b><br>Describe a task. The agent can read, edit files and run commands in <code>${esc(baseName(ui.workspace))}</code>.</div>`;
  }
}

function makeUI(info: SessionInfo): UI {
  const feed = el("div", "feed hidden");
  const timeline = el("div", "timeline hidden");
  feeds.appendChild(feed);
  timelines.appendChild(timeline);
  const kind = (info.kind as "chat" | "agent") || (info.workspace ? "agent" : "chat");
  const ui: UI = {
    id: info.id, title: info.title, workspace: info.workspace, kind, running: info.running,
    hasMessages: info.runs > 0, loaded: false, feed, timeline, assistant: null, seg: null,
    tools: new Map(), t0: 0, summaries: [],
    thinkEl: null, thinkStart: 0, thinkDuration: 0, inThoughtTag: false,
  };
  sessions.set(info.id, ui);
  order.push(info.id);
  showEmpty(ui);
  return ui;
}

function renderTabs() {
  tabsEl.innerHTML = "";
  const filtered = order.filter(id => {
    const ui = sessions.get(id);
    if (!ui) return false;
    return currentSpace === "chats" ? ui.kind === "chat" : ui.kind === "agent";
  });

  for (const id of filtered) {
    const ui = sessions.get(id)!;
    const tab = el("div", `tab${id === activeId ? " active" : ""}${ui.running ? " running" : ""}`);
    const title = el("span", "t-title");
    title.textContent = ui.title || (ui.kind === "chat" ? "New chat" : "New session");
    title.title = ui.workspace || "General chat";
    const x = el("button", "t-x", "×");
    x.title = "Close session";
    tab.append(el("span", "dot"), title, x);
    tab.onclick = () => activate(id);
    tab.onauxclick = e => { if (e.button === 1) closeSession(id); };
    title.ondblclick = e => { e.stopPropagation(); startRename(ui, title); };
    x.onclick = e => { e.stopPropagation(); closeSession(id); };
    tabsEl.appendChild(tab);
  }

  const curUI = cur();
  const convertBtn = $("btn-convert");
  if (convertBtn) {
    if (curUI && curUI.kind === "chat") {
      convertBtn.classList.remove("hidden");
    } else {
      convertBtn.classList.add("hidden");
    }
  }
}

function startRename(ui: UI, t: HTMLElement) {
  t.contentEditable = "true";
  t.focus();
  const r = document.createRange();
  r.selectNodeContents(t);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(r);
  t.onblur = async () => {
    t.contentEditable = "false";
    const v = (t.textContent || "").trim();
    if (v && v !== ui.title) {
      ui.title = v;
      await invoke("rename_session", { id: ui.id, title: v });
    }
    renderTabs();
  };
  t.onkeydown = e => {
    if (e.key === "Enter") { e.preventDefault(); t.blur(); }
    if (e.key === "Escape") { t.textContent = ui.title; t.blur(); }
  };
}

async function loadSession(ui: UI) {
  const d = await invoke<SessionData>("get_session", { id: ui.id });
  ui.loaded = true;
  ui.summaries = d.summaries;
  renderHistory(ui, d.history);
}

function renderHistory(ui: UI, history: any[]) {
  ui.feed.innerHTML = "";
  const toolEls = new Map<string, HTMLDetailsElement>();
  let a: HTMLElement | null = null;
  for (const m of history) {
    if (m.role === "user") {
      const u = el("div", "msg user");
      u.innerHTML = `<p>${parseInline(String(m.content ?? ""))}</p>`;
      ui.feed.appendChild(u);
      a = null;
    } else if (m.role === "assistant") {
      if (!a) { a = el("div", "msg assistant"); ui.feed.appendChild(a); }
      if (m.content) {
        const raw = String(m.content);
        const match = raw.match(/<(thought|think)>([\s\S]*?)<\/\1>/i);
        if (match) {
          const thoughtContent = match[2].trim();
          const cleanContent = raw.replace(/<(thought|think)>([\s\S]*?)<\/\1>/i, "").trim();
          const d = el("details", "think", `<summary><span class="think-icon">▸</span> <span class="think-title">Thought</span></summary><div class="think-body"></div>`) as HTMLDetailsElement;
          (d.querySelector(".think-body") as HTMLElement).textContent = thoughtContent;
          a.appendChild(d);
          if (cleanContent) a.appendChild(el("div", "assistant-body", md(cleanContent)));
        } else {
          a.appendChild(el("div", "assistant-body", md(raw)));
        }
      }
      for (const tc of m.tool_calls ?? []) {
        let args: Record<string, any> = {};
        try { args = JSON.parse(tc.function?.arguments || "{}"); } catch { /* keep empty */ }
        const d = buildTool(tc.function?.name ?? "tool", args, false);
        a.appendChild(d);
        toolEls.set(tc.id, d);
      }
    } else if (m.role === "tool") {
      const d = toolEls.get(m.tool_call_id);
      if (d) fillOutput(d, String(m.content ?? ""));
    }
  }
  ui.assistant = null; ui.seg = null;
  ui.hasMessages = history.some(m => m.role === "user");
  if (!ui.hasMessages) showEmpty(ui);
  ui.feed.scrollTop = ui.feed.scrollHeight;
}

async function activate(id: string) {
  const ui = sessions.get(id);
  if (!ui) return;
  activeId = id;
  setSaved("active", id);
  setSaved(`active.${ui.kind}`, id);
  for (const [k, u] of sessions) {
    u.feed.classList.toggle("hidden", k !== id);
    u.timeline.classList.toggle("hidden", k !== id);
  }
  if (currentSpace === "chats" || ui.kind === "chat" || !ui.workspace) {
    sideEl.classList.add("hidden");
  } else {
    sideEl.classList.remove("hidden");
  }
  renderTabs();
  if (!ui.loaded) {
    try { await loadSession(ui); } catch (e) { ui.feed.innerHTML = `<div class="err-line">${esc(String(e))}</div>`; }
  }
  ui.feed.scrollTop = ui.feed.scrollHeight;
  updateStatus();
  renderPanel();
  refreshWorkspace();
  input.focus();
}

async function newSession(workspace?: string, kind?: string) {
  const k = kind ?? (currentSpace === "chats" ? "chat" : "agent");
  let ws = workspace ?? null;
  if (k === "agent" && !ws) {
    const prev = Array.from(sessions.values()).find(u => u.kind === "agent" && u.workspace);
    if (prev) {
      ws = prev.workspace;
    }
  }
  const info = await invoke<SessionInfo>("create_session", { workspace: k === "chat" ? null : ws, kind: k });
  const ui = makeUI(info);
  ui.loaded = true;
  await activate(info.id);
}

async function closeSession(id: string) {
  const ui = sessions.get(id);
  if (!ui) return;
  if (ui.hasMessages) {
    const ok = await ask(`Delete session "${ui.title || "New session"}"? Its history will be removed.`, { title: "Delete session", kind: "warning" });
    if (!ok) return;
  }
  if (order.length === 1) await newSession(ui.workspace, ui.kind);
  await invoke("close_session", { id });
  ui.feed.remove();
  ui.timeline.remove();
  sessions.delete(id);
  order = order.filter(x => x !== id);
  if (activeId === id) {
    activeId = "";
    const remainingInSpace = order.filter(x => {
      const u = sessions.get(x);
      return u && (currentSpace === "chats" ? u.kind === "chat" : u.kind === "agent");
    });
    if (remainingInSpace.length) {
      await activate(remainingInSpace[remainingInSpace.length - 1]);
    } else {
      await newSession();
    }
  } else {
    renderTabs();
  }
}

function setRunning(ui: UI, b: boolean) {
  ui.running = b;
  renderTabs();
  if (ui.id === activeId) {
    updateStatus();
    const wrap = document.querySelector(".input-wrap");
    if (wrap) wrap.classList.toggle("running", b);
  }
}

function updateStatus() {
  const ui = cur();
  stateEl.textContent = ui?.running ? "working · Esc to stop" : "ready";
  const wrap = document.querySelector(".input-wrap");
  if (wrap) wrap.classList.toggle("running", !!ui?.running);
  showModel();
}

function showModel() {
  const p = activeProfile();
  if (!p || p.name === "None" || !p.model) {
    modelEl.textContent = "No provider (click Settings)";
    modelEl.style.cursor = "pointer";
    modelEl.onclick = () => openSettings("providers");
  } else {
    modelEl.textContent = `${p.name} · ${p.model}`;
    modelEl.style.cursor = "pointer";
    modelEl.onclick = () => openSettings("providers");
  }
}

/* ================= feed rendering ================= */
function addUser(ui: UI, text: string) {
  if (ui.feed.querySelector(".empty")) ui.feed.innerHTML = "";
  const now = new Date();
  const timeStr = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const msgUser = el("div", "msg user");
  msgUser.innerHTML = `<p>${parseInline(text)}</p><div class="msg-meta user">${timeStr}</div>`;
  ui.feed.appendChild(msgUser);

  ui.assistant = el("div", "msg assistant");
  ui.feed.appendChild(ui.assistant);
  ui.seg = null;
  ui.thinkEl = null;
  ui.thinkStart = 0;
  ui.thinkDuration = 0;
  ui.inThoughtTag = false;
  ui.hasMessages = true;
  if (!ui.title) { ui.title = text.slice(0, 48); renderTabs(); }
  ui.feed.scrollTop = ui.feed.scrollHeight;
}

const toolLabel = (name: string, a: Record<string, any>) => String(name === "bash" ? a.command ?? "" : a.path ?? "");
function diffHtml(oldS: string, newS: string) {
  const f = (s: string, c: string, m: string) =>
    s.split("\n").map(l => `<span class="${c}">${m} ${esc(l)}</span>`).join("\n");
  return `<pre class="diff">${f(oldS, "del", "-")}\n${f(newS, "add", "+")}</pre>`;
}
function toolBody(name: string, a: Record<string, any>) {
  if (name === "edit_file") return diffHtml(String(a.old_string ?? ""), String(a.new_string ?? ""));
  if (name === "write_file") return `<pre>${esc(String(a.content ?? "").split("\n").slice(0, 60).join("\n"))}</pre>`;
  if (name === "bash") return `<pre>$ ${esc(String(a.command ?? ""))}</pre>`;
  return "";
}
function buildTool(name: string, args: Record<string, any>, running: boolean) {
  const d = el("details", `tool${running ? " running" : ""}`) as HTMLDetailsElement;
  d.innerHTML =
    `<summary><span class="mark"></span><span class="name">${esc(name)}</span>` +
    `<span class="arg">${esc(toolLabel(name, args))}</span><span class="ms"></span></summary>` +
    `<div class="body">${toolBody(name, args)}</div>`;
  return d;
}
function fillOutput(d: HTMLElement, output: string) {
  if (output) (d.querySelector(".body") as HTMLElement).insertAdjacentHTML("beforeend", `<pre>${esc(output)}</pre>`);
}

function trace(ui: UI, kind: string, label: string, bad = false) {
  const row = el("div", bad ? "bad" : "");
  const t = ((Date.now() - ui.t0) / 1000).toFixed(1) + "s";
  row.innerHTML = `<span class="t">${t}</span><span class="k">${esc(kind)}</span><span class="l" title="${esc(label)}">${esc(label)}</span>`;
  ui.timeline.appendChild(row);
  ui.timeline.scrollTop = ui.timeline.scrollHeight;
}

function startThinking(ui: UI, a: HTMLElement) {
  if (!ui.thinkStart) ui.thinkStart = Date.now();
  if (!ui.thinkEl) {
    const d = el("details", "think running", `<summary><span class="think-icon">▸</span> <span class="think-title">Thinking</span></summary><div class="think-body"></div>`) as HTMLDetailsElement;
    d.open = true;
    a.appendChild(d);
    ui.thinkEl = d;
    ui.seg = { kind: "reason", el: d.querySelector(".think-body") as HTMLElement, buf: "" };
    trace(ui, "think", "reasoning");
  }
}

function appendThoughtText(ui: UI, a: HTMLElement, text: string) {
  if (!ui.thinkEl) startThinking(ui, a);
  if (ui.seg && ui.seg.kind === "reason") {
    ui.seg.buf += text;
    ui.seg.el.textContent = ui.seg.buf;
  } else if (ui.thinkEl) {
    const body = ui.thinkEl.querySelector(".think-body") as HTMLElement;
    if (body) {
      body.textContent = (body.textContent || "") + text;
      ui.seg = { kind: "reason", el: body, buf: body.textContent };
    }
  }
}

function endThinking(ui: UI) {
  if (ui.thinkStart && !ui.thinkDuration) {
    ui.thinkDuration = Date.now() - ui.thinkStart;
  }
  if (ui.thinkEl) {
    const sumTitle = ui.thinkEl.querySelector(".think-title");
    const durSec = ui.thinkDuration ? (ui.thinkDuration / 1000).toFixed(1) : "0.5";
    if (sumTitle) sumTitle.textContent = `Thought for ${durSec}s`;
    ui.thinkEl.classList.remove("running");
    ui.thinkEl.open = false;
  }
  if (ui.seg && ui.seg.kind === "reason") {
    ui.seg = null;
  }
}

function appendRegularText(ui: UI, a: HTMLElement, text: string) {
  endThinking(ui);
  if (!ui.seg || ui.seg.kind !== "text") {
    const e = el("div", "assistant-body");
    a.appendChild(e);
    ui.seg = { kind: "text", el: e, buf: "" };
    trace(ui, "answer", "writing response");
  }
  ui.seg.buf += text;
  ui.seg.el.innerHTML = md(ui.seg.buf);
}

function handleTextDelta(ui: UI, a: HTMLElement, rawDelta: string) {
  let remaining = rawDelta;
  while (remaining.length > 0) {
    if (!ui.inThoughtTag) {
      const lower = remaining.toLowerCase();
      const idxThought = lower.indexOf("<thought>");
      const idxThink = lower.indexOf("<think>");

      let startIdx = -1;
      let tagLen = 0;
      if (idxThought !== -1 && (idxThink === -1 || idxThought < idxThink)) {
        startIdx = idxThought;
        tagLen = "<thought>".length;
      } else if (idxThink !== -1) {
        startIdx = idxThink;
        tagLen = "<think>".length;
      }

      if (startIdx === -1) {
        appendRegularText(ui, a, remaining);
        break;
      } else {
        if (startIdx > 0) {
          appendRegularText(ui, a, remaining.slice(0, startIdx));
        }
        ui.inThoughtTag = true;
        startThinking(ui, a);
        remaining = remaining.slice(startIdx + tagLen);
      }
    } else {
      const lower = remaining.toLowerCase();
      const idxCloseThought = lower.indexOf("</thought>");
      const idxCloseThink = lower.indexOf("</think>");

      let closeIdx = -1;
      let closeLen = 0;
      if (idxCloseThought !== -1 && (idxCloseThink === -1 || idxCloseThought < idxCloseThink)) {
        closeIdx = idxCloseThought;
        closeLen = "</thought>".length;
      } else if (idxCloseThink !== -1) {
        closeIdx = idxCloseThink;
        closeLen = "</think>".length;
      }

      if (closeIdx === -1) {
        appendThoughtText(ui, a, remaining);
        break;
      } else {
        if (closeIdx > 0) {
          appendThoughtText(ui, a, remaining.slice(0, closeIdx));
        }
        ui.inThoughtTag = false;
        endThinking(ui);
        remaining = remaining.slice(closeIdx + closeLen);
      }
    }
  }
}

/* ================= agent events ================= */
function onEvent(ev: Env) {
  const ui = sessions.get(ev.session);
  if (!ui) return;
  const was = nearBottom(ui.feed);
  if (!ui.assistant) { ui.assistant = el("div", "msg assistant"); ui.feed.appendChild(ui.assistant); }
  const a = ui.assistant;

  switch (ev.type) {
    case "text": {
      handleTextDelta(ui, a, ev.delta);
      break;
    }
    case "reasoning": {
      appendThoughtText(ui, a, ev.delta);
      break;
    }
    case "tool_start": {
      ui.seg = null;
      const d = buildTool(ev.name, ev.args, true);
      a.appendChild(d);
      ui.tools.set(ev.id, d);
      trace(ui, ev.name, toolLabel(ev.name, ev.args));
      break;
    }
    case "approval": {
      const d = ui.tools.get(ev.id);
      if (d) d.open = true;
      const box = el("div", "approval");
      box.innerHTML = `<span>Allow ${esc(ev.name)}?</span>`;
      const yes = el("button", "primary", "Allow"), no = el("button", "", "Deny");
      const settle = (allow: boolean) => {
        invoke("approve", { sessionId: ui.id, id: ev.id, allow });
        box.className = "approval done";
        box.innerHTML = allow ? "allowed" : "denied";
      };
      yes.onclick = () => settle(true);
      no.onclick = () => settle(false);
      box.append(yes, no);
      a.appendChild(box);
      trace(ui, "approve", `waiting: ${ev.name}`);
      break;
    }
    case "tool_end": {
      const d = ui.tools.get(ev.id);
      if (d) {
        d.classList.remove("running");
        d.classList.add(ev.ok ? "ok" : "err");
        (d.querySelector(".ms") as HTMLElement).textContent = ev.ms + "ms";
        fillOutput(d, ev.output);
        d.open = !ev.ok;
      }
      trace(ui, ev.ok ? "done" : "failed", `${ev.ms}ms`, !ev.ok);
      break;
    }
    case "usage":
      if (ui.id === activeId) stateEl.textContent = `working · ${ev.prompt} in / ${ev.completion} out`;
      break;
    case "error":
      a.appendChild(el("div", "err-line", esc(ev.message)));
      trace(ui, "error", ev.message, true);
      break;
    case "done": {
      if (ui.thinkStart && !ui.thinkDuration) {
        ui.thinkDuration = Date.now() - ui.thinkStart;
        if (ui.thinkEl) {
          const sumTitle = ui.thinkEl.querySelector(".think-title");
          if (sumTitle) sumTitle.textContent = `Thought for ${(ui.thinkDuration / 1000).toFixed(1)}s`;
          ui.thinkEl.classList.remove("running");
          ui.thinkEl.open = false;
        }
      }
      ui.summaries.push(ev.summary);
      trace(ui, "done", ev.summary.cancelled ? "stopped" : "finished");
      setRunning(ui, false);

      const s = ev.summary;
      const now = new Date();
      const timeStr = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      const durStr = fmtMs(s.duration_ms);
      const tokCount = s.completion_tokens;
      const spd = s.model_ms > 0 && tokCount > 0 ? `${Math.round((tokCount * 1000) / s.model_ms)} t/s` : "";
      const modelName = s.model || "";

      const meta = el("div", "msg-meta assistant");
      meta.innerHTML = `<span>${timeStr}</span><span>·</span><span>${durStr}</span>` +
        (tokCount ? `<span>·</span><span>${tokCount} tok${spd ? ` (${spd})` : ""}</span>` : "") +
        (modelName ? `<span>·</span><span class="m-model">${esc(modelName)}</span>` : "");
      a.appendChild(meta);

      if (ui.id === activeId) renderPanel();
      break;
    }
  }
  stick(ui.feed, was);
}

/* ================= activity panel ================= */
function summaryHtml(s: Summary) {
  const other = Math.max(0, s.duration_ms - s.model_ms - s.tool_ms - s.approval_wait_ms);
  const hit = s.prompt_tokens ? Math.round((100 * s.cache_hit_tokens) / s.prompt_tokens) : 0;
  let h = kv("status", s.cancelled ? "stopped" : "finished") +
    kv("provider", esc(`${s.provider || "–"} / ${s.model}`)) +
    kv("total time", fmtMs(s.duration_ms)) + kv("model calls", String(s.steps));

  h += sub("Time") + kv("model", fmtMs(s.model_ms)) + kv("tools", fmtMs(s.tool_ms)) +
    kv("waiting for you", fmtMs(s.approval_wait_ms)) + kv("other", fmtMs(other));

  h += sub("Tokens") + kv("input", fmtN(s.prompt_tokens)) +
    kv("cache hits", `${fmtN(s.cache_hit_tokens)} (${hit}%)`) + kv("output", fmtN(s.completion_tokens)) +
    kv("estimated cost", fmtCost(s.cost_usd));

  h += sub("Changes") + kv("files changed", String(s.files_changed.length)) +
    kv("lines added / removed", `+${fmtN(s.lines_added)} / -${fmtN(s.lines_removed)}`) +
    kv("bytes written", fmtN(s.bytes_written)) +
    kv("approvals allowed / denied", `${s.approvals_allowed} / ${s.approvals_denied}`);

  const tl = Object.entries(s.tools);
  h += sub("Tools") + (tl.length
    ? tl.map(([k, v]) => kv(esc(k), `${v.calls}${v.failed ? ` (${v.failed} failed)` : ""} · ${fmtMs(v.ms)}`)).join("")
    : kv("none", ""));

  if (s.step_stats.length) {
    h += sub("Steps") + s.step_stats.map(t =>
      kv(`#${t.step}`, `${fmtMs(t.model_ms)} · first token ${fmtMs(t.first_token_ms)} · ` +
        `${fmtN(t.prompt_tokens)}→${fmtN(t.completion_tokens)} · ${t.tool_calls} tools`)).join("");
  }
  if (s.files_changed.length) h += sub("Files") + s.files_changed.map(f => `<div>${esc(f)}</div>`).join("");
  return h;
}

function sessionHtml(list: Summary[]) {
  if (!list.length) return `<p class="note">No runs in this session yet.</p>`;
  let time = 0, model = 0, tools = 0, steps = 0, pin = 0, pout = 0, hit = 0, cost = 0, add = 0, del = 0, calls = 0, failed = 0, errs = 0;
  const files = new Set<string>();
  for (const s of list) {
    time += s.duration_ms; model += s.model_ms; tools += s.tool_ms; steps += s.steps;
    pin += s.prompt_tokens; pout += s.completion_tokens; hit += s.cache_hit_tokens; cost += s.cost_usd ?? 0;
    add += s.lines_added; del += s.lines_removed; errs += s.errors;
    for (const t of Object.values(s.tools)) { calls += t.calls; failed += t.failed; }
    s.files_changed.forEach(f => files.add(f));
  }
  return kv("runs", String(list.length)) + kv("model calls", fmtN(steps)) +
    kv("time", `${fmtMs(time)} (model ${fmtMs(model)}, tools ${fmtMs(tools)})`) +
    kv("tokens in / out", `${fmtN(pin)} / ${fmtN(pout)}`) + kv("cache hits", fmtN(hit)) +
    kv("estimated cost", fmtCost(cost)) + kv("tool calls", `${fmtN(calls)}${failed ? `, ${failed} failed` : ""}`) +
    kv("files changed", String(files.size)) + kv("lines added / removed", `+${fmtN(add)} / -${fmtN(del)}`) +
    kv("errors", String(errs));
}

function renderPanel() {
  const ui = cur();
  if (!ui) return;
  panelSession.innerHTML = sessionHtml(ui.summaries);
  const last = ui.summaries[ui.summaries.length - 1];
  panelLast.innerHTML = last ? summaryHtml(last) : `<p class="note">Nothing yet.</p>`;
}

function setPanel(show: boolean) {
  panel.classList.toggle("collapsed", !show);
  $("btn-panel").classList.toggle("on", show);
  setSaved("panel", show ? "1" : "0");
}
$("btn-panel").onclick = () => setPanel(panel.classList.contains("collapsed"));
$("panel-close").onclick = () => setPanel(false);

/* ================= sending ================= */
async function send() {
  const ui = cur();
  const text = input.value.trim();
  if (!ui || !text || ui.running) return;
  const prof = activeProfile();
  if (!prof.baseUrl || !prof.model || (!prof.apiKey && !isLocal(prof.baseUrl))) {
    await message("Please configure an AI provider and model in Settings first.", { title: "No Provider Configured", kind: "info" });
    openSettings("providers");
    return;
  }
  if (ui.kind === "agent" && !ui.workspace) {
    try {
      const quickPath = await invoke<string>("create_project", { name: null });
      await attachProject(ui, quickPath);
    } catch (e) {
      await message(String(e), { title: "Cannot initialize project", kind: "error" });
      return;
    }
  }
  input.value = ""; autosize();
  addUser(ui, text);
  ui.timeline.innerHTML = ""; ui.tools.clear();
  ui.t0 = Date.now();
  setRunning(ui, true);
  try {
    await invoke("send_message", {
      sessionId: ui.id, prompt: text, settings: toSettings(prof),
      day: new Date().toLocaleDateString("sv-SE"),
    });
  } catch (e) {
    onEvent({ session: ui.id, type: "error", message: String(e) });
    setRunning(ui, false);
  }
}
function autosize() { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, window.innerHeight * 0.4) + "px"; }

input.addEventListener("input", autosize);
input.addEventListener("keydown", e => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
});

feeds.addEventListener("click", e => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>(".btn-copy");
  if (!btn) return;
  const pre = btn.closest(".code-box")?.querySelector("pre");
  if (!pre) return;
  const code = pre.textContent || "";
  navigator.clipboard.writeText(code).then(() => {
    const old = btn.textContent;
    btn.textContent = "Copied!";
    btn.classList.add("copied");
    setTimeout(() => {
      btn.textContent = old;
      btn.classList.remove("copied");
    }, 1500);
  });
});
window.addEventListener("keydown", e => {
  const ui = cur();
  if (e.key === "Escape" && ui?.running && !(e.target as HTMLElement).isContentEditable) invoke("stop", { sessionId: ui.id });
  if (e.key === "F11") {
    e.preventDefault();
    invoke("win_fullscreen");
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "t") {
    e.preventDefault();
    newSession(undefined, currentSpace === "chats" ? "chat" : "agent");
  }
});
$("btn-add").onclick = () => newSession(undefined, currentSpace === "chats" ? "chat" : "agent");

const btnConvert = $("btn-convert");
if (btnConvert) {
  btnConvert.onclick = async () => {
    const ui = cur();
    if (!ui || ui.kind !== "chat") return;
    const dir = await open({ directory: true });
    if (typeof dir !== "string") return;
    try {
      const updated = await invoke<SessionInfo>("convert_to_agent", { id: ui.id, workspace: dir });
      ui.kind = "agent";
      ui.workspace = updated.workspace;
      addRecentProject(updated.workspace);
      setSpace("projects", false);
      renderTabs();
      await refreshWorkspace();
      input.focus();
    } catch (e) {
      await message(String(e), { title: "Cannot connect project", kind: "error" });
    }
  };
}

/* ================= window controls & space switcher ================= */
$("win-min").onclick = () => invoke("win_minimize");
$("win-max").onclick = () => invoke("win_maximize");
$("win-close").onclick = () => invoke("win_close");

const titlebarEl = $("titlebar");
titlebarEl.addEventListener("mousedown", e => {
  if (e.buttons === 1 && (e.target as HTMLElement).closest("button") === null) {
    invoke("win_start_drag");
  }
});
titlebarEl.addEventListener("dblclick", e => {
  if ((e.target as HTMLElement).closest("button") === null) {
    invoke("win_maximize");
  }
});

const modeChats = $("mode-chats");
const modeProjects = $("mode-projects");
const sideEl = $("side");

function setSpace(space: "chats" | "projects", activateDefault = true) {
  currentSpace = space;
  setSaved("space", space);
  modeChats.classList.toggle("active", space === "chats");
  modeProjects.classList.toggle("active", space === "projects");
  sideEl.classList.toggle("hidden", space === "chats");

  renderTabs();

  if (activateDefault) {
    const curUI = cur();
    const matchesCurrent = curUI && (space === "chats" ? curUI.kind === "chat" : curUI.kind === "agent");
    if (!matchesCurrent) {
      const savedId = getSaved(`active.${space}`);
      const candidates = order.filter(id => {
        const u = sessions.get(id);
        return u && (space === "chats" ? u.kind === "chat" : u.kind === "agent");
      });
      if (savedId && candidates.includes(savedId)) {
        activate(savedId);
      } else if (candidates.length > 0) {
        activate(candidates[candidates.length - 1]);
      } else {
        newSession(undefined, space === "chats" ? "chat" : "agent");
      }
    } else {
      if (curUI) refreshWorkspace();
    }
  }
}

modeChats.onclick = () => setSpace("chats");
modeProjects.onclick = () => setSpace("projects");

/* ================= file tree ================= */
async function loadDir(rel: string, box: HTMLElement, depth: number) {
  const ui = cur();
  if (!ui) return;
  let items: Entry[] = [];
  try { items = await invoke<Entry[]>("list_files", { sessionId: ui.id, rel }); } catch { return; }
  box.innerHTML = "";
  for (const it of items) {
    const p = rel ? `${rel}/${it.name}` : it.name;
    const row = el("div", "row");
    row.style.paddingLeft = `${10 + depth * 12}px`;
    row.textContent = (it.is_dir ? "▸ " : "  ") + it.name;
    box.appendChild(row);
    if (it.is_dir) {
      const child = el("div"); box.appendChild(child);
      let isOpen = false;
      row.onclick = async () => {
        isOpen = !isOpen;
        row.textContent = (isOpen ? "▾ " : "▸ ") + it.name;
        if (isOpen) await loadDir(p, child, depth + 1); else child.innerHTML = "";
      };
    } else {
      row.onclick = () => { input.value += `@${p} `; input.focus(); autosize(); };
    }
  }
}
async function refreshWorkspace() {
  const ui = cur();
  if (!ui) return;
  const sidePname = $("side-pname");
  const wsReveal = $<HTMLButtonElement>("ws-reveal");

  if (currentSpace === "chats" || ui.kind === "chat") {
    sideEl.classList.add("hidden");
    if (sidePname) sidePname.textContent = "Chat mode";
    if (wsReveal) wsReveal.disabled = true;
    treeEl.innerHTML = "";
  } else if (!ui.workspace) {
    sideEl.classList.remove("hidden");
    if (sidePname) {
      sidePname.textContent = "No project";
      sidePname.title = "No project connected";
    }
    if (wsReveal) wsReveal.disabled = true;
    treeEl.innerHTML = `<div style="padding: 14px 10px; color: var(--dim); font-size: 11px; line-height: 1.5;">Select or create a project to explore files and enable tools.</div>`;
  } else {
    sideEl.classList.remove("hidden");
    if (sidePname) {
      sidePname.textContent = baseName(ui.workspace);
      sidePname.title = ui.workspace;
    }
    if (wsReveal) wsReveal.disabled = false;
    await loadDir("", treeEl, 0);
  }
}

wsBtn.onclick = async () => {
  const dir = await open({ directory: true });
  if (typeof dir !== "string") return;
  const ui = cur();
  if (ui && ui.kind === "agent") {
    await attachProject(ui, dir);
  } else {
    try {
      await newSession(dir, "agent");
      setSpace("projects", false);
    } catch (e) {
      await message(String(e), { title: "Cannot open folder", kind: "error" });
    }
  }
};

const wsNewBtn = $("ws-new");
if (wsNewBtn) {
  wsNewBtn.onclick = async () => {
    try {
      const createdPath = await invoke<string>("create_project", { name: null });
      const ui = cur();
      if (ui && ui.kind === "agent") {
        await attachProject(ui, createdPath);
      } else {
        await newSession(createdPath, "agent");
        setSpace("projects", false);
      }
    } catch (e) {
      await message(String(e), { title: "Cannot create project", kind: "error" });
    }
  };
}

const wsRevealBtn = $("ws-reveal");
if (wsRevealBtn) {
  wsRevealBtn.onclick = async () => {
    const ui = cur();
    if (ui && ui.workspace) {
      try {
        await invoke("open_in_explorer", { path: ui.workspace });
      } catch (e) {
        await message(String(e), { title: "Cannot open explorer", kind: "error" });
      }
    }
  };
}

/* ================= settings (tabbed, easy to extend) ================= */
interface Pane { id: string; label: string; render: (root: HTMLElement) => void | Promise<void>; collect?: () => void }
let draft: Store = store;
let draftId = "";
let paneId = "general";
const fld = (id: string) => $<HTMLInputElement>(id);
const draftProfile = () => draft.items.find(x => x.id === draftId)!;

function readFields() {
  if (!document.getElementById("s-name")) return;
  const p = draftProfile();
  if (!p) return;
  p.name = fld("s-name").value.trim() || "Provider";
  p.baseUrl = fld("s-url").value.trim();
  p.apiKey = fld("s-key").value.trim();
  p.model = fld("s-model").value.trim();
  p.priceIn = fld("s-pin").value.trim();
  p.priceOut = fld("s-pout").value.trim();
}

const APP_VERSION = "0.1.10";

const updateDlg = $<HTMLDialogElement>("update-dialog");
let pendingUpdate: any = null;

$("u-later").onclick = () => {
  updateDlg.close();
};

$("u-install").onclick = async () => {
  if (!pendingUpdate) return;
  const progressBox = $("u-progress");
  const actionsBox = $("u-actions");
  const statusTxt = $("u-status");

  actionsBox.classList.add("hidden");
  progressBox.classList.remove("hidden");
  statusTxt.textContent = "Downloading & installing update…";

  try {
    let downloaded = 0;
    let contentLength = 0;
    await pendingUpdate.downloadAndInstall((event: any) => {
      switch (event.event) {
        case "Started":
          contentLength = event.data?.contentLength || 0;
          statusTxt.textContent = `Downloading update (${contentLength ? (contentLength / 1024 / 1024).toFixed(1) + " MB" : "…"})`;
          break;
        case "Progress":
          downloaded += event.data?.chunkLength || 0;
          if (contentLength > 0) {
            const pct = Math.min(100, Math.round((downloaded / contentLength) * 100));
            statusTxt.textContent = `Downloading… ${pct}%`;
          }
          break;
        case "Finished":
          statusTxt.textContent = "Update installed. Restarting Mistline…";
          break;
      }
    });
    statusTxt.textContent = "Restarting Mistline…";
    await relaunch();
  } catch (e) {
    statusTxt.textContent = `Failed: ${e}`;
    actionsBox.classList.remove("hidden");
    await message(String(e), { title: "Update failed", kind: "error" });
  }
};

async function checkForUpdates(silent = false) {
  const statusEl = document.getElementById("g-update-status");
  if (statusEl && !silent) statusEl.textContent = "Checking for updates…";
  try {
    const update = await check();
    if (update) {
      if (statusEl) statusEl.textContent = `New version ${update.version} available!`;
      pendingUpdate = update;
      $("u-version").textContent = `Version ${update.version} is ready`;
      $("u-notes").textContent = update.body || "Bug fixes and improvements.";
      $("u-progress").classList.add("hidden");
      $("u-actions").classList.remove("hidden");
      updateDlg.showModal();
    } else {
      if (statusEl) statusEl.textContent = `Mistline is up to date (v${APP_VERSION})`;
      if (!silent) {
        await message("You are using the latest version of Mistline.", { title: "Up to date", kind: "info" });
      }
    }
  } catch (e) {
    if (statusEl) statusEl.textContent = "Update check error";
    if (!silent) {
      await message(String(e), { title: "Update check failed", kind: "error" });
    }
  }
}

const generalPane: Pane = {
  id: "general", label: "General",
  render(root) {
    root.innerHTML = `<h3>General</h3>
      <label class="check"><input id="g-auto" type="checkbox"> Run edits and commands without asking</label>
      <label>Font size (px)<input id="g-font" type="number" min="11" max="20" step="1"></label>
      <h3 style="margin-top: 18px">Updates</h3>
      <div class="line">
        <button type="button" id="g-check-updates">Check for updates</button>
        <span id="g-update-status" class="note">v${APP_VERSION}</span>
      </div>`;
    fld("g-auto").checked = draft.autoApprove;
    fld("g-font").value = String(draft.fontSize);
    $("g-check-updates").onclick = () => checkForUpdates(false);
  },
  collect() {
    if (!document.getElementById("g-auto")) return;
    draft.autoApprove = fld("g-auto").checked;
    draft.fontSize = Math.min(20, Math.max(11, parseInt(fld("g-font").value, 10) || 13));
  },
};

const providersPane: Pane = {
  id: "providers", label: "Providers",
  collect: readFields,
  render(root) {
    const presetOptions = Object.entries(PRESETS).map(([k, v]) => `<option value="${k}">${esc(v.name)}</option>`).join("");
    root.innerHTML = `<h3>AI providers</h3>
      <div class="line">
        <label style="flex: 1; margin: 0;">Active profile<select id="p-select"></select></label>
        <button type="button" id="p-del" style="align-self: flex-end;" title="Delete this profile">Delete</button>
        <button type="button" id="p-add" style="align-self: flex-end;" title="Add new profile">+ New</button>
      </div>
      <label>Service Preset (Auto-fills Base URL)
        <select id="s-preset">
          <option value="">— Select provider to auto-fill Base URL —</option>
          ${presetOptions}
        </select>
      </label>
      <label>Name<input id="s-name" type="text" placeholder="e.g. My Provider"></label>
      <label>Base URL<input id="s-url" type="text" placeholder="https://..."></label>
      <label>API key
        <div class="input-with-btn">
          <input id="s-key" type="password" autocomplete="off" placeholder="sk-...">
          <button type="button" id="btn-toggle-key" title="Show or hide API key">Show</button>
        </div>
      </label>
      <label>Model
        <div class="model-picker-wrap">
          <div class="input-with-btn">
            <input id="s-model" type="text" placeholder="Type to search or enter model name..." autocomplete="off">
            <button type="button" id="btn-fetch-models" title="Fetch live models from provider">Fetch</button>
          </div>
          <div id="model-dropdown" class="model-dropdown hidden"></div>
        </div>
      </label>
      <div class="conn-status" id="s-status"></div>
      <details class="advanced-sec">
        <summary>Advanced: Token pricing (optional)</summary>
        <label>Price per 1M input tokens, USD<input id="s-pin" type="text" inputmode="decimal"></label>
        <label>Price per 1M output tokens, USD<input id="s-pout" type="text" inputmode="decimal"></label>
      </details>
      <p class="note">Keys are stored on this computer in plain text. Local models (Ollama, LM Studio) need no key.</p>`;

    const sel = $<HTMLSelectElement>("p-select");
    const presetSel = $<HTMLSelectElement>("s-preset");
    const modelInput = $<HTMLInputElement>("s-model");
    const dropdown = $("model-dropdown");
    const statusEl = $("s-status");
    let availableModels: string[] = [];
    let isFetching = false;

    const fillSelect = () => {
      sel.innerHTML = "";
      for (const p of draft.items) {
        const o = document.createElement("option");
        o.value = p.id; o.textContent = p.name;
        sel.appendChild(o);
      }
      sel.value = draftId;
    };

    const fillFields = () => {
      const p = draftProfile();
      fld("s-name").value = p.name; fld("s-url").value = p.baseUrl; fld("s-key").value = p.apiKey;
      fld("s-model").value = p.model; fld("s-pin").value = p.priceIn; fld("s-pout").value = p.priceOut;
      const foundPreset = Object.entries(PRESETS).find(([_, v]) => v.baseUrl && v.baseUrl.toLowerCase() === p.baseUrl.toLowerCase());
      if (foundPreset) {
        presetSel.value = foundPreset[0];
      } else {
        presetSel.value = p.baseUrl ? "custom" : "";
      }
      statusEl.className = "conn-status";
      statusEl.textContent = "";
      availableModels = [];
      dropdown.classList.add("hidden");
      if (p.baseUrl && (p.apiKey || isLocal(p.baseUrl))) {
        doFetch(true);
      }
    };

    presetSel.onchange = () => {
      const chosen = presetSel.value;
      if (!chosen || !PRESETS[chosen]) return;
      const item = PRESETS[chosen];
      fld("s-url").value = item.baseUrl;
      const curName = fld("s-name").value.trim();
      if (!curName || curName === "Provider" || curName === "None" || Object.values(PRESETS).some(x => x.name === curName)) {
        fld("s-name").value = item.name;
      }
      if (!fld("s-model").value.trim() && item.model) {
        fld("s-model").value = item.model;
      }
      readFields();
      fillSelect();
      if (item.baseUrl && (fld("s-key").value.trim() || isLocal(item.baseUrl))) {
        doFetch(true);
      }
    };

    fillSelect();
    fillFields();

    let keyVisible = false;
    $("btn-toggle-key").onclick = () => {
      keyVisible = !keyVisible;
      fld("s-key").type = keyVisible ? "text" : "password";
      $("btn-toggle-key").textContent = keyVisible ? "Hide" : "Show";
    };

    const renderDropdown = (query = "") => {
      const q = query.trim().toLowerCase();
      const matches = q ? availableModels.filter(m => m.toLowerCase().includes(q)) : availableModels;
      if (!matches.length) {
        if (!availableModels.length) {
          dropdown.innerHTML = `<div style="padding: 8px 10px; color: var(--dim); font-size: 11px;">No models loaded. Click "Fetch" or type model name.</div>`;
        } else {
          dropdown.innerHTML = `<div style="padding: 8px 10px; color: var(--dim); font-size: 11px;">No matching models. You can still use "${esc(query)}".</div>`;
        }
        dropdown.classList.remove("hidden");
        return;
      }

      const isOpenRouter = draftProfile().baseUrl.toLowerCase().includes("openrouter.ai");
      dropdown.innerHTML = "";
      for (const m of matches.slice(0, 100)) {
        const isFree = m.toLowerCase().includes(":free") || isLocal(draftProfile().baseUrl);
        const item = el("div", `model-item${m === modelInput.value ? " selected" : ""}`);
        item.setAttribute("data-model", m);
        let badge = "";
        if (isFree) {
          badge = `<span class="badge-free">FREE</span>`;
        } else if (isOpenRouter) {
          badge = `<span class="badge-pro">PRO</span>`;
        }
        item.innerHTML = `<span class="m-name">${esc(m)}</span>${badge}`;
        item.onclick = (e) => {
          e.stopPropagation();
          modelInput.value = m;
          readFields();
          dropdown.classList.add("hidden");
        };
        dropdown.appendChild(item);
      }
      dropdown.classList.remove("hidden");
    };

    modelInput.onfocus = () => {
      renderDropdown(modelInput.value);
    };

    modelInput.oninput = () => {
      readFields();
      renderDropdown(modelInput.value);
    };

    document.addEventListener("click", e => {
      if (!modelInput.contains(e.target as Node) && !dropdown.contains(e.target as Node)) {
        dropdown.classList.add("hidden");
      }
    });

    const doFetch = async (silent = false) => {
      readFields();
      const prof = draftProfile();
      if (!prof.baseUrl) {
        if (!silent) {
          statusEl.className = "conn-status err";
          statusEl.textContent = "Please enter Base URL first.";
        }
        return;
      }
      if (isFetching) return;
      isFetching = true;
      statusEl.className = "conn-status loading";
      statusEl.textContent = "Fetching models…";
      try {
        const res = await invoke<{ models: string[]; balance_info: string | null }>("test_connection", { settings: toSettings(prof) });
        availableModels = res.models;
        isFetching = false;
        statusEl.className = "conn-status ok";
        if (res.balance_info) {
          statusEl.textContent = `✓ Connected · ${res.balance_info} · ${res.models.length} models available`;
        } else {
          statusEl.textContent = `✓ Connected · ${res.models.length} models available`;
        }
        if (document.activeElement === modelInput) {
          renderDropdown(modelInput.value);
        }
      } catch (e) {
        isFetching = false;
        if (!silent) {
          statusEl.className = "conn-status err";
          statusEl.textContent = `✕ Connection failed: ${e}`;
        } else {
          statusEl.className = "conn-status";
          statusEl.textContent = "";
        }
      }
    };

    $("btn-fetch-models").onclick = () => doFetch(false);

    let debounceTimer: any = null;
    fld("s-key").oninput = () => {
      readFields();
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        if (fld("s-key").value.trim().length > 5) {
          doFetch(true);
        }
      }, 700);
    };
    fld("s-url").oninput = () => {
      readFields();
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        if (isLocal(fld("s-url").value)) {
          doFetch(true);
        }
      }, 700);
    };

    sel.onchange = () => { readFields(); draftId = sel.value; fillSelect(); fillFields(); };
    $("p-add").onclick = () => {
      readFields();
      const chosen = presetSel.value || "gemini";
      const p = newProfile(PRESETS[chosen] ? chosen : "gemini");
      draft.items.push(p); draftId = p.id;
      fillSelect(); fillFields();
    };
    $("p-del").onclick = () => {
      if (draft.items.length <= 1) return;
      draft.items = draft.items.filter(p => p.id !== draftId);
      draftId = draft.items[0].id;
      fillSelect(); fillFields();
    };
  },
};

function statsHtml(s: Stats) {
  const t = s.total;
  const hit = t.prompt_tokens ? Math.round((100 * t.cache_hit_tokens) / t.prompt_tokens) : 0;
  const row = (n: string, m: Totals) =>
    kv(esc(n), `${m.runs} runs · ${fmtN(m.prompt_tokens)} in / ${fmtN(m.completion_tokens)} out · ${fmtCost(m.cost_usd)} · ${fmtMs(m.duration_ms)}`);
  let h = "<h4>All time</h4>" +
    kv("runs", fmtN(t.runs)) + kv("model calls", fmtN(t.steps)) + kv("time working", fmtMs(t.duration_ms)) +
    kv("model / tools", `${fmtMs(t.model_ms)} / ${fmtMs(t.tool_ms)}`) +
    kv("tokens in / out", `${fmtN(t.prompt_tokens)} / ${fmtN(t.completion_tokens)}`) +
    kv("cache hits", `${fmtN(t.cache_hit_tokens)} (${hit}% of input)`) + kv("estimated cost", fmtCost(t.cost_usd)) +
    kv("tool calls", `${fmtN(t.tool_calls)}, ${fmtN(t.tool_failed)} failed`) + kv("files changed", fmtN(t.files_changed)) +
    kv("lines added / removed", `+${fmtN(t.lines_added)} / -${fmtN(t.lines_removed)}`) +
    kv("stopped / errors", `${t.cancelled} / ${t.errors}`);

  const keys = Object.entries(s.by_key).sort((a, b) => b[1].runs - a[1].runs);
  h += "<h4>By API key</h4>" + (keys.length ? keys.map(([n, m]) => row(n, m)).join("") : `<p class="note">No data yet.</p>`);
  const models = Object.entries(s.by_model).sort((a, b) => b[1].runs - a[1].runs);
  if (models.length) h += "<h4>By model</h4>" + models.map(([n, m]) => row(n, m)).join("");

  const days = Object.entries(s.by_day).sort((a, b) => b[0].localeCompare(a[0])).slice(0, 14);
  if (days.length) {
    const max = Math.max(...days.map(([, d]) => d.prompt_tokens + d.completion_tokens), 1);
    h += "<h4>Last days (tokens)</h4>" + days.map(([d, v]) => {
      const tok = v.prompt_tokens + v.completion_tokens;
      return `<div class="bar"><span>${d}</span><i style="width:${Math.round((100 * tok) / max)}%"></i><b>${fmtN(tok)}</b></div>`;
    }).join("");
  }
  const tl = Object.entries(s.by_tool).sort((a, b) => b[1].calls - a[1].calls);
  if (tl.length) {
    h += "<h4>Tools</h4>" + tl.map(([n, v]) =>
      kv(esc(n), `${fmtN(v.calls)} calls${v.failed ? `, ${v.failed} failed` : ""} · avg ${fmtMs(Math.round(v.ms / Math.max(v.calls, 1)))}`)).join("");
  }
  return h + `<p class="note">Keys are identified by name and their last 4 characters. Cost needs prices set under Providers.</p>`;
}

const statsPane: Pane = {
  id: "stats", label: "Statistics",
  async render(root) {
    root.innerHTML = `<h3>Statistics</h3><div id="st-body">loading…</div><div class="line"><button type="button" id="st-reset">Reset statistics</button></div>`;
    const load = async () => { $("st-body").innerHTML = statsHtml(await invoke<Stats>("get_stats")); };
    await load();
    $("st-reset").onclick = async () => {
      if (await ask("Reset all statistics? This cannot be undone.", { title: "Reset statistics", kind: "warning" })) {
        await invoke("reset_stats");
        await load();
      }
    };
  },
};

// add new settings sections here
const panes: Pane[] = [generalPane, providersPane, statsPane];

function showPane(id: string) {
  panes.find(p => p.id === paneId)?.collect?.();
  paneId = id;
  const nav = $("set-nav");
  nav.innerHTML = "";
  for (const p of panes) {
    const b = el("button", p.id === id ? "active" : "");
    b.textContent = p.label;
    b.onclick = () => showPane(p.id);
    nav.appendChild(b);
  }
  const root = $("set-pane");
  root.innerHTML = "";
  panes.find(p => p.id === id)?.render(root);
}

function openSettings(pane = "general") {
  draft = JSON.parse(JSON.stringify(store));
  draftId = draft.items.some(p => p.id === draft.active) ? draft.active : draft.items[0].id;
  paneId = pane;
  showPane(pane);
  dlg.showModal();
}
$("btn-settings").onclick = () => openSettings("general");
$("btn-stats").onclick = () => openSettings("stats");
$("s-cancel").onclick = () => dlg.close();
$("s-save").onclick = () => {
  panes.find(p => p.id === paneId)?.collect?.();
  draft.active = draftId;
  store = draft;
  setSaved("profiles", JSON.stringify(store));
  applyFont();
  showModel();
  dlg.close();
};

/* ================= boot ================= */
listen<Env>("agent-event", e => onEvent(e.payload));
applyFont();
setPanel(getSaved("panel") !== "0");
(async () => {
  const initialSpace = (getSaved("space") as "chats" | "projects") || "chats";
  currentSpace = initialSpace;
  modeChats.classList.toggle("active", initialSpace === "chats");
  modeProjects.classList.toggle("active", initialSpace === "projects");
  sideEl.classList.toggle("hidden", initialSpace === "chats");

  const infos = await invoke<SessionInfo[]>("list_sessions");
  for (const i of infos) {
    makeUI(i);
    if (i.kind === "agent" && i.workspace) {
      addRecentProject(i.workspace);
    }
  }
  if (!order.length) {
    await newSession(undefined, initialSpace === "chats" ? "chat" : "agent");
    return;
  }

  const savedForSpace = getSaved(`active.${initialSpace}`);
  const matching = order.filter(id => {
    const u = sessions.get(id);
    return u && (initialSpace === "chats" ? u.kind === "chat" : u.kind === "agent");
  });

  if (savedForSpace && matching.includes(savedForSpace)) {
    await activate(savedForSpace);
  } else if (matching.length > 0) {
    await activate(matching[matching.length - 1]);
  } else {
    await newSession(undefined, initialSpace === "chats" ? "chat" : "agent");
  }

  setTimeout(() => { checkForUpdates(true); }, 3000);
})();
