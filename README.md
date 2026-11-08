# Amberline

Agent-first desktop environment in the spirit of OpenCode. Tauri 2, Rust core, plain TypeScript UI.

## Requirements
- Node.js 18+
- Rust (stable): https://rustup.rs
- Linux: `webkit2gtk-4.1`, `libgtk-3-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev`, `build-essential`, `curl`, `wget`, `file`, `libssl-dev`
- Windows: WebView2 (already in Windows 10/11) and the MSVC Build Tools

## First run
```
npm install
npx tauri icon src-tauri/icons/icon.png
npm run tauri dev
```
Then open Settings, paste your API key, press Test connection, pick a model, pick a project folder with the button in the top left, and ask for something.

## Release build
```
npm run tauri build
```

## Layout
- `src-tauri/src/agent.rs`: agent loop (model call, tools, approvals, summary)
- `src-tauri/src/provider.rs`: streaming OpenAI-compatible client
- `src-tauri/src/tools.rs`: read_file, list_dir, write_file, edit_file, bash
- `src/main.ts`: UI; the feed and the Activity panel are both built from the `agent-event` stream

## Keys
Enter sends, Shift+Enter new line, Esc stops the agent.

## GitHub
- `.github/workflows/ci.yml` checks the project on every push to `main` (Linux and Windows).
- `.github/workflows/release.yml` builds installers when a tag like `v0.1.0` is pushed and attaches them to a GitHub release.

```
git tag v0.1.0
git push origin v0.1.0
```

## Providers
Settings holds any number of provider profiles. Presets: DeepSeek, OpenAI, OpenRouter, Ollama, LM Studio, Custom (any OpenAI-compatible `/chat/completions` endpoint). "Test connection" asks the server for its model list. Optional prices per 1M tokens turn on cost estimates.

## Sessions
Tabs at the top, one per session. Each session has its own history and project folder and is saved to disk (app data folder, `sessions/`), so tabs survive restarts. Several sessions can run at the same time.
- `+` or Ctrl+T: new session in the current folder
- double-click a tab title: rename; `×` or middle click: delete (asks first)
- "open folder" (top left): opens a folder in a new session

## Statistics
- Activity panel (right, can be hidden): totals for the current session, a live timeline, and the full breakdown of the last run (time, tokens, cache hits, cost estimate, lines changed, tools, every model step).
- Settings > Statistics (or the Stats button): lifetime totals, by API key, by model, by day and by tool. Stored in `stats.json` in the app data folder.

## Settings
Settings is a window with sections (General, Providers, Statistics). A new section is one entry in the `panes` list in `src/main.ts`.
