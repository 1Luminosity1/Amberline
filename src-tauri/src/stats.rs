use crate::{Summary, ToolStat};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashMap},
    path::PathBuf,
};
use tauri::{AppHandle, Manager};

#[derive(Serialize, Deserialize, Default, Clone)]
#[serde(default)]
pub struct Totals {
    pub runs: u64,
    pub steps: u64,
    pub duration_ms: u64,
    pub model_ms: u64,
    pub tool_ms: u64,
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub cache_hit_tokens: u64,
    pub cost_usd: f64,
    pub tool_calls: u64,
    pub tool_failed: u64,
    pub files_changed: u64,
    pub lines_added: u64,
    pub lines_removed: u64,
    pub cancelled: u64,
    pub errors: u64,
}

impl Totals {
    fn add(&mut self, s: &Summary) {
        self.runs += 1;
        self.steps += s.steps as u64;
        self.duration_ms += s.duration_ms;
        self.model_ms += s.model_ms;
        self.tool_ms += s.tool_ms;
        self.prompt_tokens += s.prompt_tokens;
        self.completion_tokens += s.completion_tokens;
        self.cache_hit_tokens += s.cache_hit_tokens;
        self.cost_usd += s.cost_usd.unwrap_or(0.0);
        for t in s.tools.values() {
            self.tool_calls += t.calls as u64;
            self.tool_failed += t.failed as u64;
        }
        self.files_changed += s.files_changed.len() as u64;
        self.lines_added += s.lines_added;
        self.lines_removed += s.lines_removed;
        if s.cancelled {
            self.cancelled += 1;
        }
        self.errors += s.errors as u64;
    }
}

/// Lifetime statistics, kept in stats.json in the app data folder.
#[derive(Serialize, Deserialize, Default, Clone)]
#[serde(default)]
pub struct Stats {
    pub total: Totals,
    pub by_model: HashMap<String, Totals>,
    pub by_key: HashMap<String, Totals>,
    pub by_day: BTreeMap<String, Totals>,
    pub by_tool: HashMap<String, ToolStat>,
}

fn file(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("stats.json"))
}

pub fn load(app: &AppHandle) -> Stats {
    file(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

fn save(app: &AppHandle, s: &Stats) {
    if let Some(p) = file(app) {
        if let Some(dir) = p.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if let Ok(t) = serde_json::to_string_pretty(s) {
            let _ = std::fs::write(p, t);
        }
    }
}

pub fn record(app: &AppHandle, s: &Summary, day: &str) {
    let mut st = load(app);
    st.total.add(s);
    let key = if s.provider.is_empty() { s.model.clone() } else { format!("{} / {}", s.provider, s.model) };
    st.by_model.entry(key).or_default().add(s);
    let kid = if s.key_id.is_empty() { "unknown".to_string() } else { s.key_id.clone() };
    st.by_key.entry(kid).or_default().add(s);
    st.by_day.entry(day.to_string()).or_default().add(s);
    for (name, t) in &s.tools {
        let e = st.by_tool.entry(name.clone()).or_default();
        e.calls += t.calls;
        e.failed += t.failed;
        e.ms += t.ms;
    }
    save(app, &st);
}

pub fn reset(app: &AppHandle) {
    save(app, &Stats::default());
}
