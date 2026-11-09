mod agent;
mod provider;
mod sessions;
mod stats;
mod tools;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sessions::{Session, SessionData, SessionInfo};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex as StdMutex,
    },
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::oneshot;

/// Active provider profile, sent by the UI with every request.
#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub api_key: String,
    pub base_url: String,
    pub model: String,
    pub auto_approve: bool,
    #[serde(default)]
    pub provider: String,
    #[serde(default)]
    pub key_id: String,
    #[serde(default)]
    pub price_in: Option<f64>,
    #[serde(default)]
    pub price_out: Option<f64>,
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(default)]
pub struct ToolStat {
    pub calls: u32,
    pub failed: u32,
    pub ms: u64,
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(default)]
pub struct StepStat {
    pub step: u32,
    pub model_ms: u64,
    pub first_token_ms: u64,
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub tool_calls: u32,
    pub tool_ms: u64,
}

/// Full statistics of one agent run.
#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(default)]
pub struct Summary {
    pub provider: String,
    pub key_id: String,
    pub model: String,
    pub duration_ms: u64,
    pub model_ms: u64,
    pub tool_ms: u64,
    pub approval_wait_ms: u64,
    pub steps: u32,
    pub tools: HashMap<String, ToolStat>,
    pub step_stats: Vec<StepStat>,
    pub files_changed: Vec<String>,
    pub lines_added: u64,
    pub lines_removed: u64,
    pub bytes_written: u64,
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub cache_hit_tokens: u64,
    pub cost_usd: Option<f64>,
    pub approvals_allowed: u32,
    pub approvals_denied: u32,
    pub errors: u32,
    pub cancelled: bool,
}

/// Every action of the agent is one of these events. The UI builds both the
/// chat feed and the activity panel from this single stream.
#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AgentEvent {
    Text { delta: String },
    Reasoning { delta: String },
    ToolStart { id: String, name: String, args: Value },
    ToolEnd { id: String, ok: bool, output: String, ms: u64 },
    Approval { id: String, name: String, args: Value },
    Usage { prompt: u64, completion: u64 },
    Done { summary: Summary },
    Error { message: String },
}

#[derive(Serialize, Clone)]
struct Envelope<'a> {
    session: &'a str,
    #[serde(flatten)]
    ev: AgentEvent,
}

pub fn emit(app: &AppHandle, sid: &str, ev: AgentEvent) {
    let _ = app.emit("agent-event", Envelope { session: sid, ev });
}

pub struct AppState {
    pub sessions: StdMutex<HashMap<String, Session>>,
    pub cancels: StdMutex<HashMap<String, Arc<AtomicBool>>>,
    /// key is "<session id>:<tool call id>"
    pub approvals: StdMutex<HashMap<String, oneshot::Sender<bool>>>,
    pub default_workspace: StdMutex<PathBuf>,
}

#[derive(Serialize)]
struct Entry {
    name: String,
    is_dir: bool,
}

fn workspace_of(state: &AppState, sid: &str) -> Result<PathBuf, String> {
    let g = state.sessions.lock().unwrap();
    g.get(sid)
        .map(|s| PathBuf::from(&s.workspace))
        .ok_or_else(|| "No such session".to_string())
}

fn cancel_session(state: &AppState, sid: &str) {
    if let Some(c) = state.cancels.lock().unwrap().get(sid) {
        c.store(true, Ordering::SeqCst);
    }
    // dropping the senders makes pending approvals resolve as "denied"
    let prefix = format!("{sid}:");
    state.approvals.lock().unwrap().retain(|k, _| !k.starts_with(&prefix));
}

#[tauri::command]
fn list_sessions(state: State<'_, AppState>) -> Vec<SessionInfo> {
    let g = state.sessions.lock().unwrap();
    let mut v: Vec<SessionInfo> = g.values().map(|s| s.info()).collect();
    v.sort_by_key(|s| s.created);
    v
}

#[tauri::command]
fn create_session(
    app: AppHandle,
    state: State<'_, AppState>,
    workspace: Option<String>,
    kind: Option<String>,
) -> Result<SessionInfo, String> {
    let k = kind.unwrap_or_else(|| {
        if workspace.as_deref().map_or(false, |w| !w.is_empty()) {
            "agent".to_string()
        } else {
            "chat".to_string()
        }
    });
    let ws = match workspace {
        Some(w) if !w.is_empty() => {
            if !PathBuf::from(&w).is_dir() {
                return Err("Not a directory".into());
            }
            w
        }
        _ => String::new(),
    };
    let now = sessions::now_ms();
    let s = Session {
        id: sessions::new_id(),
        workspace: ws,
        kind: k,
        created: now,
        updated: now,
        ..Default::default()
    };
    let info = s.info();
    sessions::save(&app, &s);
    state.sessions.lock().unwrap().insert(s.id.clone(), s);
    Ok(info)
}

