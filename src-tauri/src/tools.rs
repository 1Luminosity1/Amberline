use serde_json::{json, Value};
use std::{
    path::{Component, Path, PathBuf},
    process::Stdio,
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};

pub const SKIP_DIRS: [&str; 4] = [".git", "node_modules", "target", ".DS_Store"];
const MAX_OUT: usize = 20_000;

fn def(name: &str, desc: &str, props: Value, required: &[&str]) -> Value {
    json!({
        "type": "function",
        "function": {
            "name": name,
            "description": desc,
            "parameters": { "type": "object", "properties": props, "required": required }
        }
    })
}

pub fn definitions() -> Value {
    json!([
        def("read_file", "Read a text file from the workspace.",
            json!({ "path": { "type": "string", "description": "Path relative to the workspace" } }), &["path"]),
        def("list_dir", "List files and folders in a directory. Use \".\" for the workspace root.",
            json!({ "path": { "type": "string" } }), &["path"]),
        def("write_file", "Create or overwrite a file with the given content.",
            json!({ "path": { "type": "string" }, "content": { "type": "string" } }), &["path", "content"]),
        def("edit_file", "Replace one exact occurrence of old_string with new_string in a file. old_string must match exactly and be unique.",
            json!({ "path": { "type": "string" }, "old_string": { "type": "string" }, "new_string": { "type": "string" } }),
            &["path", "old_string", "new_string"]),
        def("bash", "Run a shell command in the workspace and return its output (sh on Linux, cmd on Windows). 120 second limit.",
            json!({ "command": { "type": "string" } }), &["command"]),
    ])
}

pub fn needs_approval(name: &str) -> bool {
    matches!(name, "write_file" | "edit_file" | "bash")
}

/// Resolve a path inside the workspace; refuses anything that escapes it.
pub fn resolve(workspace: &Path, p: &str) -> Result<PathBuf, String> {
    let p = if p.is_empty() { "." } else { p };
    let joined = if Path::new(p).is_absolute() { PathBuf::from(p) } else { workspace.join(p) };
    let mut out = PathBuf::new();
    for c in joined.components() {
        match c {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    if out.starts_with(workspace) {
        Ok(out)
    } else {
        Err(format!("Path is outside the workspace: {p}"))
    }
}

fn truncate(s: String, max: usize) -> String {
    if s.chars().count() <= max {
        return s;
    }
    let cut: String = s.chars().take(max).collect();
    format!("{cut}\n... [truncated]")
}

fn arg<'a>(args: &'a Value, key: &str) -> Result<&'a str, String> {
    args[key].as_str().ok_or_else(|| format!("Missing argument: {key}"))
}

pub async fn execute(workspace: &Path, name: &str, args: &Value, cancel: &AtomicBool) -> (bool, String) {
    let r = match name {
        "read_file" => read_file(workspace, args),
        "list_dir" => list_dir(workspace, args),
        "write_file" => write_file(workspace, args),
        "edit_file" => edit_file(workspace, args),
        "bash" => bash(workspace, args, cancel).await,
        other => Err(format!("Unknown tool: {other}")),
    };
    match r {
        Ok(s) => (true, s),
        Err(e) => (false, e),
    }
}

fn read_file(ws: &Path, a: &Value) -> Result<String, String> {
    let p = resolve(ws, arg(a, "path")?)?;
    let s = std::fs::read_to_string(&p).map_err(|e| format!("{}: {e}", p.display()))?;
    Ok(truncate(s, 50_000))
}

fn list_dir(ws: &Path, a: &Value) -> Result<String, String> {
    let p = resolve(ws, arg(a, "path")?)?;
    let mut names: Vec<String> = std::fs::read_dir(&p)
        .map_err(|e| format!("{}: {e}", p.display()))?
        .filter_map(|e| e.ok())
        .filter(|e| !SKIP_DIRS.contains(&e.file_name().to_string_lossy().as_ref()))
        .map(|e| {
            let n = e.file_name().to_string_lossy().to_string();
            if e.path().is_dir() { format!("{n}/") } else { n }
        })
        .collect();
    names.sort();
    Ok(names.join("\n"))
}

fn write_file(ws: &Path, a: &Value) -> Result<String, String> {
    let p = resolve(ws, arg(a, "path")?)?;
    let content = arg(a, "content")?;
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&p, content).map_err(|e| format!("{}: {e}", p.display()))?;
    Ok(format!("Wrote {} bytes to {}", content.len(), arg(a, "path")?))
}

fn edit_file(ws: &Path, a: &Value) -> Result<String, String> {
    let p = resolve(ws, arg(a, "path")?)?;
    let old = arg(a, "old_string")?;
    let new = arg(a, "new_string")?;
    if old.is_empty() {
        return Err("old_string must not be empty".into());
    }
    let s = std::fs::read_to_string(&p).map_err(|e| format!("{}: {e}", p.display()))?;
    match s.matches(old).count() {
        0 => Err("old_string was not found in the file".into()),
        1 => {
            std::fs::write(&p, s.replacen(old, new, 1)).map_err(|e| e.to_string())?;
            Ok("Edit applied".into())
        }
        n => Err(format!("old_string matches {n} places; add more surrounding context to make it unique")),
    }
}

async fn bash(ws: &Path, a: &Value, cancel: &AtomicBool) -> Result<String, String> {
    let command = arg(a, "command")?;
    #[cfg(windows)]
    let mut cmd = {
        let mut c = tokio::process::Command::new("cmd");
        c.arg("/C").arg(command);
        c.creation_flags(0x0800_0000); // no console window
        c
    };
    #[cfg(not(windows))]
    let mut cmd = {
        let mut c = tokio::process::Command::new("sh");
        c.arg("-c").arg(command);
        c
    };
    cmd.current_dir(ws)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let child = cmd.spawn().map_err(|e| e.to_string())?;
    let fut = child.wait_with_output();
    tokio::pin!(fut);
    let started = Instant::now();

    let out = loop {
        tokio::select! {
            r = &mut fut => break r.map_err(|e| e.to_string())?,
            _ = tokio::time::sleep(Duration::from_millis(200)) => {
                if cancel.load(Ordering::SeqCst) { return Err("Cancelled by user".into()); }
                if started.elapsed() > Duration::from_secs(120) { return Err("Timed out after 120 seconds".into()); }
            }
        }
    };

    let text = format!(
        "exit code: {}\n{}{}",
        out.status.code().map(|c| c.to_string()).unwrap_or_else(|| "signal".into()),
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    Ok(truncate(text, MAX_OUT))
}
