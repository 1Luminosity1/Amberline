use crate::{emit, AgentEvent, Settings};
use futures_util::StreamExt;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::AppHandle;

#[derive(Default)]
pub struct Call {
    pub id: String,
    pub name: String,
    pub args: String,
}

#[derive(Default)]
pub struct Turn {
    pub content: String,
    pub calls: Vec<Call>,
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub cache_hit_tokens: u64,
    pub first_token_ms: u64,
    pub cancelled: bool,
}

/// One streamed chat completion (OpenAI-compatible, works with DeepSeek).
pub async fn stream_chat(
    client: &reqwest::Client,
    s: &Settings,
    messages: &[Value],
    tools: &Value,
    app: &AppHandle,
    sid: &str,
    cancel: &AtomicBool,
) -> Result<Turn, String> {
    let url = format!("{}/chat/completions", s.base_url.trim_end_matches('/'));
    let body = json!({
        "model": s.model,
        "messages": messages,
        "tools": tools,
        "stream": true,
        "stream_options": { "include_usage": true }
    });

    let started = std::time::Instant::now();
    let mut req = client.post(url).json(&body);
    if !s.api_key.is_empty() {
        req = req.bearer_auth(&s.api_key);
    }
    let resp = req.send().await.map_err(|e| e.to_string())?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("{status}: {text}"));
    }

    let mut stream = resp.bytes_stream();
    let mut turn = Turn::default();
    let mut buf: Vec<u8> = Vec::new();

    'outer: while let Some(chunk) = stream.next().await {
        if cancel.load(Ordering::SeqCst) {
            turn.cancelled = true;
            break;
        }
        let chunk = chunk.map_err(|e| e.to_string())?;
        buf.extend_from_slice(&chunk);

        while let Some(pos) = buf.iter().position(|b| *b == b'\n') {
            let raw: Vec<u8> = buf.drain(..=pos).collect();
            let text = String::from_utf8_lossy(&raw);
            let line = text.trim();
            let Some(data) = line.strip_prefix("data:") else { continue };
            let data = data.trim();
            if data == "[DONE]" {
                break 'outer;
            }
            let Ok(v) = serde_json::from_str::<Value>(data) else { continue };

            if let Some(u) = v.get("usage").filter(|u| !u.is_null()) {
                turn.prompt_tokens = u["prompt_tokens"].as_u64().unwrap_or(0);
                turn.completion_tokens = u["completion_tokens"].as_u64().unwrap_or(0);
                turn.cache_hit_tokens = u["prompt_cache_hit_tokens"]
                    .as_u64()
                    .or_else(|| u["prompt_tokens_details"]["cached_tokens"].as_u64())
                    .unwrap_or(0);
            }
            let Some(delta) = v["choices"].get(0).map(|c| &c["delta"]) else { continue };

            if turn.first_token_ms == 0
                && (delta["content"].as_str().map_or(false, |t| !t.is_empty())
                    || delta["reasoning_content"].as_str().map_or(false, |t| !t.is_empty())
                    || delta["tool_calls"].is_array())
            {
                turn.first_token_ms = (started.elapsed().as_millis() as u64).max(1);
            }

            if let Some(t) = delta["content"].as_str() {
                if !t.is_empty() {
                    turn.content.push_str(t);
                    emit(app, sid, AgentEvent::Text { delta: t.to_string() });
                }
            }
            if let Some(t) = delta["reasoning_content"].as_str() {
                if !t.is_empty() {
                    emit(app, sid, AgentEvent::Reasoning { delta: t.to_string() });
                }
            }
            if let Some(tcs) = delta["tool_calls"].as_array() {
                for tc in tcs {
                    let idx = tc["index"].as_u64().unwrap_or(0) as usize;
                    while turn.calls.len() <= idx {
                        turn.calls.push(Call::default());
                    }
                    let c = &mut turn.calls[idx];
                    if let Some(id) = tc["id"].as_str() {
                        c.id = id.to_string();
                    }
                    if let Some(n) = tc["function"]["name"].as_str() {
                        c.name.push_str(n);
                    }
                    if let Some(a) = tc["function"]["arguments"].as_str() {
                        c.args.push_str(a);
                    }
                }
            }
        }
    }
    Ok(turn)
}
