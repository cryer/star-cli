# Star CLI

[![CI](https://github.com/cryer/star-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/cryer/star-cli/actions/workflows/ci.yml)

An AI agent command-line interface written in TypeScript — multi-model LLM access, streaming terminal UI, tool calling, permission control, and session persistence.

Features: streaming REPL with slash commands (+ autocomplete) · OpenAI / Anthropic / OpenAI-compatible providers · built-in fs / bash / web tools with a permission gate · thinking spinner with dim reasoning preview · diff preview on write/edit approval · `@file` mentions · `!cmd` shell passthrough · custom slash commands from Markdown files · conversation compaction (`/compact`) · session persistence and resume (`/resume`, `star -r`) · file-write snapshots with `/undo` · persistent permission allow-rules · TODO task tracking · background shell tasks with status-bar visibility (`/tasks`) · Markdown session export (`/export`) · `/init` + `/doctor` project scaffolding and environment checks · cost estimation · update notifier · `--json` NDJSON output for scripting.

## Requirements

- Node.js >= 20
- pnpm

## Install

```bash
npm install -g @cryer/star-cli
star                  # interactive REPL
star -p "hi"          # non-interactive print mode
```

## Quick start (from source)

```bash
pnpm install
pnpm build
npm link                 # one-time: registers the `star` command globally
star                     # interactive REPL
star -p "hi"             # non-interactive print mode
```

Without `npm link` you can run the bundle directly: `node dist/main.js` (re-run `pnpm build` after code changes; the linked `star` always points at `dist/`).

## Configuration

Config file: `~/.star-cli/config.toml` (project-level override: `.star/config.toml` in cwd; CLI flags win over both).

```toml
defaultModel = "gpt"
permissionMode = "ask"   # ask | auto | readonly | yolo
contextMaxTokens = 100000
contextCompaction = "summary"   # summary | truncate — how over-budget history is compacted
# Seconds with no stream output before a stalled response is ended gracefully
# (some relays never close the stream). The first token gets a fixed 120s allowance.
streamIdleTimeoutSec = 20

[permissions]
# persistent allow-rules, written automatically when you pick "a" (always) on a permission prompt
allow = ["bash(npm test)", "read_file"]   # <tool> or <tool(<pattern>)>, * is a glob wildcard

[[providers]]
name = "openai"
protocol = "openai-compatible"
baseURL = "https://api.openai.com/v1"
apiKeyEnv = "OPENAI_API_KEY"
# protocol = "openai-responses"  # for relays exposing only /v1/responses

[[models]]
name = "gpt"
provider = "openai"
model = "gpt-4o"
# optional per-model pricing (USD per 1M tokens) — enables the $ estimate in /cost
promptPrice = 2.5
completionPrice = 10

[[providers]]
name = "claude"
protocol = "anthropic"
baseURL = "https://api.anthropic.com"
apiKeyEnv = "ANTHROPIC_API_KEY"

[[models]]
name = "sonnet"
provider = "claude"
model = "claude-sonnet-4-20250514"
```

API keys resolve from the environment variable first (`apiKeyEnv`), then the `apiKey` field in the config file.

## CLI flags

```
star                          start the interactive REPL
star -p "prompt"              non-interactive print mode (pipe-friendly)
star -p "prompt" --json       NDJSON event stream on stdout (text/tool/usage/error lines)
star -m gpt                   pick a model
star --permission-mode auto   ask | auto | readonly | yolo
star -r <sessionId>           resume a previous session
```

## Slash commands (REPL)

| Command | Description |
|---|---|
| `/help` | list commands |
| `/model [name]` | list / switch models |
| `/resume [id]` | list / resume sessions |
| `/todo` | show TODO list |
| `/tasks` | list background tasks (id, status, runtime, exit code) |
| `/cost` | show API token usage and estimated $ cost (needs per-model pricing in config) |
| `/config` | show resolved config |
| `/permission [mode]` | show / set the global permission mode (`ask`, `auto`, `readonly`, `yolo`) — saved to config |
| `/compact` | compact conversation history to free up context |
| `/export [path]` | export the current session to a Markdown file |
| `/undo` | undo the last conversation turn: revert its file changes (write_file/edit_file) and retract its messages — earlier turns are never touched |
| `/init [force]` | scan the project and generate an AGENTS.md (LLM-polished when a model is available) |
| `/doctor` | environment self-check (Node, shell, config, API key status, sessions dir writability) |
| `/clear` | clear the screen |
| `/exit` | quit |
| `/q` | quit (alias of `/exit`) |

Keys: `ESC` / `Ctrl+C` interrupts the current stream; on a permission prompt: `y` allow, `n` deny, `a` always allow — the generated allow-rule (e.g. `bash(npm test)`) is saved to `permissions.allow` in the config file and survives restarts. Write/edit prompts include a colored diff preview of the pending change. Input editing: arrow keys move the cursor, `Ctrl+A`/`Ctrl+E` jump to start/end, `Ctrl+U`/`Ctrl+K` delete before/after the cursor, `Ctrl+W` deletes the previous word, up/down recall history. Typing `/` shows slash-command suggestions — `↑`/`↓` to highlight, `Tab` (or `→` at end of input) to complete, `ESC` to dismiss.

While the model is working, a spinner (`- \ | /`) shows `star is thinking…`; reasoning models also stream a dimmed tail of their thinking (last ~200 chars), which collapses to a one-line summary once the answer starts.

## !shell passthrough

Prefix input with `!` to run a command locally without involving the model:

```
!git status
```

Output renders as a tool card and is injected into the conversation so the model can see it afterwards. Dangerous commands are still blocked, and `ESC` / `Ctrl+C` aborts execution.

## Background tasks

The model can run long shell commands in the background via `bash` with `run_in_background: true` (same permission gate as foreground commands). While anything runs in the background, the status bar shows `bg: N`; when a task finishes, fails, times out, or is stopped, a system message reports the outcome. `/tasks` lists every task with status, runtime, and exit code, and the model can inspect or stop tasks with the `task_list` / `task_output` / `task_kill` tools. Remaining tasks are killed when the REPL exits.

## Custom slash commands

Drop Markdown files into `.star/commands/<name>.md` (project) or `~/.star-cli/commands/<name>.md` (global) to define your own commands — `/review src/` then sends the file's contents (with `$ARGUMENTS` replaced by your arguments) to the model as a prompt. An optional first line `<!-- description: does a thing -->` sets the description shown in `/help` and autocomplete. Names must match `[a-z0-9-]+`; built-in commands win on conflicts.

```markdown
<!-- description: review code for issues -->
Review the following code and list concrete issues: $ARGUMENTS
```

The REPL also checks npm for a newer release on startup (async, non-blocking; disable with `STAR_NO_UPDATE_CHECK=1`).

## @file mentions

Prefix a path with `@` in any prompt to attach its content (REPL and print mode alike):

```
star -p "summarize @README.md and @src/main.tsx"
```

Missing, binary, oversized (>100KB), or sensitive files (`.env`, private keys) are skipped with a note. The chat history keeps your original `@path` text, so resumed sessions don't carry the injected bulk.

## Built-in tools

`read_file`, `write_file`, `edit_file`, `glob`, `grep`, `bash`, `web_fetch`, `web_search` (DuckDuckGo, no API key needed), `todo_read`, `todo_write`, `task_list`, `task_output`, `task_kill` — each declares a permission level (`read` / `write` / `exec`) enforced by the permission gate. Hard safety rules (dangerous shell commands, paths outside the working directory, secret files like `.env` / private keys) are denied in `ask` / `auto` / `readonly` and cannot be overridden by allow-rules.

Permission modes: `ask` (reads allowed, writes/exec ask) · `auto` (everything allowed except the hard-denied rules above) · `readonly` (read-only) · `yolo` (allow everything, never ask — **all safety checks disabled**, use at your own risk). Switch at runtime with `/permission` (persisted to the config file) or at startup with `--permission-mode`.

Every successful `write_file` / `edit_file` first snapshots the file's previous content (in-memory, last 50 writes per session); `/undo` restores the most recent snapshot, deleting the file if it didn't exist before.

## Sessions

Sessions persist under `~/.star-cli/sessions/<id>/` (messages as JSONL + `meta.json`). List with `/resume` (only sessions started in the current directory are listed), resume with `/resume <id>` or `star -r <id>`. Sessions are created lazily — opening the REPL and exiting without chatting leaves nothing on disk, and print mode (`-p`) doesn't create a session unless resuming with `-r`. Token usage is accumulated in `meta.json`, so `/cost` reflects resumed history too.

## Development

```bash
pnpm build           # tsup bundle to dist/
pnpm test            # vitest unit tests (no network)
pnpm typecheck       # tsc --noEmit
pnpm lint            # biome
pnpm test:pipeline   # layered pipeline incl. optional live LLM smoke (needs an API key)
```

CI runs lint, typecheck, tests, and build on Ubuntu + Windows against Node 20/22 (`.github/workflows/ci.yml`).

Architecture: `src/cli` (Ink UI), `src/agent` (main loop), `src/llm` (Vercel AI SDK provider layer), `src/tools`, `src/context` (token budget + compaction), `src/permissions`, `src/session`, `src/config`.