#[tauri::command]
fn convert_to_agent(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    workspace: String,
) -> Result<SessionInfo, String> {
    if !PathBuf::from(&workspace).is_dir() {
        return Err("Not a directory".into());
    }
    let mut g = state.sessions.lock().unwrap();
    let s = g.get_mut(&id).ok_or_else(|| "No such session".to_string())?;
    s.kind = "agent".to_string();
    s.workspace = workspace;
    s.updated = sessions::now_ms();
    let info = s.info();
    sessions::save(&app, s);
    Ok(info)
}

#[tauri::command]
fn get_session(id: String, state: State<'_, AppState>) -> Result<SessionData, String> {
    let g = state.sessions.lock().unwrap();
    let s = g.get(&id).ok_or_else(|| "No such session".to_string())?;
    Ok(SessionData { info: s.info(), history: s.history.clone(), summaries: s.summaries.clone() })
}

#[tauri::command]
fn rename_session(app: AppHandle, id: String, title: String, state: State<'_, AppState>) {
    let mut g = state.sessions.lock().unwrap();
    if let Some(s) = g.get_mut(&id) {
        s.title = title.chars().take(80).collect();
        sessions::save(&app, s);
    }
}

#[tauri::command]
fn close_session(app: AppHandle, id: String, state: State<'_, AppState>) {
    cancel_session(&state, &id);
    state.sessions.lock().unwrap().remove(&id);
    sessions::remove(&app, &id);
}

#[tauri::command]
fn list_files(session_id: String, rel: String, state: State<'_, AppState>) -> Result<Vec<Entry>, String> {
    let ws = workspace_of(&state, &session_id)?;
    let dir = tools::resolve(&ws, &rel)?;
    let mut out: Vec<Entry> = std::fs::read_dir(dir)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .map(|e| Entry {
            name: e.file_name().to_string_lossy().to_string(),
            is_dir: e.path().is_dir(),
        })
        .filter(|e| !tools::SKIP_DIRS.contains(&e.name.as_str()))
        .collect();
    out.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then(a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(out)
}

#[tauri::command]
async fn send_message(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    prompt: String,
    settings: Settings,
    day: String,
) -> Result<(), String> {
    let (history, workspace) = {
        let mut g = state.sessions.lock().unwrap();
        let s = g.get_mut(&session_id).ok_or_else(|| "No such session".to_string())?;
        if s.running {
            return Err("This session is already running".into());
        }
        s.running = true;
        if s.title.is_empty() {
            s.title = prompt.chars().take(48).collect();
        }
        (s.history.clone(), PathBuf::from(&s.workspace))
    };
    agent::run(&app, &state, &session_id, history, workspace, prompt, settings, day).await;
    Ok(())
}

#[tauri::command]
fn stop(session_id: String, state: State<'_, AppState>) {
    cancel_session(&state, &session_id);
}

#[tauri::command]
fn approve(session_id: String, id: String, allow: bool, state: State<'_, AppState>) {
    if let Some(tx) = state.approvals.lock().unwrap().remove(&format!("{session_id}:{id}")) {
        let _ = tx.send(allow);
    }
}

/// Checks the connection and returns the model ids the server reports.
#[derive(Serialize)]
struct ConnectionInfo {
    models: Vec<String>,
    balance_info: Option<String>,
}

#[tauri::command]
async fn test_connection(settings: Settings) -> Result<ConnectionInfo, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;
    let url = format!("{}/models", settings.base_url.trim_end_matches('/'));
    let mut req = client.get(url);
    if !settings.api_key.is_empty() {
        req = req.bearer_auth(&settings.api_key);
    }
    let resp = req.send().await.map_err(|e| e.to_string())?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("{status}: {}", text.chars().take(200).collect::<String>()));
    }
    let v: Value = serde_json::from_str(&text).map_err(|_| "Unexpected response from the server".to_string())?;
    let mut ids: Vec<String> = Vec::new();
    if let Some(data) = v["data"].as_array() {
        for m in data {
            if let Some(id) = m["id"].as_str() {
                ids.push(id.to_string());
            }
        }
    }
    if ids.is_empty() {
        if let Some(models) = v["models"].as_array() {
            for m in models {
                if let Some(name) = m["name"].as_str().or_else(|| m["id"].as_str()).or_else(|| m["model"].as_str()) {
                    ids.push(name.to_string());
                }
            }
        }
    }
    ids.sort();
    ids.dedup();

    let mut balance_info: Option<String> = None;
    let base = settings.base_url.to_lowercase();
    if base.contains("openrouter.ai") && !settings.api_key.is_empty() {
        if let Ok(b_resp) = client
            .get("https://openrouter.ai/api/v1/auth/key")
            .bearer_auth(&settings.api_key)
            .send()
            .await
        {
            if b_resp.status().is_success() {
                if let Ok(b_val) = b_resp.json::<Value>().await {
                    let is_free = b_val["data"]["is_free_tier"].as_bool().unwrap_or(false);
                    let usage = b_val["data"]["usage"].as_f64().unwrap_or(0.0);
                    let limit = b_val["data"]["limit"].as_f64();
                    if is_free {
                        balance_info = Some("Free Tier".to_string());
                    } else if let Some(lim) = limit {
                        let remaining = (lim - usage).max(0.0);
                        balance_info = Some(format!("Credits: ${remaining:.2}"));
                    } else {
                        balance_info = Some(format!("Usage: ${usage:.2}"));
                    }
                }
            }
        }
    } else if base.contains("deepseek.com") && !settings.api_key.is_empty() {
        if let Ok(b_resp) = client
            .get("https://api.deepseek.com/user/balance")
            .bearer_auth(&settings.api_key)
            .send()
            .await
        {
            if b_resp.status().is_success() {
                if let Ok(b_val) = b_resp.json::<Value>().await {
                    if let Some(info) = b_val["balance_infos"].as_array().and_then(|a| a.first()) {
                        let curr = info["currency"].as_str().unwrap_or("CNY");
                        let total = info["total_balance"].as_str().unwrap_or("0");
                        balance_info = Some(format!("Balance: {total} {curr}"));
                    }
                }
            }
        }
    }

    Ok(ConnectionInfo {
        models: ids,
        balance_info,
    })
}

