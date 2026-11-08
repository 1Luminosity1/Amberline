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
  grok: { name: "xAI (Grok)", baseUrl: "https://api.x.ai/v1", model: "grok-2-latest" },
  deepseek: { name: "DeepSeek", baseUrl: "https://api.deepseek.com", model: "deepseek-chat" },
  openai: { name: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "gpt-4o" },
  openrouter: { name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", model: "anthropic/claude-3.5-sonnet" },
  groq: { name: "Groq (Fast)", baseUrl: "https://api.groq.com/openai/v1", model: "llama-3.3-70b-versatile" },
  mistral: { name: "Mistral AI", baseUrl: "https://api.mistral.ai/v1", model: "codestral-latest" },
  together: { name: "Together AI", baseUrl: "https://api.together.xyz/v1", model: "meta-llama/Llama-3.3-70B-Instruct-Turbo" },
  ollama: { name: "Ollama (local)", baseUrl: "http://localhost:11434/v1", model: "qwen2.5-coder" },
  lmstudio: { name: "LM Studio (local)", baseUrl: "http://localhost:1234/v1", model: "" },
  custom: { name: "Custom (OpenAI-compatible)", baseUrl: "", model: "" },
};
const uid = () => Math.random().toString(36).slice(2, 8);
const newProfile = (preset: string): Profile => ({ id: uid(), apiKey: "", priceIn: "", priceOut: "", ...PRESETS[preset] });

