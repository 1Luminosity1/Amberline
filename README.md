# Mistline

Fast, minimalist, agent-first desktop environment designed for coding, reasoning, and conversational AI.  
Built with **Tauri 2**, **Tokio async Rust**, and **Vanilla TypeScript** with an OpenCode pitch-black aesthetic.

---

## ✨ Features

- **Chats & Projects Dual Mode**:
  - **Chats Space**: Pure conversational AI assistant without file access — ideal for quick brainstorming, drafting, and questions.
  - **Projects Space**: Autonomous AI agent with workspace access — can read, create, edit files, and execute shell commands inside your project.
- **Smart Project Hub**:
  - 1-Click Quick Project initialization in `Documents/Mistline/Projects/Project-N`.
  - Open any existing repository or folder from local disk.
  - Recent projects launcher with quick click-to-open and removal.
  - Sidebar file explorer with switch, new project, and "Show in Explorer" actions.
- **Universal AI Providers & Model Picker**:
  - Official presets with **automatic Base URL filling**: Google Gemini, OpenRouter, DeepSeek, OpenAI, xAI (Grok), Groq, Mistral AI, Together AI, Perplexity, Cohere, and local runners (Ollama, LM Studio).
  - Live searchable model dropdown with instant keyword filtering.
  - Automatic `FREE` and `PRO` badges distinguishing free models from paid/pro tiers.
  - Real-time balance and key status verification (OpenRouter credits/free-tier, DeepSeek balance).
  - Debounced auto-fetch on typing or pasting API keys.
- **Reasoning & Collapsible Thinking Accordion**:
  - Native streaming parser for `<thought>...</thought>` and `<think>...</think>` tags (Gemma, DeepSeek-R1, Qwen, Gemini).
  - Real-time stopwatch accordion (`Thought for Xs`) that automatically folds thoughts away, keeping chat messages clean.
- **Rich Message Layout & Metrics**:
  - Markdown block parser (headers, bold, italic, quotes, lists, inline code).
  - IDE code blocks with syntax header and 1-click **Copy** button.
  - Message metadata footer: timestamp, generation duration, token count, speed (tokens/sec), and active model name.
- **Security & Privacy**:
  - Strict workspace sandbox boundaries — prevents path traversal outside the project directory.
  - API keys stored strictly on the local machine in plain config.
  - Optional tool call approval prompts.

---

## ⌨️ Shortcuts & Hotkeys

| Shortcut | Action |
| :--- | :--- |
| `Enter` | Send message |
| `Shift + Enter` | Insert new line |
| `Esc` | Stop agent / cancel generation |
| `Ctrl + T` (or `Cmd + T`) | Open new session |
| `F11` | Toggle borderless fullscreen |
| `@filename` | Reference a workspace file in agent prompt |

---

## 🛠️ Development & Requirements

### Prerequisites
- [Node.js](https://nodejs.org) (v20+ recommended)
- [Rust](https://rustup.rs) (stable)
- **Windows**: Microsoft Edge WebView2 (pre-installed in Windows 10/11) and MSVC C++ Build Tools
- **Linux**: `webkit2gtk-4.1`, `libgtk-3-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev`, `build-essential`, `libssl-dev`

### Running locally
```bash
# Clone the repository
git clone https://github.com/1Luminosity1/Mistline.git
cd Mistline

# Install frontend dependencies
npm install

# Run in development mode with hot reload
npm run tauri dev
```

### Production Build
```bash
npm run tauri build
```

---

## 📁 Architecture Overview

- `src-tauri/src/agent.rs`: Orchestration loop, context manager, system prompts, approvals, tool dispatch.
- `src-tauri/src/provider.rs`: Streaming HTTP/SSE client compatible with OpenAI and custom endpoints.
- `src-tauri/src/tools.rs`: Workspace tools (`read_file`, `list_dir`, `write_file`, `edit_file`, `bash`) with path boundary enforcement.
- `src-tauri/src/sessions.rs`: Session storage and lifecycle persistence (`app_data/sessions/*.json`).
- `src-tauri/src/stats.rs`: Token usage and metrics tracking.
- `src-tauri/src/lib.rs`: Tauri IPC commands and window event streaming.
- `src/main.ts`: High-performance Vanilla TypeScript UI (tabs, feed, searchable model dropdown, Project Hub, event stream listener).
- `src/style.css`: Pitch-black (`#000000`), zero-border-radius minimalist styling.

---

## 📄 License
MIT License