#[tauri::command]
fn get_stats(app: AppHandle) -> stats::Stats {
    stats::load(&app)
}

#[tauri::command]
fn reset_stats(app: AppHandle) {
    stats::reset(&app);
}

#[tauri::command]
fn win_minimize(window: tauri::Window) {
    let _ = window.minimize();
}

#[tauri::command]
fn win_maximize(window: tauri::Window) {
    if window.is_maximized().unwrap_or(false) {
        let _ = window.unmaximize();
    } else {
        let _ = window.maximize();
    }
}

#[tauri::command]
fn win_fullscreen(window: tauri::Window) {
    if let Ok(fs) = window.is_fullscreen() {
        let _ = window.set_fullscreen(!fs);
    }
}

#[tauri::command]
fn win_start_drag(window: tauri::Window) {
    let _ = window.start_dragging();
}

#[tauri::command]
fn win_close(window: tauri::Window) {
    let _ = window.close();
}

#[tauri::command]
fn get_default_projects_dir(app: AppHandle) -> Result<String, String> {
    let base = app
        .path()
        .document_dir()
        .or_else(|_| app.path().home_dir())
        .map_err(|e| e.to_string())?;
    let projects = base.join("Mistline").join("Projects");
    let _ = std::fs::create_dir_all(&projects);
    Ok(projects.to_string_lossy().to_string())
}

#[tauri::command]
fn create_project(app: AppHandle, name: Option<String>) -> Result<String, String> {
    let base = app
        .path()
        .document_dir()
        .or_else(|_| app.path().home_dir())
        .map_err(|e| e.to_string())?;
    let projects = base.join("Mistline").join("Projects");
    let _ = std::fs::create_dir_all(&projects);

    let raw_name = name.unwrap_or_default();
    let trimmed = raw_name.trim();
    let project_name = if !trimmed.is_empty() {
        let clean: String = trimmed
            .chars()
            .filter(|c| c.is_alphanumeric() || *c == '-' || *c == '_' || *c == ' ')
            .collect();
        let clean = clean.trim().to_string();
        if clean.is_empty() { "Project-1".to_string() } else { clean }
    } else {
        let mut idx = 1;
        loop {
            let candidate = format!("Project-{idx}");
            if !projects.join(&candidate).exists() {
                break candidate;
            }
            idx += 1;
        }
    };

    let p = projects.join(&project_name);
    std::fs::create_dir_all(&p).map_err(|e| format!("Failed to create directory: {e}"))?;
    let readme = p.join("README.md");
    if !readme.exists() {
        let _ = std::fs::write(&readme, format!("# {project_name}\n\nProject created with Mistline.\n"));
    }
    Ok(p.to_string_lossy().to_string())
}

#[tauri::command]
fn open_in_explorer(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        let cmd = if cfg!(target_os = "macos") { "open" } else { "xdg-open" };
        std::process::Command::new(cmd)
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(move |app| {
            let loaded = sessions::dir(app.handle())
                .map(|d| sessions::load_all(&d))
                .unwrap_or_default();
            app.manage(AppState {
                sessions: StdMutex::new(loaded),
                cancels: StdMutex::new(HashMap::new()),
                approvals: StdMutex::new(HashMap::new()),
                default_workspace: StdMutex::new(PathBuf::new()),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_sessions,
            create_session,
            convert_to_agent,
            get_session,
            rename_session,
            close_session,
            list_files,
            send_message,
            stop,
            approve,
            test_connection,
            get_stats,
            reset_stats,
            win_minimize,
            win_maximize,
            win_fullscreen,
            win_close,
            win_start_drag,
            get_default_projects_dir,
            create_project,
            open_in_explorer
        ])
        .run(tauri::generate_context!())
        .expect("error while running Mistline");
}