function loadStore(): Store {
  try {
    const raw = localStorage.getItem("amberline.profiles");
    if (raw) {
      const s = JSON.parse(raw) as Partial<Store>;
      if (s.items?.length) {
        return { active: s.active ?? s.items[0].id, autoApprove: !!s.autoApprove, fontSize: s.fontSize ?? 13, items: s.items };
      }
    }
    const old = JSON.parse(localStorage.getItem("amberline.settings") || "null");
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
function inline(t: string) {
  return esc(t).split(/\n{2,}/).filter(p => p.trim()).map(p =>
    `<p>${p.replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>").replace(/\n/g, "<br>")}</p>`
  ).join("");
}
function md(src: string) {
  return src.split("```").map((p, i) =>
    i % 2 ? `<pre><code>${esc(p.replace(/^[^\n]*\n/, ""))}</code></pre>` : inline(p)
  ).join("");
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
}
const sessions = new Map<string, UI>();
let order: string[] = [];
let activeId = "";
const cur = () => sessions.get(activeId);
let currentSpace: "chats" | "projects" = (localStorage.getItem("amberline.space") as "chats" | "projects") || "chats";

function showEmpty(ui: UI) {
  if (ui.kind === "chat") {
    ui.feed.innerHTML = `<div class="empty"><b>Amberline Chat</b><br>Ask anything. Pure conversational mode without folder access.<br>Click "Connect Project" above if you want to turn this into a coding agent.</div>`;
  } else {
    ui.feed.innerHTML = `<div class="empty"><b>Amberline Agent</b><br>Describe a task. The agent can read, edit files and run commands in <code>${esc(baseName(ui.workspace))}</code>.</div>`;
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
      ui.feed.appendChild(el("div", "msg user", esc(String(m.content))));
      a = null;
    } else if (m.role === "assistant") {
      if (!a) { a = el("div", "msg assistant"); ui.feed.appendChild(a); }
      if (m.content) a.appendChild(el("div", "", md(String(m.content))));
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
  localStorage.setItem("amberline.active", id);
  localStorage.setItem(`amberline.active.${ui.kind}`, id);
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
    } else {
      const dir = await open({ directory: true });
      if (typeof dir !== "string") return;
      ws = dir;
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
  ui.feed.appendChild(el("div", "msg user", esc(text)));
  ui.assistant = el("div", "msg assistant");
  ui.feed.appendChild(ui.assistant);
  ui.seg = null;
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

/* ================= agent events ================= */
function onEvent(ev: Env) {
  const ui = sessions.get(ev.session);
  if (!ui) return;
  const was = nearBottom(ui.feed);
  if (!ui.assistant) { ui.assistant = el("div", "msg assistant"); ui.feed.appendChild(ui.assistant); }
  const a = ui.assistant;

  switch (ev.type) {
    case "text": {
      if (!ui.seg || ui.seg.kind !== "text") {
        const e = el("div"); a.appendChild(e);
        ui.seg = { kind: "text", el: e, buf: "" };
        trace(ui, "answer", "writing response");
      }
      ui.seg.buf += ev.delta;
      ui.seg.el.innerHTML = md(ui.seg.buf);
      break;
    }
    case "reasoning": {
      if (!ui.seg || ui.seg.kind !== "reason") {
        const d = el("details", "think", "<summary>thinking</summary><div></div>");
        a.appendChild(d);
        ui.seg = { kind: "reason", el: d.querySelector("div") as HTMLElement, buf: "" };
        trace(ui, "think", "reasoning");
      }
      ui.seg.buf += ev.delta;
      ui.seg.el.textContent = ui.seg.buf;
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
    case "done":
      ui.summaries.push(ev.summary);
      trace(ui, "done", ev.summary.cancelled ? "stopped" : "finished");
      setRunning(ui, false);
      if (ui.id === activeId) renderPanel();
      break;
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
  localStorage.setItem("amberline.panel", show ? "1" : "0");
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
  localStorage.setItem("amberline.space", space);
  modeChats.classList.toggle("active", space === "chats");
  modeProjects.classList.toggle("active", space === "projects");
  sideEl.classList.toggle("hidden", space === "chats");

  renderTabs();

  if (activateDefault) {
    const curUI = cur();
    const matchesCurrent = curUI && (space === "chats" ? curUI.kind === "chat" : curUI.kind === "agent");
    if (!matchesCurrent) {
      const savedId = localStorage.getItem(`amberline.active.${space}`);
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
  if (currentSpace === "chats" || ui.kind === "chat" || !ui.workspace) {
    sideEl.classList.add("hidden");
    wsBtn.textContent = "no folder connected";
    wsBtn.title = "Chat mode · No folder connected";
    treeEl.innerHTML = "";
  } else {
    sideEl.classList.remove("hidden");
    wsBtn.textContent = baseName(ui.workspace);
    wsBtn.title = ui.workspace;
    await loadDir("", treeEl, 0);
  }
}
wsBtn.onclick = async () => {
  const dir = await open({ directory: true });
  if (typeof dir !== "string") return;
  try {
    await newSession(dir, "agent");
    setSpace("projects", false);
  } catch (e) {
    await message(String(e), { title: "Cannot open folder", kind: "error" });
  }
};

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

const APP_VERSION = "0.1.5";

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
          statusTxt.textContent = "Update installed. Restarting Amberline…";
          break;
      }
    });
    statusTxt.textContent = "Restarting Amberline…";
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
      if (statusEl) statusEl.textContent = `Amberline is up to date (v${APP_VERSION})`;
      if (!silent) {
        await message("You are using the latest version of Amberline.", { title: "Up to date", kind: "info" });
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
      <div class="line"><select id="p-select"></select><button type="button" id="p-del">Delete</button></div>
      <div class="line"><select id="p-preset">${presetOptions}</select><button type="button" id="p-add">Add provider</button></div>
      <label>Name<input id="s-name" type="text"></label>
      <label>Base URL<input id="s-url" type="text"></label>
      <label>API key<input id="s-key" type="password" autocomplete="off"></label>
      <label>Model<input id="s-model" type="text" list="model-list"></label>
      <datalist id="model-list"></datalist>
      <div class="line"><button type="button" id="s-test">Test connection</button><span id="s-status"></span></div>
      <label>Price per 1M input tokens, USD (optional, for cost estimates)<input id="s-pin" type="text" inputmode="decimal"></label>
      <label>Price per 1M output tokens, USD (optional)<input id="s-pout" type="text" inputmode="decimal"></label>
      <p class="note">Keys are stored on this computer in plain text. Local models (Ollama, LM Studio) need no key.</p>`;

    const sel = $<HTMLSelectElement>("p-select");
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
      $("s-status").textContent = "";
    };
    fillSelect(); fillFields();

    sel.onchange = () => { readFields(); draftId = sel.value; fillSelect(); fillFields(); };
    $("p-add").onclick = () => {
      readFields();
      const p = newProfile($<HTMLSelectElement>("p-preset").value);
      draft.items.push(p); draftId = p.id;
      fillSelect(); fillFields();
    };
    $("p-del").onclick = () => {
      if (draft.items.length <= 1) return;
      draft.items = draft.items.filter(p => p.id !== draftId);
      draftId = draft.items[0].id;
      fillSelect(); fillFields();
    };
    $("s-test").onclick = async () => {
      readFields();
      const st = $("s-status");
      st.textContent = "checking…";
      try {
        const ids = await invoke<string[]>("test_connection", { settings: toSettings(draftProfile()) });
        $("model-list").innerHTML = ids.map(i => `<option value="${esc(i)}"></option>`).join("");
        st.textContent = `connected, ${ids.length} models (pick one in the Model field)`;
      } catch (e) { st.textContent = String(e); }
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
  localStorage.setItem("amberline.profiles", JSON.stringify(store));
  applyFont();
  showModel();
  dlg.close();
};

/* ================= boot ================= */
listen<Env>("agent-event", e => onEvent(e.payload));
applyFont();
setPanel(localStorage.getItem("amberline.panel") !== "0");
(async () => {
  const initialSpace = (localStorage.getItem("amberline.space") as "chats" | "projects") || "chats";
  currentSpace = initialSpace;
  modeChats.classList.toggle("active", initialSpace === "chats");
  modeProjects.classList.toggle("active", initialSpace === "projects");
  sideEl.classList.toggle("hidden", initialSpace === "chats");

  const infos = await invoke<SessionInfo[]>("list_sessions");
  for (const i of infos) makeUI(i);
  if (!order.length) {
    await newSession(undefined, initialSpace === "chats" ? "chat" : "agent");
    return;
  }

  const savedForSpace = localStorage.getItem(`amberline.active.${initialSpace}`);
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
