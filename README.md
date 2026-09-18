# Star CLI

[![CI](https://github.com/cryer/star-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/cryer/star-cli/actions/workflows/ci.yml)

An AI agent command-line interface written in TypeScript — multi-model LLM access, streaming terminal UI, tool calling, permission control, and session persistence.

Features: streaming REPL with slash commands · OpenAI / Anthropic / OpenAI-compatible providers · built-in fs / bash / web tools with a permission gate · `@file` mentions · conversation compaction (`/compact`) · session persistence and resume (`/resume`, `star -r`) · file-write snapshots with `/undo` · persistent permission allow-rules · TODO task tracking · Markdown session export (`/export`).

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
permissionMode = "ask"   # auto | ask | readonly
contextMaxTokens = 100000
contextCompaction = "summary"   # summary | truncate — how over-budget history is compacted

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
star -m gpt                   pick a model
star --permission-mode auto   auto | ask | readonly
star -r <sessionId>           resume a previous session
```

## Slash commands (REPL)

| Command | Description |
|---|---|
| `/help` | list commands |
| `/model [name]` | list / switch models |
| `/resume [id]` | list / resume sessions |
| `/todo` | show TODO list |
| `/cost` | show API token usage for this session |
| `/config` | show resolved config |
| `/compact` | compact conversation history to free up context |
| `/export [path]` | export the current session to a Markdown file |
| `/undo` | revert the last file write/edit made by a tool |
| `/clear` | clear the screen |
| `/exit` | quit |
| `/q` | quit (alias of `/exit`) |

Keys: `ESC` / `Ctrl+C` interrupts the current stream; on a permission prompt: `y` allow, `n` deny, `a` always allow — the generated allow-rule (e.g. `bash(npm test)`) is saved to `permissions.allow` in the config file and survives restarts. Input editing: arrow keys move the cursor, `Ctrl+A`/`Ctrl+E` jump to start/end, `Ctrl+U`/`Ctrl+K` delete before/after the cursor, `Ctrl+W` deletes the previous word, up/down recall history.

## @file mentions

Prefix a path with `@` in any prompt to attach its content (REPL and print mode alike):

```
star -p "summarize @README.md and @src/main.tsx"
```

Missing, binary, oversized (>100KB), or sensitive files (`.env`, private keys) are skipped with a note. The chat history keeps your original `@path` text, so resumed sessions don't carry the injected bulk.

## Built-in tools

`read_file`, `write_file`, `edit_file`, `glob`, `grep`, `bash`, `web_fetch`, `web_search` (DuckDuckGo, no API key needed), `todo_read`, `todo_write` — each declares a permission level (`read` / `write` / `exec`) enforced by the permission gate. Hard safety rules (dangerous shell commands, paths outside the working directory, secret files like `.env` / private keys) are denied in every mode and cannot be overridden by allow-rules.

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
