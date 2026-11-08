use crate::{emit, provider, sessions, stats, tools, AgentEvent, AppState, Settings, StepStat, Summary};
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Instant,
};
use tauri::AppHandle;
use tokio::sync::oneshot;

const MAX_STEPS: u32 = 30;

fn system_prompt(ws: &Path, is_chat: bool) -> String {
    if is_chat {
        "You are Amberline, a helpful, thoughtful, and accurate AI assistant. Answer clearly and concisely.".to_string()
    } else {
        let mut prompt = format!(
            "You are Amberline, a coding agent working inside the user's project.\n\
             Workspace: {}\nOS: {}\n\n\
             Use the tools to inspect and change files and to run commands. Read a file before editing it. \
             Prefer small exact edits (edit_file) over rewriting whole files. Keep answers short and concrete. \
             When a task is finished, say what you changed.",
            ws.display(),
            std::env::consts::OS
        );

        let candidates = [
            ws.join(".amberline").join("instructions.md"),
            ws.join("AGENTS.md"),
            ws.join("AMBERLINE.md"),
        ];
        for candidate in &candidates {
            if candidate.is_file() {
                if let Ok(content) = std::fs::read_to_string(candidate) {
                    prompt.push_str("\n\nProject Instructions:\n");
                    prompt.push_str(&content);
                    break;
                }
            }
        }
        prompt
    }
}

async fn ask(app: &AppHandle, st: &AppState, sid: &str, id: &str, name: &str, args: &Value) -> bool {
    let (tx, rx) = oneshot::channel();
    st.approvals.lock().unwrap().insert(format!("{sid}:{id}"), tx);
    emit(app, sid, AgentEvent::Approval { id: id.into(), name: name.into(), args: args.clone() });
    rx.await.unwrap_or(false)
}

fn lines(s: &str) -> u64 {
    s.lines().count() as u64
}

fn mark_changed(sum: &mut Summary, args: &Value) {
    if let Some(p) = args["path"].as_str() {
        if !sum.files_changed.iter().any(|f| f == p) {
            sum.files_changed.push(p.to_string());
        }
    }
}

