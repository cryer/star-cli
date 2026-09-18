# Star CLI

An AI agent command-line interface written in TypeScript — multi-model LLM access, streaming terminal UI, tool calling, permission control, and session persistence.

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
node dist/main.js          # interactive REPL
node dist/main.js -p "hi"  # non-interactive print mode
```

## Configuration

Config file: `~/.star-cli/config.toml` (project-level override: `.star/config.toml` in cwd; CLI flags win over both).

```toml
defaultModel = "gpt"
permissionMode = "ask"   # auto | ask | readonly
contextMaxTokens = 100000
contextCompaction = "summary"   # summary | truncate — how over-budget history is compacted

[[providers]]
name = "openai"
protocol = "openai-compatible"
baseURL = "https://api.openai.com/v1"
apiKeyEnv = "OPENAI_API_KEY"

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
| `/config` | show resolved config |
| `/clear` | clear the screen |
| `/exit` | quit |

Keys: `ESC` / `Ctrl+C` interrupts the current stream; on a permission prompt: `y` allow, `n` deny, `a` always allow this tool for the session. Input editing: arrow keys move the cursor, `Ctrl+A`/`Ctrl+E` jump to start/end, `Ctrl+U`/`Ctrl+K` delete before/after the cursor, `Ctrl+W` deletes the previous word, up/down recall history.

## Built-in tools

`read_file`, `write_file`, `edit_file`, `glob`, `grep`, `bash`, `web_fetch`, `todo_read`, `todo_write` — each declares a permission level (`read` / `write` / `exec`) enforced by the permission gate. Hard safety rules (dangerous shell commands, paths outside the working directory, secret files like `.env` / private keys) are denied in every mode.

## Sessions

Sessions persist under `~/.star-cli/sessions/<id>/` (messages as JSONL + `meta.json`). List with `/resume`, resume with `/resume <id>` or `star -r <id>`.

## Development

```bash
pnpm build       # tsup bundle to dist/
pnpm test        # vitest
pnpm typecheck   # tsc --noEmit
pnpm lint        # biome
```

Architecture: `src/cli` (Ink UI), `src/agent` (main loop), `src/llm` (Vercel AI SDK provider layer), `src/tools`, `src/context` (token budget + compaction), `src/permissions`, `src/session`, `src/config`.
