# Cursor Custom Models

[中文仓库](https://github.com/zhouruichen2015-pixel/cursor-custom-models) | [英文仓库](https://github.com/zhouruichen2015-pixel/cursor-custom-models-en)

> Use **DeepSeek, GLM, Kimi, Qwen - or any OpenAI-compatible endpoint (including localhost vLLM / Ollama)** inside Cursor's native Chat, Cmd+K and Agent.
> Patched into the editor's own process - **no proxy server to keep running, no account juggling, one-click install & restore**.

![version](https://img.shields.io/badge/version-1.6.1-blue) ![tests](https://img.shields.io/badge/integration_tests-34%2F34-brightgreen) ![license](https://img.shields.io/badge/license-MIT-green) ![platform](https://img.shields.io/badge/platform-Windows-lightgrey) ![cursor](https://img.shields.io/badge/tested_on-Cursor%203.16.x-orange)

---

## Why this exists

Every existing approach to "free / custom models in Cursor" has a structural flaw:

| # | Pain point | Who suffers from it |
|---|------------|---------------------|
| 1 | **A server must keep running** (Node / Docker / ngrok tunnel / a browser tab with a userscript) | API-proxy projects (`cursor2api` family) |
| 2 | **Account bans & rate-limit whack-a-mole** (temp-mail bans, 403/429, Cloudflare, expiring tokens) | trial-reset & proxy projects |
| 3 | **Native Agent / Cmd+K stay locked** - Cursor officially blocks custom API keys from Agent ("Composer relies on custom models that cannot be billed to an API key") | the official "custom API key" feature |
| 4 | **No real tool-call loop** - external clients fake it; Cursor's own `read_file` / `grep_search` are never used | all proxy solutions |
| 5 | **Update breaks everything** - minified anchors change, `product.json` checksums reject patched files | every workbench patcher |

**This project solves all five at once** by intercepting AI requests *inside Cursor's renderer process* - while every other RPC (64 methods: search, git, index, telemetry...) still flows through Cursor natively.

## What you get

- **Native UI, 100% preserved** - Chat, Cmd+K inline edit and the full Agent panel keep working exactly as before; only the 5 AI-inference streams are re-routed to your model.
- **Real tool calls on every channel (v1.6.0)** - the Agent panel gets 8 built-in tools (`read_file` / `grep_search` / `list_dir` / `write_file` / `run_terminal_cmd` / `web_fetch` / `delete_file` / `read_lints`); the classic Chat panel drives Cursor's own native UI tool loop (`clientSideToolV2Call`: read/grep/glob/list/delete/terminal/web-fetch); and any MCP tools configured in Cursor are injected dynamically on both channels (cap 40). Everything is executed **locally for real** by Cursor's client and fed back, multi-round (up to 8 rounds).
- **Full context injection, pure passthrough (v1.6.1)** - the system message is built *only* from data Cursor's client itself collects (OS/shell/timezone, `.cursor` rules, repo info, project layout, MCP instructions) plus the request's own `customSystemPrompt`, verbatim - **zero locally authored prompt text**. If there is no context at all, no system message is sent. `agentSystemPrompt` (default empty) is the single optional customization entry.
- **Any OpenAI-compatible backend** - DeepSeek, GLM, Kimi, Qwen, or `http://localhost:11434/v1` (localhost is *not* blocked here, because requests originate inside the process, not through Cursor's validation layer).
- **Reasoning models supported** - DeepSeek-style `reasoning_content` streams render natively; a `thinking` fallback handles non-standard providers.
- **Safety engineering** - automatic backup before patching, `node --check` validation with automatic rollback, `product.json` SHA-256 checksums recomputed, fully idempotent install, one-click verified restore.

## How it works

```
Cursor renderer process
└── workbench.desktop.main.js
    └── connect transport (patched by install.bat)
        ├── 5 AI streams (Chat / ChatWithTools / CmdK / Agent) ──► YOUR OpenAI-compatible API
        │      • request: protobuf → OpenAI chat completion
        │      • tools:   OpenAI function calling → Agent three-phase protocol
        │      • response: SSE → ConnectRPC frames (text + reasoning + tool calls)
        └── 64 other RPCs ────────────────────────────────────► Cursor servers (untouched)
```

One file (`cm-runtime.js`, ~1,700 lines, zero dependencies) is appended to the workbench and wraps Cursor's Connect transport provider. Everything else in the editor is untouched.

## Quick Start (Windows)

**Step 1 - Get the files**

```bash
git clone https://github.com/zhouruichen2015-pixel/cursor-custom-models-en.git
cd cursor-custom-models-en
```

*(or download the ZIP via the green "Code" button - no build step needed)*

**Step 2 - Put in your API key**

Copy `config.example.json` to `config.json`, then edit one line:

```json
"apiKey": "sk-your-real-key-here"
```

Defaults are pre-set for DeepSeek (`deepseek-v4-flash`). Switching to GLM/Kimi/Qwen/Ollama means changing `baseUrl` + `defaultModel` - see [Configuration](#configuration).

**Step 3 - Install**

Close Cursor, then double-click **`install.bat`**.

It finds your Cursor installation automatically, patches the workbench, validates the result with `node --check`, fixes `product.json` checksums, and restores everything if anything fails.

**Step 4 - Restart Cursor and chat**

Open Chat (Ctrl+L) or Agent, send a message - replies now come from your model.

### Verify it worked

```bash
status.bat   # shows patch + config status
test.bat     # 34 integration tests, no real key needed
```

### A real Agent session looks like this

> **You:** find where database connections are opened in this project
> **Model:** *calls `grep_search`* → Cursor executes it on your files → *calls `read_file`* → **"Connections are opened in `src/db/pool.ts:42` via `createPool()`. The pool size is hardcoded..."**

The searches and file reads happen locally through Cursor's own client - not emulated.

## How it compares

| | **This project** | trial-reset tools<br>(e.g. cursor-free-vip) | API proxies<br>(cursor2api family) | official custom<br>API key |
|---|---|---|---|---|
| Nothing to keep running | ✅ | ✅ (scripts) | ❌ Node/Docker/tunnel | ✅ |
| Uses **your own** model & key | ✅ any OpenAI-compat | ❌ Cursor's models | ❌ resells Cursor's | ⚠️ chat only |
| Native Agent + Cmd+K work | ✅ | trial only | ❌ serves external apps | ❌ Agent locked |
| Real in-IDE tool calls | ✅ 8 built-in + MCP, Chat & Agent | ❌ | ❌ | ❌ |
| `localhost` endpoints | ✅ | n/a | n/a | ❌ blocked |
| No account / fingerprint tricks | ✅ | ❌ machine-id, temp-mail | ❌ shared cookies | ✅ |
| Behavior locked by tests | ✅ 36 tests | ❌ | partial | n/a |

## Configuration (`config.json`)

| Key | Default | Meaning |
|-----|---------|---------|
| `baseUrl` | `https://api.deepseek.com/v1` | Any OpenAI-compatible base URL (localhost OK) |
| `apiKey` | - | Your key. **Never committed** - only `config.example.json` ships in the repo |
| `defaultModel` | `deepseek-v4-flash` | Model sent when no mapping matches |
| `modelMapping` | `"*": "deepseek-v4-flash"` | Cursor model name → your model name |
| `interceptMethods` | 5 streams | Which RPCs to re-route |
| `blockUsageGate` | `true` | Silence the client-side "usage paused" banner |
| `agentTools` | `true` | Enable the tool loops (8 built-in tools on Agent, 7 native UI tools on Chat, plus dynamic MCP tools) |
| `agentSystemPrompt` | `""` | Optional base system prompt. By default the system prompt is a pure passthrough of Cursor-collected data with no authored text; set this only if you want a role preset |
| `agentMaxToolRounds` | `8` | Max tool-call rounds per request |
| `agentContext` | all `true` | Which context blocks go into the system prompt |
| `debugDump` | `false` | Dump raw requests to `cm-dump.jsonl` for debugging |

Full field reference: [中文主仓库 README §4](https://github.com/zhouruichen2015-pixel/cursor-custom-models#四配置说明configjson) (Chinese, more detailed).

## FAQ

**Which Cursor versions are supported?**
Tested on Cursor 3.16.x. The patcher uses a tolerant regex anchor plus version-specific fallbacks, and validates the result with `node --check` before touching your installation. After a Cursor update, just run `install.bat` again (fully idempotent).

**Is my API key safe?**
`config.json` is git-ignored; the repo ships only a placeholder example. Your key is injected into a file on your own disk and sent only to the `baseUrl` you configure.

**How do I uninstall?**
Double-click `restore.bat`. It restores the original workbench from backup (integrity-checked) and repairs `product.json` checksums.

**macOS / Linux?**
The runtime JS is platform-independent, but the installer is PowerShell + `.bat` (Windows-first). The `.ps1` scripts run under `pwsh` on macOS/Linux with path adjustments - untested, PRs welcome.

**Could Cursor block this?**
Any client-side patch can theoretically be broken by an update; that's why install is idempotent, backups are verified, and 36 tests pin the protocol behavior (v1.6.2 added regression coverage for Cursor 3.16's terminal-tool `parsingResult` requirement). Use responsibly and respect Cursor's terms - this project is for personal, educational use with **your own** API subscription.

## File map

| File | Purpose |
|------|---------|
| `cm-runtime.js` | The runtime (single file, ~1,700 lines, 0 dependencies) injected into Cursor |
| `patch.ps1` / `install.bat` | Idempotent patcher with validation + rollback + checksum repair |
| `restore.ps1` / `restore.bat` | One-click verified uninstall |
| `status.bat` | Patch & config status |
| `test-integration.js` / `test.bat` | 36 integration tests (mock SSE + protobuf-es v2 type mocks, dual-channel tool loops, shell parsingResult injection + pure-passthrough assertions) |
| `cdp-e2e.js` | End-to-end test driving the real Cursor UI via Chrome DevTools Protocol |
| `cors-proxy.js` / `glm-proxy.js` | Optional helpers for CORS-restricted providers (e.g. GLM) |
| `stats.js` | Optional live stats viewer (needs `npm i ws`) |

## Disclaimer

This project is not affiliated with Cursor (Anysphere). It patches the editor on your own machine to use **your own paid API subscription**. Respect the terms of service of Cursor and your model provider. Provided as-is under the MIT license.

## License

[MIT](LICENSE) © 2026
