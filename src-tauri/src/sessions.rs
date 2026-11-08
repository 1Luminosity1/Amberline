use crate::Summary;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager};

/// One chat session. Each session has its own history and workspace folder
/// and is stored as its own file in the app data folder.
#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(default)]
pub struct Session {
    pub id: String,
    pub title: String,
    pub workspace: String,
    pub created: u64,
    pub updated: u64,
    pub history: Vec<Value>,
    pub summaries: Vec<Summary>,
    pub kind: String,
    #[serde(skip)]
    pub running: bool,
}

#[derive(Serialize, Clone)]
pub struct SessionInfo {
    pub id: String,
    pub title: String,
    pub workspace: String,
    pub created: u64,
    pub updated: u64,
    pub kind: String,
    pub running: bool,
    pub runs: usize,
}

#[derive(Serialize)]
pub struct SessionData {
    pub info: SessionInfo,
    pub history: Vec<Value>,
    pub summaries: Vec<Summary>,
}

impl Session {
    pub fn info(&self) -> SessionInfo {
        let is_home = if !self.workspace.is_empty() {
            if let Some(h) = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")) {
                Path::new(&self.workspace) == Path::new(&h)
            } else {
                false
            }
        } else {
            false
        };
        let ws = if is_home && (self.kind.is_empty() || self.kind == "chat") {
            String::new()
        } else {
            self.workspace.clone()
        };
        let kind = if !self.kind.is_empty() {
            self.kind.clone()
        } else if ws.is_empty() {
            "chat".to_string()
        } else {
            "agent".to_string()
        };
        SessionInfo {
            id: self.id.clone(),
            title: self.title.clone(),
            workspace: ws,
            created: self.created,
            updated: self.updated,
            kind,
            running: self.running,
            runs: self.summaries.len(),
        }
    }
}

static COUNTER: AtomicU64 = AtomicU64::new(0);

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub fn new_id() -> String {
    format!("{:x}{:02x}", now_ms(), COUNTER.fetch_add(1, Ordering::Relaxed) % 256)
}

pub fn dir(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("sessions"))
}

fn safe(id: &str) -> bool {
    !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric())
}

pub fn save(app: &AppHandle, s: &Session) {
    if !safe(&s.id) {
        return;
    }
    if let Some(d) = dir(app) {
        let _ = std::fs::create_dir_all(&d);
        if let Ok(text) = serde_json::to_string(s) {
            let _ = std::fs::write(d.join(format!("{}.json", s.id)), text);
        }
    }
}

pub fn remove(app: &AppHandle, id: &str) {
    if !safe(id) {
        return;
    }
    if let Some(d) = dir(app) {
        let _ = std::fs::remove_file(d.join(format!("{id}.json")));
    }
}

pub fn load_all(dir: &Path) -> HashMap<String, Session> {
    let mut out = HashMap::new();
    let Ok(rd) = std::fs::read_dir(dir) else { return out };
    for e in rd.flatten() {
        let p = e.path();
        if p.extension().and_then(|x| x.to_str()) != Some("json") {
            continue;
        }
        if let Ok(text) = std::fs::read_to_string(&p) {
            if let Ok(mut s) = serde_json::from_str::<Session>(&text) {
                if safe(&s.id) {
                    if let Some(h) = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")) {
                        if !s.workspace.is_empty() && Path::new(&s.workspace) == Path::new(&h) {
                            s.workspace = String::new();
                            s.kind = "chat".to_string();
                        }
                    }
                    out.insert(s.id.clone(), s);
                }
            }
        }
    }
    out
}
