<div align="center">

<img src="assets/icon.png" alt="Star CLI" width="320" />

**An AI agent command-line interface written in TypeScript**

Multi-model LLM access · streaming terminal UI · tool calling · permission control · session persistence

[![CI](https://github.com/cryer/star-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/cryer/star-cli/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@cryer/star-cli?color=crimson&logo=npm)](https://www.npmjs.com/package/@cryer/star-cli)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D20-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict%20ESM-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)](#requirements)

</div>

Features: streaming REPL with slash commands (+ autocomplete) · OpenAI / Anthropic / OpenAI-compatible providers · built-in fs / bash / web tools with a permission gate · git integration (`/commit` drafts Conventional Commits messages, `/diff` shows a colored working-tree diff, repo status injected into the system prompt) · plan mode with read-only research and plan approval · thinking spinner with dim reasoning preview · diff preview on write/edit approval · `@file` mentions · `!cmd` shell passthrough · custom slash commands from Markdown files · conversation compaction (`/compact`) · session persistence and resume with auto-generated titles (`/resume`, `star -r`) · subagent delegation for focused subtasks · lifecycle hooks (`PreToolUse`/`PostToolUse`/`Stop` shell commands from config) · file-write snapshots with `/undo` and checkpoint rollback with `/rewind` · persistent permission allow-rules · TODO task tracking · background shell tasks with status-bar visibility (`/tasks`) · terminal bell on long turns and background-task completion · Markdown session export (`/export`) · `/init` + `/doctor` project scaffolding and environment checks · cost estimation · update notifier · `--json` NDJSON output for scripting.

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
permissionMode = "ask"   # ask | auto | readonly | yolo | plan
contextMaxTokens = 100000
contextCompaction = "summary"   # summary | truncate — how over-budget history is compacted
# Seconds with no stream output before a stalled response is ended gracefully
# (some relays never close the stream). The first token gets a fixed 120s allowance.
streamIdleTimeoutSec = 20
# sessionBudgetUsd = 5          # optional per-session cost cap in USD; unset = no cap
notifyBell = true              # ring the terminal bell when a long turn finishes (REPL only)
notifyBellThresholdSec = 10    # turns shorter than this stay silent

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
# optional per-model context window — overrides the top-level contextMaxTokens
# for compaction and the ctx % in the status bar
# contextMaxTokens = 272000
# optional per-model pricing in USD per 1M tokens — enables the $ estimate in
# /cost and /usage. promptPrice prices input tokens (system prompt, history,
# @file contents, tool results — resent every turn, so the bulk of usage);
# completionPrice prices output tokens (the model's replies and tool calls —
# less volume, usually the pricier rate). BOTH fields are required together.
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

[[hooks]]
event = "PostToolUse"                  # PreToolUse | PostToolUse | Stop
matcher = "edit_file|write_file"       # optional regex on the tool name; matches all tools when omitted
command = "biome check --write ."
# timeoutSec = 30                      # optional per-hook timeout
```

API keys resolve from the environment variable first (`apiKeyEnv`), then the `apiKey` field in the config file.

## CLI flags

```
star                          start the interactive REPL
star -p "prompt"              non-interactive print mode (pipe-friendly)
star -p "prompt" --image x.png  attach an image (png/jpg/jpeg/gif/webp, max 5MB; repeatable)
star -p "prompt" --json       NDJSON event stream on stdout (text/tool/usage/error lines)
star -m gpt                   pick a model
star --permission-mode auto   ask | auto | readonly | yolo | plan
star -r <sessionId>           resume a previous session (full or short id)
star -r                       list sessions for the current directory
star -c                       continue the most recent session for the current directory
star --clear-sessions         delete stored sessions for the current directory
star --clear-sessions all     delete every stored session
```

## Slash commands (REPL)

| Command | Description |
|---|---|
| `/help` | list commands |
| `/model [name]` | list / switch models |
| `/resume [id\|--all]` | list sessions for this directory (`--all`: every directory, with cwd shown) or resume a session by id |
| `/new` | start a new session with a clean context (the old session stays on disk) |
| `/clear-sessions [--all]` | delete stored sessions: this directory by default, every session with `--all` (the current session is kept) |
| `/todo` | show TODO list |
| `/tasks` | list background tasks (id, status, runtime, exit code) |
| `/cost` | show API token usage and estimated $ cost (needs per-model pricing in config) |
| `/usage` | token usage dashboard across all sessions: totals, per-day bar chart, per-model breakdown with $ estimate |
| `/config` | show resolved config |
| `/permission [mode]` | show / set the global permission mode (`ask`, `auto`, `readonly`, `yolo`) — saved to config |
| `/plan` | toggle plan mode: read-only research, then approve the generated plan before it executes (session-only) |
| `/compact` | compact conversation history to free up context |
| `/export [path]` | export the current session to a Markdown file |
| `/undo` | undo the last conversation turn: revert its file changes (write_file/edit_file) and retract its messages — earlier turns are never touched |
| `/rewind [n]` | list file-change checkpoints, or rewind to just before checkpoint `n`: restore every file changed since then and retract the matching conversation messages (asks for confirmation first) |
| `/init [force]` | scan the project and generate an AGENTS.md (LLM-polished when a model is available) |
| `/doctor` | environment self-check (Node, shell, config, API key status, sessions dir writability) |
| `/skills` | list available skills (project scope overrides user scope) |
| `/commit [instructions]` | analyze uncommitted changes and let the agent stage + commit them with a Conventional Commits message (git add/commit runs through the normal permission gate) |
| `/diff` | show uncommitted changes client-side: `git status --short` plus a colored staged/unstaged diff (no model call; huge diffs are truncated at 2000 lines) |
| `/copy [all]` | copy the last assistant reply to the clipboard (`all`: the whole conversation as plain text) |
| `/clear` | clear the screen |
| `/exit` | quit |
| `/q` | quit (alias of `/exit`) |

Keys: `ESC` / `Ctrl+C` interrupts the current stream; on a permission prompt: `y` allow, `n` deny, `a` always allow — the generated allow-rule (e.g. `bash(npm test)`) is saved to `permissions.allow` in the config file and survives restarts. Write/edit prompts include a colored diff preview of the pending change. `Shift+Tab` cycles the permission mode for the session (`ask` → `auto` → `readonly` → `plan`; not saved to config). Input editing: arrow keys move the cursor, `Ctrl+A`/`Ctrl+E` jump to start/end, `Ctrl+U`/`Ctrl+K` delete before/after the cursor, `Ctrl+W` deletes the previous word, up/down recall history. Typing `/` shows slash-command suggestions — `↑`/`↓` to highlight, `Tab` (or `→` at end of input) to complete, `ESC` to dismiss. Typing `@` completes file paths relative to the working directory with the same keys; directories end in `/` so `Tab` descends, and `node_modules`, `.git` and `dist` are skipped. `Alt+V` pastes an image from the clipboard as an attachment (each one shows as `[image attached: clipboard.png]` above the input; uses PowerShell on Windows, pngpaste/osascript on macOS, xclip on Linux). `Ctrl+V` also works where the terminal passes it through — Windows Terminal binds Ctrl+V to its own paste, so use `Alt+V` there. While a turn is streaming you can keep typing: submitted prompts (and `!` bangs) queue up as dimmed entries and auto-send in order once the turn finishes; `ESC` during a turn aborts it and clears the queue. Pressing `ESC` twice within half a second while idle retracts your last prompt and restores its text into the input for editing.

While the model is working, a spinner (`- \ | /`) shows `star is thinking…`; reasoning models also stream a dimmed tail of their thinking (last ~200 chars), which collapses to a one-line summary once the answer starts.

The status bar shows the working directory (full path on wide terminals), the git branch, the model, the permission mode, context usage as a percentage of the model's context window (its own `contextMaxTokens` when set, else the top-level one), the session cost when the model has pricing configured, and total tokens.

## !shell passthrough

Prefix input with `!` to run a command locally without involving the model:

```
!git status
```

Output renders as a tool card and is injected into the conversation so the model can see it afterwards. Dangerous commands are still blocked, and `ESC` / `Ctrl+C` aborts execution.

## Background tasks

The model can run long shell commands in the background via `bash` with `run_in_background: true` (same permission gate as foreground commands). While anything runs in the background, the status bar shows `bg: N`; when a task finishes, fails, times out, or is stopped, a system message reports the outcome. `/tasks` lists every task with status, runtime, and exit code, and the model can inspect or stop tasks with the `task_list` / `task_output` / `task_kill` tools. Remaining tasks are killed when the REPL exits.

## Terminal bell

The REPL rings the terminal bell (BEL) so you can switch windows while the agent works: once when a turn finishes after taking longer than `notifyBellThresholdSec` (default 10s), and once whenever a background task completes — the moment you are least likely to be watching. It only rings on a TTY, never for interrupted (ESC / Ctrl+C) turns, and never in print mode (`-p`). Disable it with `notifyBell = false` in the config or `STAR_NO_NOTIFY=1` in the environment.

## Session budget

Setting `sessionBudgetUsd` in the config caps spend per REPL session (the active model needs `promptPrice`/`completionPrice` so the cost can be computed). When a finished turn pushes the session cost past 80% of the cap, a one-time warning appears; past 100%, further prompts are blocked with an error while slash commands keep working — raise the limit in the config or start fresh with `/new`.

## Plan mode

Plan mode (`/plan`, `Shift+Tab` cycling, or `--permission-mode plan`) makes the agent research read-only before touching anything: the model only sees read-level tools (`read_file` / `glob` / `grep` / `web_*` / `todo` …), write/exec tools are hidden entirely, and the system prompt instructs it to end with a concrete step-by-step plan. When the plan is ready, an approval prompt appears — `y` restores the previous permission mode and tells the agent to execute the plan, `n` / `ESC` stays in plan mode so you can keep refining. Plan mode is session-scoped and never written to the config file; `/plan` again toggles back.

## Hooks

`[[hooks]]` entries in the config run your own shell commands at agent lifecycle points (a simplified take on Claude Code hooks):

```toml
[[hooks]]
event = "PreToolUse"              # before a tool runs
matcher = "edit_file|write_file"  # optional regex on the tool name; omit to match every tool
command = "node scripts/check.js"

[[hooks]]
event = "Stop"                    # once per finished turn
command = "notify-send 'turn done'"
```

- **PreToolUse** runs before the tool executes. Exit code `0` lets it run; exit code `2` blocks it and the hook's stderr is returned to the model as the tool result; any other non-zero exit lets the tool run and shows stderr as a warning (a system message in the REPL, `[hook] …` on stderr in print mode).
- **PostToolUse** runs after a tool succeeds (never after an error result). A non-zero exit only produces a warning — nothing is blocked. Typical use: formatters and lint autofix (`biome check --write .`).
- **Stop** runs once when a turn finishes (after the final assistant reply). `matcher` is ignored here since there is no tool; failures only warn.

Hook processes run in the working directory with a timeout (30s default, `timeoutSec` per hook) and receive `STAR_HOOK_EVENT`, `STAR_CWD`, `STAR_SESSION_ID`, plus `STAR_TOOL_NAME` and `STAR_TOOL_INPUT` (JSON of the tool arguments) for tool events. A timed-out hook is treated as failed — for PreToolUse that means allow-with-warning, so a stuck hook can never lock the agent.

Security: hooks are commands **you** configured, so they run in every permission mode and do **not** go through the permission gate — treat the config file as trusted code. Hooks only fire for events that actually happen: in `readonly`/`plan` mode write/exec tools never run, so their PreToolUse/PostToolUse hooks never fire either. A failing hook can never crash the agent.

## Git integration

Inside a git repository, the agent's system prompt automatically carries a short git context block — current branch, number of uncommitted files, and the last 3 commits — refreshed at the start of every turn (REPL and print mode alike; any git failure is silently ignored).

Two slash commands build on top of it:

- `/commit [instructions]` collects `git status`, the staged + unstaged diff (truncated to 2000 lines), and the last 5 commits, then asks the agent to draft a Conventional Commits message matching the repo's history and run `git add` / `git commit` via the bash tool — so the usual permission prompt still applies. Outside a repo or with a clean tree it just says so without calling the model.
- `/diff` is purely client-side: it renders `git status --short` and the staged/unstaged diff with the same colors as the write/edit approval preview, truncated at 2000 lines when larger.

## Custom slash commands

Drop Markdown files into `.star/commands/<name>.md` (project) or `~/.star-cli/commands/<name>.md` (global) to define your own commands — `/review src/` then sends the file's contents (with `$ARGUMENTS` replaced by your arguments) to the model as a prompt. An optional first line `<!-- description: does a thing -->` sets the description shown in `/help` and autocomplete. Names must match `[a-z0-9-]+`; built-in commands win on conflicts.

```markdown
<!-- description: review code for issues -->
Review the following code and list concrete issues: $ARGUMENTS
```

The REPL also checks npm for a newer release on startup (async, non-blocking; disable with `STAR_NO_UPDATE_CHECK=1`).

## Skills

Skills are reusable instruction packs the agent loads on demand. Drop a `SKILL.md` into `.star/skills/<name>/` (project) or `~/.star-cli/skills/<name>/` (user); project skills override user skills of the same name. Each `SKILL.md` starts with frontmatter (`name` optional, defaults to the directory name; `description` required), followed by the instructions body:

```markdown
---
description: Review code for common issues
---
Check error handling, naming, and test coverage. Report concrete findings with file:line references.
```

Available skills are listed in the system prompt (name + description only, so they cost almost no tokens until used). When a request matches one, the agent calls the read-level `skill` tool to load the full body — supporting files next to the `SKILL.md` (scripts, templates, examples) are resolved relative to the skill's directory. Skills added mid-session are picked up on the next turn; `/skills` lists what's currently visible. Bodies are capped at 32KB.

## @file mentions

Prefix a path with `@` in any prompt to attach its content (REPL and print mode alike):

```
star -p "summarize @README.md and @src/main.tsx"
```

Image files (`@screenshot.png` — png, jpg, jpeg, gif, webp, up to 5MB) are sent to the model as image input instead of inlined text, in both the REPL and print mode. In print mode you can also attach images with the repeatable `--image <path>` flag:

```
star -p "what's wrong in this UI?" --image screenshot.png --image mockup.jpg
```

Invalid `--image` paths (unsupported type, missing, unreadable, or oversized) abort print mode with a non-zero exit.

Missing, binary, oversized (>100KB for text, >5MB for images), or sensitive files (`.env`, private keys) are skipped with a note. The chat history keeps your original `@path` text, so resumed sessions don't carry the injected bulk.

## Built-in tools

`read_file`, `write_file`, `edit_file`, `glob`, `grep`, `bash`, `web_fetch`, `web_search` (DuckDuckGo, no API key needed), `todo_read`, `todo_write`, `task_list`, `task_output`, `task_kill`, `subagent`, `skill` — each declares a permission level (`read` / `write` / `exec`) enforced by the permission gate. Hard safety rules (dangerous shell commands, paths outside the working directory, secret files like `.env` / private keys) are denied in `ask` / `auto` / `readonly` and cannot be overridden by allow-rules.

The `subagent` tool (`exec` level, so it is hidden in plan mode and denied in readonly) spawns a child agent loop with the same built-in tools to handle a focused, self-contained subtask — research, exploration, or an isolated change — and returns the child's final report as the tool result. Subagents run one level deep (a subagent cannot spawn further subagents), share the parent's permission mode and confirmation prompt, and their conversation is not persisted to the session.

Permission modes: `ask` (reads allowed, writes/exec ask) · `auto` (everything allowed except the hard-denied rules above) · `readonly` (read-only) · `yolo` (allow everything, never ask — **all safety checks disabled**, use at your own risk) · `plan` (read-only research with a plan-approval flow, see above — session-only). Switch at runtime with `/permission` (persisted to the config file), per session with `/plan` or `Shift+Tab`, or at startup with `--permission-mode`.

Every successful `write_file` / `edit_file` first snapshots the file's previous content (in-memory, last 50 writes per session); `/undo` restores the most recent snapshot, deleting the file if it didn't exist before.

## Checkpoints and /rewind

Each snapshot is also a numbered **checkpoint**: `/rewind` lists every file change of the session (id, time, tool, file), and `/rewind <n>` rolls the session back to just before checkpoint `n` — every file changed since then is restored in reverse order (files created in the meantime are deleted), the conversation is retracted to the turn that made the change, and the undo stack drops the rewound entries. Because this is destructive, the command first shows how many file changes and messages will be affected and asks for `y`/`n` confirmation.

Checkpoints are persisted under `~/.star-cli/sessions/<id>/checkpoints/` (an `index.json` plus one content file per checkpoint, created lazily on the first file write), so rewinding still works after resuming a session with `/resume` or `star -r`. `/undo` stays the fine-grained counterpart: it only ever touches the last turn.

## Sessions

Sessions persist under `~/.star-cli/sessions/<id>/` (messages as JSONL + `meta.json`). List with `/resume` (only sessions started in the current directory, most recently active first, with message counts and relative times) or `/resume --all` (every directory, with each session's cwd shown), resume with `/resume <id>` or `star -r <id>` — both accept the short id shown in the list. `star -c` (`--continue`) jumps straight back into the most recently active session for the current directory, in the REPL and in print mode alike; when the directory has no sessions it says so and starts a fresh one. `-r` and `-c` are mutually exclusive, and a bare `star -r` prints the session list instead of erroring. Sessions are created lazily — opening the REPL and exiting without chatting leaves nothing on disk, and print mode (`-p`) doesn't create a session unless resuming with `-r` or `-c`. Token usage is accumulated in `meta.json`, so `/cost` reflects resumed history too. `/usage` is the global counterpart of `/cost` (which stays session-scoped): it aggregates every session's `meta.json` across all directories into a dashboard — grand totals, a per-day bar chart of the last 14 days with usage, and a per-model breakdown with a $ estimate for models that have pricing configured (models without pricing are listed but excluded from the total). Per-day numbers come from a `usageByDay` bucket map recorded from now on; usage recorded before that field existed only has grand totals and shows up as a single "earlier usage" line. `/new` abandons the in-memory conversation and attaches a fresh lazy session store (the old session stays on disk); deletion is a separate explicit action — `/clear-sessions` removes the sessions recorded for the current directory, `/clear-sessions --all` wipes every session directory (including ones with an unreadable `meta.json`), and both keep the live session; `star --clear-sessions [all]` does the same non-interactively and exits.

After the first turn of a session (the first user message gets its first assistant reply), a lightweight background LLM request — same model, capped at 20 output tokens — summarizes the first user message into a short title (≤50 chars, matching the message's language) and stores it in `meta.json`, where the `/resume` list picks it up. Title generation is fire-and-forget: it never blocks the REPL or print-mode output, it runs only when the session has no title yet (resumed sessions keep their existing title; untitled older sessions get one after their next turn), and if the request fails the title simply stays empty — untitled sessions show as `(无标题)` in the list. An unfinished request is abandoned when the process exits. It applies wherever a session is attached, including print mode when resuming with `-r`/`-c`.

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
