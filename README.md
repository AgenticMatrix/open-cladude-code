# Coderix

<div align="center">

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue)](https://www.typescriptlang.org/)
[![中文](https://img.shields.io/badge/🌐-中文_README-ff69b4?style=flat-square)](README.zh-CN.md)

**A fully open-source (Apache 2.0) terminal AI programming assistant — the free alternative to Claude Code.**

</div>

<div align="center">
<img src="./assets/screen.gif" width="80%" alt="Coderix Demo" />
</div>

Coderix is a powerful AI coding agent that runs in your terminal or as a desktop app. It can read, write, edit files, execute shell commands, search code, and more — all through natural language conversation. Built with Ink/React for a beautiful TUI experience, plus an Electron desktop app (React DOM + Monaco + xterm) that shares the same core engine.

---

## Why Coderix?

| | Claude Code | Coderix |
|---|---|---|
| **License** | Proprietary | Apache 2.0 |
| **Source** | Closed | Fully open |
| **Provider** | Anthropic only | Anthropic / DeepSeek / OpenAI |
| **Pricing** | Per-token billing | Bring your own key |
| **Extensibility** | Limited | Full plugin architecture |

---

## Quick Start

### Prerequisites

- **Node.js >= 22**
- An API key from [DeepSeek](https://platform.deepseek.com), [Anthropic](https://console.anthropic.com), or [OpenAI](https://platform.openai.com)

### Install

```bash
git clone https://github.com/AgenticMatrix/coderix.git
cd coderix
./install.sh --local
```

### Development

Coderix ships two interfaces backed by the same core engine:

| Command | Interface |
|---|---|
| `npm run dev:cli` | **TUI** — the terminal interface (Ink/React) |
| `npm run dev:desk` | **Desktop** — the Electron app (React DOM) |

```bash
# TUI (terminal) version
npm run dev:cli

# Desktop (Electron) version
npm run dev:desk

# Desktop (Electron) version — one-click launcher, auto-frees port 5173
./start_desk.sh
```

### Configure

```bash
# First-time setup wizard
coderix setup

# Or manually edit ~/.coderix/settings.json
```

### Start Coding

```bash
# Interactive session
coderix

# One-shot query
coderix --print "Explain the src/core/query-engine.ts file"

# Switch model
coderix --model
coderix -m "deepseek/deepseek-v4-pro"
```

---

## Features

- **Beautiful TUI** — Built with [Ink](https://github.com/vadimdemedes/ink) + React 19, full terminal rendering
- **Multi-Provider** — Anthropic (Claude), DeepSeek, OpenAI-compatible endpoints
- **15+ Tools** — read, write, edit, bash, grep, glob, web-fetch, web-search, task management, todo
- **Streaming Tool Queue** — Tools enqueue and execute as they are parsed from the LLM stream, with bounded concurrency (default 32)
- **Streaming** — Real-time text, thinking, and tool-use streaming via ContentBlock events
- **Agent Loop** — Autonomous multi-turn reasoning with tool call execution
- **Permission System** — plan / ask / auto modes with risk-level classification
- **Context Management** — Token budget tracking and automatic compaction
- **Hook System** — Extensible lifecycle hooks
- **Skills** — Pluggable skill modules
- **Session Management** — Checkpoint, resume, fork sessions
- **Model Picker** — Interactive terminal model selection (`coderix --model` / `coderix setup`)
- **Desktop App** — Electron desktop client with Monaco editor, xterm terminal, and source control

---

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Enter` | Send message |
| `Escape` | Clear input / close sub-agent view |
| `Ctrl+C` | Interrupt agent / kill sub-agents / clear input / double-press to exit |
| `Ctrl+B` | Move sub-agent to background (unblocks main agent, agent keeps running) |
| `Ctrl+T` | Toggle sub-agent transcript view |
| `Ctrl+P` | Toggle task & todo panels |
| `Ctrl+O` | Toggle expand/collapse all blocks |
| `Ctrl+K` | Toggle team picker |
| `Ctrl+Enter` | Insert newline |
| `↑ / ↓` | Navigate input history |
| `← / →` | Move cursor |
| `Tab` | Auto-complete slash command |
| `PageUp / PageDown` | Freeze / unfreeze display |

---

## Configuration

Edit `~/.coderix/settings.json`:

```json
{
  "model_list": [
    {
      "model": [
        {
          "name": "deepseek-v4-pro",
          "price": {
            "input": 3,
            "cache_read_input": 0.025,
            "output": 6,
            "currency": "CNY",
            "unit": 1000000,
            "concurrency": 500,
            "max_context": 1000000
          }
        },
        {
          "name": "deepseek-v4-flash",
          "price": {
            "input": 1,
            "cache_read_input": 0.02,
            "output": 2,
            "currency": "CNY",
            "unit": 1000000,
            "concurrency": 2500,
            "max_context": 1000000
          }
        }
      ],
      "provider": "deepseek",
      "base_url": "https://api.deepseek.com/anthropic",
      "auth_token_env": "YOUR_DEEPSEEK_API_KEY"
    },
    {
      "model": [
        "claude-sonnet-2025",
        "opus-4.8"
      ],
      "provider": "anthropic",
      "base_url": "https://api.deepseek.com/anthropic",
      "auth_token_env": "YOUR_ANTHROPIC_API_KEY",
      "price": {
        "input": 3,
        "output": 15,
        "currency": "USD",
        "unit": "1M tokens"
      }
    },
    {
      "model": [
        "gpt-5",
        "gpt-5-mini"
      ],
      "provider": "openai",
      "base_url": "https://api.openai.com/v1",
      "auth_token_env": "YOUR_OPENAI_API_KEY"
    }
  ],
  "default_model": "deepseek/deepseek-v4-pro",
  "max_tool_concurrency": 32,
  "theme": "dark"
}
```

---

## CLI Reference

| Command | Description |
|---|---|
| `coderix` | Start interactive session |
| `coderix "query"` | One-shot question |
| `coderix --help` | Show help |
| `coderix --version` | Print version |
| `coderix --model` | Interactive model picker |
| `coderix -m "provider/model"` | Set model directly |
| `coderix setup` | First-time setup wizard |

---

## License

Apache 2.0 — fully open source. Use it, modify it, ship it.