pub async fn run(
    app: &AppHandle,
    st: &AppState,
    sid: &str,
    mut history: Vec<Value>,
    workspace: PathBuf,
    prompt: String,
    s: Settings,
    day: String,
) {
    let cancel = Arc::new(AtomicBool::new(false));
    st.cancels.lock().unwrap().insert(sid.to_string(), cancel.clone());

    let is_chat = workspace.as_os_str().is_empty();
    if history.is_empty() {
        history.push(json!({ "role": "system", "content": system_prompt(&workspace, is_chat) }));
    }
    history.push(json!({ "role": "user", "content": prompt }));

    let started = Instant::now();
    let mut sum = Summary {
        model: s.model.clone(),
        provider: s.provider.clone(),
        key_id: s.key_id.clone(),
        ..Default::default()
    };
    let client = reqwest::Client::new();
    let defs = if is_chat { json!([]) } else { tools::definitions() };

    for step in 0..MAX_STEPS {
        if cancel.load(Ordering::SeqCst) {
            sum.cancelled = true;
            break;
        }
        sum.steps += 1;

        let m0 = Instant::now();
        let result = provider::stream_chat(&client, &s, &history, &defs, app, sid, &cancel).await;
        let model_ms = m0.elapsed().as_millis() as u64;
        sum.model_ms += model_ms;

        let turn = match result {
            Ok(t) => t,
            Err(e) => {
                sum.errors += 1;
                emit(app, sid, AgentEvent::Error { message: e });
                break;
            }
        };
        sum.prompt_tokens += turn.prompt_tokens;
        sum.completion_tokens += turn.completion_tokens;
        sum.cache_hit_tokens += turn.cache_hit_tokens;
        emit(app, sid, AgentEvent::Usage { prompt: turn.prompt_tokens, completion: turn.completion_tokens });

        let mut stat = StepStat {
            step: sum.steps,
            model_ms,
            first_token_ms: turn.first_token_ms,
            prompt_tokens: turn.prompt_tokens,
            completion_tokens: turn.completion_tokens,
            tool_calls: 0,
            tool_ms: 0,
        };

        if turn.cancelled {
            sum.cancelled = true;
            sum.step_stats.push(stat);
            break;
        }

        let mut calls = turn.calls;
        for (i, c) in calls.iter_mut().enumerate() {
            if c.id.is_empty() {
                c.id = format!("call_{step}_{i}");
            }
        }

        if calls.is_empty() {
            history.push(json!({ "role": "assistant", "content": turn.content }));
            sum.step_stats.push(stat);
            break;
        }
        stat.tool_calls = calls.len() as u32;

        let tc: Vec<Value> = calls
            .iter()
            .map(|c| {
                json!({
                    "id": c.id,
                    "type": "function",
                    "function": {
                        "name": c.name,
                        "arguments": if c.args.is_empty() { "{}" } else { c.args.as_str() }
                    }
                })
            })
            .collect();
        history.push(json!({ "role": "assistant", "content": turn.content, "tool_calls": tc }));

        for c in calls {
            // every tool call needs a result in history, even when cancelled
            if cancel.load(Ordering::SeqCst) {
                sum.cancelled = true;
                history.push(json!({ "role": "tool", "tool_call_id": c.id, "content": "Cancelled by user." }));
                continue;
            }

            let args: Value =
                serde_json::from_str(if c.args.is_empty() { "{}" } else { &c.args }).unwrap_or(Value::Null);
            emit(app, sid, AgentEvent::ToolStart { id: c.id.clone(), name: c.name.clone(), args: args.clone() });
            let t = Instant::now();
            let mut wait_ms = 0u64;

            let (ok, out) = if args.is_null() {
                (false, "Invalid JSON arguments".to_string())
            } else {
                let allowed = if tools::needs_approval(&c.name) && !s.auto_approve {
                    let w = Instant::now();
                    let a = ask(app, st, sid, &c.id, &c.name, &args).await;
                    wait_ms = w.elapsed().as_millis() as u64;
                    sum.approval_wait_ms += wait_ms;
                    if a {
                        sum.approvals_allowed += 1;
                    } else {
                        sum.approvals_denied += 1;
                    }
                    a
                } else {
                    true
                };

                if !allowed {
                    (false, "The user denied this action.".to_string())
                } else {
                    // for write_file: how many lines are being replaced
                    let prev = if c.name == "write_file" {
                        tools::resolve(&workspace, args["path"].as_str().unwrap_or(""))
                            .ok()
                            .and_then(|p| std::fs::read_to_string(p).ok())
                            .map_or(0, |txt| lines(&txt))
                    } else {
                        0
                    };
                    let r = tools::execute(&workspace, &c.name, &args, &cancel).await;
                    if r.0 {
                        match c.name.as_str() {
                            "edit_file" => {
                                sum.lines_removed += lines(args["old_string"].as_str().unwrap_or(""));
                                sum.lines_added += lines(args["new_string"].as_str().unwrap_or(""));
                                mark_changed(&mut sum, &args);
                            }
                            "write_file" => {
                                let content = args["content"].as_str().unwrap_or("");
                                sum.lines_removed += prev;
                                sum.lines_added += lines(content);
                                sum.bytes_written += content.len() as u64;
                                mark_changed(&mut sum, &args);
                            }
                            _ => {}
                        }
                    }
                    r
                }
            };

            let ms = (t.elapsed().as_millis() as u64).saturating_sub(wait_ms);
            sum.tool_ms += ms;
            stat.tool_ms += ms;
            let e = sum.tools.entry(c.name.clone()).or_default();
            e.calls += 1;
            if !ok {
                e.failed += 1;
            }
            e.ms += ms;

            emit(app, sid, AgentEvent::ToolEnd { id: c.id.clone(), ok, output: out.clone(), ms });
            history.push(json!({ "role": "tool", "tool_call_id": c.id, "content": out }));
        }
        sum.step_stats.push(stat);
    }

    sum.duration_ms = started.elapsed().as_millis() as u64;
    if let (Some(pi), Some(po)) = (s.price_in, s.price_out) {
        sum.cost_usd = Some((sum.prompt_tokens as f64 * pi + sum.completion_tokens as f64 * po) / 1_000_000.0);
    }
    if sum.steps > 0 {
        stats::record(app, &sum, &day);
    }

    st.cancels.lock().unwrap().remove(sid);
    {
        let mut g = st.sessions.lock().unwrap();
        if let Some(sess) = g.get_mut(sid) {
            sess.history = history;
            sess.summaries.push(sum.clone());
            if sess.summaries.len() > 200 {
                let n = sess.summaries.len() - 200;
                sess.summaries.drain(..n);
            }
            sess.updated = sessions::now_ms();
            sess.running = false;
            sessions::save(app, sess);
        }
    }
    emit(app, sid, AgentEvent::Done { summary: sum });
}
