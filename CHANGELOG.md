# Changelog

All notable user-facing changes to this project are documented here, newest first.
Sections follow [Keep a Changelog](https://keepachangelog.com/) loosely; versions use
[Semantic Versioning](https://semver.org/).

**Maintenance rule:** every user-visible change (feat/fix/perf/UX/config/tooling) must add
an entry under `[Unreleased]` in the same commit that lands the change. On release, rename
`[Unreleased]` to the new version + date and open a fresh `[Unreleased]` section.

## [Unreleased]

### Added

- **`code_outline` tool**: prints a source file's or directory's declaration skeleton (functions, classes, methods, types with line numbers) without reading bodies — a lightweight zero-dependency regex extractor covering TS/JS, Python, Go, Rust, Java/Kotlin/C#, C/C++, Ruby, PHP, Shell, Swift, and Scala. Navigate unfamiliar code by outlining first, then reading exact line ranges, instead of billing whole files into the context. Honors `.starignore`, sensitive-path refusals, and symlink boundaries like the other fs tools; directory mode caps at 60 files / 30KB
- **subagent `read_only` mode**: research, exploration, and review subtasks can be spawned restricted to read-level tools (no file writes, no shell, no task kills) — hidden from the child's tool map so an attempted write is rejected before execution, with the permission gate as backstop. The subagent prompt now carries a report contract (self-contained outcome report with `path:line` citations) and the tool description carries briefing guidance, since subagents start with zero context
- **stronger one-shot task completion**: the system prompt now mandates a test-driven workflow — features and behavior changes ship with unit tests in the same change (project conventions permitting), and completion requires running the project's FULL verification (whole test suite, not only touched tests, plus typecheck/build/lint when defined) until green, with a leftovers sweep (debug prints, commented-out code) beforehand and an evidence rule when reporting (name the checks that passed). The semantic completion check applies the same bar: a reply claiming success on changed code without an observed green test run is judged NOT_DONE and nudged back to work
- **stale-content elision**: before whole-turn compaction would fire, the loop now replaces context dead weight in place — tool outputs older than the newest 24 messages and ≥250 tokens, plus old attached images, become short placeholders that say how to re-fetch them. Message count and order are untouched, so `/undo` turn coordinates stay valid (unlike compaction), and the history often shrinks enough that the conversation narrative survives intact instead of being compacted away

### Fixed

- **default stream idle timeout raised from 20s to 60s** (`streamIdleTimeoutSec`): the window only applies once visible content is streaming, but relays buffering large tool-call payloads or congested upstreams can still go byte-silent mid-reply for tens of seconds, and the first cutoff alone wastes a whole retry. Truly dead streams are still rescued by the watchdog (and truncated replies resume), just a little later
- **reasoning models no longer die as spurious idle-timeouts mid-thinking**: the stream watchdog demoted from the generous first-chunk window (default 300s) to the short idle window on the first reasoning delta, so a model like kimi k3 with high reasoning effort — which pauses mid-thinking with zero bytes for tens of seconds — got cut, the reasoning-only cutoff counted as an empty reply, and the retry resent the identical request into the same deterministic stall until the turn died with "empty response after retries". Reasoning (like control/metadata parts) now keeps the first-chunk window; only visible content (text/tool-call deltas) demotes to the idle window
- **token estimation switched from the chars/4 heuristic to a real BPE tokenizer** (`gpt-tokenizer`, pinned `cl100k_base`): the heuristic under-read punctuation-heavy code and JSON by 15-30%, so the status-bar ctx% and the auto-compaction threshold could trigger late and flirt with window overflow. Estimates are now near-exact for code, CJK, and mixed content; pasted `<|endoftext|>`-style strings count as ordinary text instead of throwing; per-message WeakMap caching keeps the per-step cost at zero for already-seen messages

## [0.3.9] - 2026-10-05

### Security

- **bash exfiltration chain closed**: child processes no longer inherit API keys loaded
  from `~/.star-cli/.env`; commands touching sensitive paths upgrade to ask even in auto
  mode, and combined with an outbound command (`curl`/`wget`/`nc`/`ssh`/…) are denied —
  the prompt-injection → read-secret → exfiltrate signature
- **SSRF guard for web_fetch**: hostnames are DNS-validated, private/loopback/link-local
  destinations refused by default, redirects followed manually with per-hop revalidation
  (`webFetchAllowPrivateHosts` opts out, global config only)
- **permissions**: new `ask` rule tier (precedence deny > ask > allow), `[permissions]
  sensitive = [...glob]` extends the sensitive-file patterns, PowerShell/pwsh/cmd
  dangerous-command coverage (`-enc` fails closed), unix wrapper/find/xargs/dd variants
- **config supply chain**: project `[[models]]` merge by name instead of replacing the
  global table; plaintext `apiKey` deprecated with a warning; config writes are 0600

### Added

- slash commands can declare argument hints: `/model` completes config model names,
  `/permission` its modes, `/clear-sessions`/`/copy`/`/init`/`/memory` wired
- restored history renders each tool call as a dim one-line summary at its original
  position, preserving the read-this-then-edited-that narrative on resume
- per-model `vision = false` marks text-only models so image tools decline cleanly

### Fixed

- **stream watchdog keepalive no longer silently drops a stream part per trigger**
  (heartbeat relays lost text deltas and even finish events — truncated replies,
  undercounted `/cost`)
- `/undo`: injected user messages (auto-continue nudges, background subagent reports)
  are tagged and no longer fake turn boundaries; the `/compact` vs double-Esc race can
  no longer resurrect a retracted turn; empty compaction summaries fall back to the
  truncation placeholder; session switch clears unsettled subagent usage
- **Windows correctness**: CRLF-tolerant `edit_file` matching, autocrlf forced off in
  git-tree snapshots, GBK fallback decoding for bash output, multibyte-safe hook stderr
- `write_file` refuses NUL content and files over 5MB; snapshot/undo round-trips are
  byte-exact for binary files (Buffer end-to-end)
- git-tree snapshots pin undo targets under `refs/star/*` (gc can't prune them) and run
  with a scrubbed `GIT_*` environment
- hooks: payloads over 16KB pipe via stdin (`STAR_TOOL_INPUT_STDIN=1`, avoids E2BIG);
  Stop hooks on the abort path cap at 3s so Esc stays instant
- retry policy: statusless errors retry only for network-family failures;
  400/401/403/404/413/422 fail fast instead of burning retries on deterministic bugs
- session: atomic checkpoint index with warnings, collision-proof session ids, win32 cwd
  normalization for `star -c`, `--image` requires `-p`, interactive mode requires a TTY,
  stdout EPIPE exits 0, `-r` with no sessions exits 1
- background tasks record ownership — subagents can only see and kill their own
- persisted todos are scoped to their owning session (no cross-session leaks on resume)
- config: `maxSteps = 0` (unlimited) can now be tightened by project config correctly

### Performance

- the 100ms spinner tick no longer re-renders the REPL root (tick state sunk into
  ThinkingIndicator; InputBox/TodoPanel/ThinkingIndicator memoized)
- resume renders only the newest 100 display items behind a one-line placeholder instead
  of synchronously markdown-rendering the whole history
- **context budget now includes the tool wire-schema overhead** (~2k tokens for the
  default registry) — auto-compact and the status bar ctx % share the same honest total
- compactMessages runs a single pass over cached per-message estimates; summary input is
  truncated while serializing (no MB-scale intermediate string); request messages are
  memoized per turn so stream retries don't copy the history
- gitSnapshots: the tree capture no longer blocks the first token — it is awaited before
  the turn's first tool executes instead
- permissions: one `lexShell` per command per check, compiled rule cache, realpath TTL
  cache with a UNC fast path (unreachable shares can't stall the render thread)
- `/search` streams sessions with early exit (O(needle) memory); session listing counts
  messages under an 8-way concurrency pool
- update check throttled to one registry request per 24h; `--version` ~40% faster with
  the AI SDK moved out of the static import graph

### Tools

- glob/grep follow symlinks (cycle-safe via realpath visited set, targets must stay
  inside the cwd), walk with a 16-way concurrency pool, and stop on Esc with partial
  results marked interrupted; nested `.starignore` files are honored with
  gitignore-style scoping
- web_fetch decodes with the declared charset (GBK/SJIS/Big5 stop coming back as
  mojibake), preserves links inline as `text (url)`, and returns a clean no-retry error
  for PDFs
- web_search falls back through duckduckgo-html → duckduckgo-lite → bing on failure or
  empty results, with the serving source in `STAR_DEBUG` logs

### Changed

- print mode formats tool calls with `summarizeArgs` one-liners instead of dumping full
  JSON args to stderr (`--json` keeps full args for machines)
- `StreamEvent.error` carries a serializable `StreamErrorInfo` (retry classification
  semantics unchanged); `coreMessageText` lives in core, shared by agent and cli;
  synthetic tool-result texts are named constants
- config unknown keys (including `streamMaxRetreis`-style typos in `[permissions]`,
  `[[providers]]`, `[[models]]`, `[[hooks]]`) draw a one-time warning with a
  did-you-mean suggestion; validation failures print readable `path: message` lines
  instead of a JSON blob

## [v0.3.8] - 2026-10-02

### Features

- feat: stage-1 modules (config, llm, tools, repl skeleton) (3f15c35)
- feat: stage-2 modules (permissions, context, session, todo) + agent loop (6e12bbc)
- feat: integrate agent loop with REPL, print mode, e2e tests, docs (7097108)
- feat: add web_fetch tool with HTML-to-text conversion (6dc10bf)
- feat: LLM-summarized context compaction with truncation fallback (a2042d6)
- feat: cursor-based editing in REPL input box (10ca9ea)
- feat: support OpenAI Responses API protocol for relay providers (a7ff136)
- feat: token usage stats via /cost command and print-mode summary (03213d2)
- feat: add web_search tool (4b2f1d3)
- feat: add /compact and /export commands (74e21f2)
- feat: persist always-allow permission rules to config (30158a5)
- feat: snapshot file writes and add /undo command (5d28c4e)
- feat: @file mentions inject file content into prompts (8c0c881)
- feat: slash command suggestions in REPL input (e1dc87d)
- feat: --json NDJSON output for print mode (a9ef29b)
- feat: diff preview in permission prompt (394f29d)
- feat: cost estimation and update notifier (a813900)
- feat: add /init and /doctor commands (7c96819)
- feat: !shell passthrough and custom slash commands (96c9332)
- feat: thinking spinner and dim reasoning preview (0c127b0)
- feat(tasks): background shell tasks with REPL visibility (a9d8c86)
- feat(cli): /undo retracts the last conversation turn when no file snapshot exists (a87550f)
- feat(cli): scope /undo to the last conversation turn (a26e77f)
- feat(permissions): add yolo mode and /permission command (f0d0ce0)
- feat(llm): two-phase stream watchdog with configurable idle timeout (3aab16a)
- feat(permissions): add plan mode with read-only research and plan approval flow (36afa26)
- feat(agent): add subagent tool for delegating focused subtasks (8cfd0ed)
- feat(cli): add git integration (/commit, /diff, git status in system prompt) (5d36224)
- feat(session): add /rewind checkpoints for multi-step rollback (4a233f5)
- feat(cli): enhance /resume with --all and add star -c to continue last session (fab5f65)
- feat(session): auto-generate conversation titles after the first turn (565ae8c)
- feat(config): add PreToolUse/PostToolUse/Stop hooks (e6b596e)
- feat(cli): add /usage dashboard aggregating token usage across sessions (2f32467)
- feat(cli): add terminal bell notification for long turns and background tasks (1b7a834)
- feat(session): add /new and /clear-sessions for session lifecycle management (0190521)
- feat(cli): support multimodal image input via @mentions and --image (a026ae4)
- feat(cli): UX bundle — project memory, input queue, path completion, clipboard paste, /copy, status bar, session budget (255a240)
- feat(config): per-model contextMaxTokens override and clearer pricing errors (2c2911f)
- feat: add skills — SKILL.md discovery, on-demand skill tool, /skills command (798c21d)
- feat: memory, session fork/search, .starignore, deny rules, input history, interactive pickers (9dfc469)
- feat(agent): retry transient stream failures instead of abandoning the turn (387926a)
- feat(agent): auto-continue when the model stops after announcing pending work (95b5df9)
- feat(agent): verify turn completion instead of guessing from keywords (0f7ab29)
- feat(cli): persistent todo panel above the input box (ac1e990)
- feat(agent): background subagents with parent-side monitoring (afb5c73)
- feat(agent): default to todos, verify before finishing, prefer script files (41e8c99)
- feat(cli): inline directory listings for @dir/ mentions (cef37dc)
- feat(cli): ctrl-r reverse history search (fe9b656)
- feat(cli): collapse large pastes into a placeholder in the input box (43d14ef)
- feat(cli): preview and confirm file reverts before /undo (6c9bd1c)
- feat(cli): keep partial output with an interrupted marker on Esc (314843d)
- feat(cli): show prompt cache hit rate in the status bar (a49c28a)
- feat(cli): add /connect wizard for provider onboarding with safe key storage (719c860)
- feat(agent): session-scoped todos and cheaper empty-reply recovery (8387753)
- feat(llm): retry policy, responses-protocol fixes, and empty-reply triage (ddf95e1)
- feat(snapshot): whole-tree git snapshots with /redo (4d3f7cb)
- feat: configurable auto-compaction threshold and relay-tolerance hardening (666f446)
- feat(agent): make maxSteps a progress checkpoint instead of a hard kill (e53be00)
- feat(llm): per-model reasoningEffort sent as provider metadata (146b66d)
- feat(cli): /model chains a reasoning-effort picker; effort levels free-form (3c747f2)
- feat(cli): terminal-safe icons, markdown rendering, split-keypress input (6dce342)
- feat(cli): render tables as a grid with vertical and row separators (5ce7815)
- feat(cli): wrap overlong table cells instead of truncating them (f7dd59d)
- feat(cli): format token counts as K/M and lazy-load the REPL (92fa04a)
- feat(config): add per-model temperature setting (f4a7415)
- feat(cli): add Kimi Code membership preset to /connect (c68933b)
- feat(llm): byte-level activity watchdog for stream liveness (0e8bcf5)
- feat(config): per-model stream watchdog timeout overrides (e8b83ba)
- feat(llm): stream tool-call argument progress events (3e931f2)
- feat(cli): richer tool cards and liveness cues in the waiting indicator (85518d1)
- feat(session): remove orphaned git-tree snapshots on /clear-sessions (745de59)
- feat(cli): show thinking elapsed time in m/h units (67f5dca)
- feat(connect): write temperature = 1 into new model blocks (3376024)
- feat(tools): read_image tool for in-session image input (102fa33)
- feat(tools): screenshot tool for visual verification (ec0adc2)
- feat(context): cut prompt-token spend with prompt caching and leaner resends (bac8bcb)
- feat(todo): drop finished lists from the panel and the disk (058bce1)

### Bug Fixes

- fix: robust shell detection on Windows (Git Bash lookup, cmd fallback) (0a6503b)
- fix: kill process tree on bash timeout/abort (Windows EBUSY on temp dirs) (25ad240)
- fix: session lifecycle and resume display (c4b09c4)
- fix: llm smoke arg splitting on Windows and libuv crash on forced exit (2f4076e)
- fix: sanitize non-finite token usage; robust llm smoke check (57737e9)
- fix: unique sibling keys in REPL and cross-platform permission tests (49421dd)
- fix: unify render tick to stop flicker; tolerate corrupt session JSON (c917e04)
- fix: reconcile dangling tool calls to unblock poisoned sessions (45fd8af)
- fix(cli): stop double-rendering tool cards, shrink live redraw area, surface background task starts (1e8bc1a)
- fix(llm): recover from relays that never close the stream, silence abort errors (14ead32)
- fix(repl): redraw transcript on /undo and /clear (b8b99e6)
- fix(hooks): kill the hook process group on POSIX timeouts (26f570c)
- fix(cli): stop the status bar ctx % from sticking at 0 (b028d02)
- fix(test): join os.tmpdir() before mkdtempSync in history tests (1342c9c)
- fix(cli): read SelectPrompt selection from a ref to avoid stale-index races (cba76b5)
- fix(test): make starignore mtime bumps strictly increasing (803bb3c)
- fix(test): raise status-bar-ctx timeouts for slow CI runners (6ab7026)
- fix(agent): re-nudge when an auto-continue nudge is answered with text-only (44b8370)
- fix(cli): keep the input cursor attached on soft-wrap and support multi-line input (ddfce14)
- fix(cli): keep slash commands out of history and unstick up-arrow recall (e35263a)
- fix(agent): downsample large pasted images and retry requests after stripping oversized images (0f3cf97)
- fix(cli): collapse chunked multi-event pastes instead of leaking the tail (a37c1b8)
- fix(cli): keep wizard text fields editable after bracketed pastes (7ff085d)
- fix(cli): stop live-region scroll spam during long thinking phases (47c7aca)
- fix(session): stop meta.json field wipes and untitled tool-first sessions (dbf036d)
- fix(config): sandbox project config and preserve comments on writes (191046a)
- fix(permissions): close grep/glob bypasses and command-chain rule evasion (d16f563)
- fix(tools): harden fs/bash/task tools against data corruption and abuse (ee9eca8)
- fix(llm): restore retry semantics, usage accounting and cache pricing (2fe20b0)
- fix(agent): session integrity hardening and doom-loop guard (8bab00e)
- fix(cli): REPL session-safety and rendering hardening (1ebd7a6)
- fix(cli): use English in session listing strings (95353f7)
- fix(session): retry transient Windows EPERM on meta writes (beeea0a)
- fix(cli): never split streamed tables or code fences across static chunks (c476a40)
- fix(cli): fit table grids to the terminal width (9b23af4)
- fix(permissions): harden command blacklist and allow-rule matching (2f72c4f)
- fix(tools): close read-path escapes, unsafe edits, and stdin hangs (7eda060)
- fix(config): keep project config from weakening protections (d53c18f)
- fix(snapshot): keep secrets out of git trees and bound their cost (347bbb2)
- fix(session): make message persistence retried, atomic, and streaming (239c521)
- fix(agent): bill subagent usage and tighten turn lifecycle (2ba13cc)
- fix(cli): stop Ctrl+C exits, compact races, and modal Esc leaks (a49a6d4)
- fix(llm): don't count control stream parts as content for the idle watchdog (38bbf97)
- fix(agent): treat whitespace-only replies as empty output (eb7f6ab)
- fix(agent): resume watchdog-truncated replies instead of accepting them (86ff9ca)
- fix(llm): split relay SSE payloads glued without a newline (5ebd188)
- fix(llm): don't flag reasoning-only idle cutoffs as truncated (3e79ced)
- fix(session): keep the recorded model in sync on /model switch (98f9d72)
- fix(cli): reset the turn timer when /compact starts (b4c9962)

### Performance

- perf(context): cache token estimates and linearize compaction (530b9e6)


## [v0.3.7] - 2026-10-01

### Features

- feat(tools): screenshot tool for visual verification (ec0adc2)
- feat(context): cut prompt-token spend with prompt caching and leaner resends (bac8bcb)
- feat(todo): drop finished lists from the panel and the disk (058bce1)

### Bug Fixes

- fix(cli): reset the turn timer when /compact starts (b4c9962)


## [v0.3.6] - 2026-09-28

### Features

- feat(cli): format token counts as K/M and lazy-load the REPL (92fa04a)
- feat(config): add per-model temperature setting (f4a7415)
- feat(cli): add Kimi Code membership preset to /connect (c68933b)
- feat(llm): byte-level activity watchdog for stream liveness (0e8bcf5)
- feat(config): per-model stream watchdog timeout overrides (e8b83ba)
- feat(llm): stream tool-call argument progress events (3e931f2)
- feat(cli): richer tool cards and liveness cues in the waiting indicator (85518d1)
- feat(session): remove orphaned git-tree snapshots on /clear-sessions (745de59)
- feat(cli): show thinking elapsed time in m/h units (67f5dca)
- feat(connect): write temperature = 1 into new model blocks (3376024)
- feat(tools): read_image tool for in-session image input (102fa33)

### Bug Fixes

- fix(permissions): harden command blacklist and allow-rule matching (2f72c4f)
- fix(tools): close read-path escapes, unsafe edits, and stdin hangs (7eda060)
- fix(config): keep project config from weakening protections (d53c18f)
- fix(snapshot): keep secrets out of git trees and bound their cost (347bbb2)
- fix(session): make message persistence retried, atomic, and streaming (239c521)
- fix(agent): bill subagent usage and tighten turn lifecycle (2ba13cc)
- fix(cli): stop Ctrl+C exits, compact races, and modal Esc leaks (a49a6d4)
- fix(llm): don't count control stream parts as content for the idle watchdog (38bbf97)
- fix(agent): treat whitespace-only replies as empty output (eb7f6ab)
- fix(agent): resume watchdog-truncated replies instead of accepting them (86ff9ca)
- fix(llm): split relay SSE payloads glued without a newline (5ebd188)
- fix(llm): don't flag reasoning-only idle cutoffs as truncated (3e79ced)
- fix(session): keep the recorded model in sync on /model switch (98f9d72)

### Performance

- perf(context): cache token estimates and linearize compaction (530b9e6)


## [v0.3.5] - 2026-09-27

### Features

- feat(llm): per-model reasoningEffort sent as provider metadata (146b66d)
- feat(cli): /model chains a reasoning-effort picker; effort levels free-form (3c747f2)
- feat(cli): terminal-safe icons, markdown rendering, split-keypress input (6dce342)
- feat(cli): render tables as a grid with vertical and row separators (5ce7815)
- feat(cli): wrap overlong table cells instead of truncating them (f7dd59d)

### Bug Fixes

- fix(cli): never split streamed tables or code fences across static chunks (c476a40)
- fix(cli): fit table grids to the terminal width (9b23af4)


## [v0.3.2] - 2026-09-26

### Features

- feat(snapshot): whole-tree git snapshots with /redo (4d3f7cb)
- feat: configurable auto-compaction threshold and relay-tolerance hardening (666f446)
- feat(agent): make maxSteps a progress checkpoint instead of a hard kill (e53be00)

### Bug Fixes

- fix(session): stop meta.json field wipes and untitled tool-first sessions (dbf036d)
- fix(config): sandbox project config and preserve comments on writes (191046a)
- fix(permissions): close grep/glob bypasses and command-chain rule evasion (d16f563)
- fix(tools): harden fs/bash/task tools against data corruption and abuse (ee9eca8)
- fix(llm): restore retry semantics, usage accounting and cache pricing (2fe20b0)
- fix(agent): session integrity hardening and doom-loop guard (8bab00e)
- fix(cli): REPL session-safety and rendering hardening (1ebd7a6)
- fix(cli): use English in session listing strings (95353f7)
- fix(session): retry transient Windows EPERM on meta writes (beeea0a)


## [v0.3.1] - 2026-09-24

### Features

- feat(llm): retry policy, responses-protocol fixes, and empty-reply triage (ddf95e1)

### Bug Fixes

- fix(cli): stop live-region scroll spam during long thinking phases (47c7aca)


## [v0.3.0] - 2026-09-24

### Features

- feat(cli): inline directory listings for @dir/ mentions (cef37dc)
- feat(cli): ctrl-r reverse history search (fe9b656)
- feat(cli): collapse large pastes into a placeholder in the input box (43d14ef)
- feat(cli): preview and confirm file reverts before /undo (6c9bd1c)
- feat(cli): keep partial output with an interrupted marker on Esc (314843d)
- feat(cli): show prompt cache hit rate in the status bar (a49c28a)
- feat(cli): add /connect wizard for provider onboarding with safe key storage (719c860)
- feat(agent): session-scoped todos and cheaper empty-reply recovery (8387753)

### Bug Fixes

- fix(cli): keep slash commands out of history and unstick up-arrow recall (e35263a)
- fix(agent): downsample large pasted images and retry requests after stripping oversized images (0f3cf97)
- fix(cli): collapse chunked multi-event pastes instead of leaking the tail (a37c1b8)
- fix(cli): keep wizard text fields editable after bracketed pastes (7ff085d)


## [v0.2.2] - 2026-09-22

### Features

- feat(agent): retry transient stream failures instead of abandoning the turn (387926a)
- feat(agent): auto-continue when the model stops after announcing pending work (95b5df9)
- feat(agent): verify turn completion instead of guessing from keywords (0f7ab29)
- feat(cli): persistent todo panel above the input box (ac1e990)
- feat(agent): background subagents with parent-side monitoring (afb5c73)
- feat(agent): default to todos, verify before finishing, prefer script files (41e8c99)

### Bug Fixes

- fix(test): join os.tmpdir() before mkdtempSync in history tests (1342c9c)
- fix(cli): read SelectPrompt selection from a ref to avoid stale-index races (cba76b5)
- fix(test): make starignore mtime bumps strictly increasing (803bb3c)
- fix(test): raise status-bar-ctx timeouts for slow CI runners (6ab7026)
- fix(agent): re-nudge when an auto-continue nudge is answered with text-only (44b8370)
- fix(cli): keep the input cursor attached on soft-wrap and support multi-line input (ddfce14)


## [v0.2.0] - 2026-09-21

### Features

- feat(config): per-model contextMaxTokens override and clearer pricing errors (2c2911f)
- feat: add skills — SKILL.md discovery, on-demand skill tool, /skills command (798c21d)
- feat: memory, session fork/search, .starignore, deny rules, input history, interactive pickers (9dfc469)

### Bug Fixes

- fix(cli): stop the status bar ctx % from sticking at 0 (b028d02)


## [v0.1.1] - 2026-09-18

### Features

- feat: --json NDJSON output for print mode (a9ef29b)
- feat: diff preview in permission prompt (394f29d)
- feat: cost estimation and update notifier (a813900)
- feat: add /init and /doctor commands (7c96819)
- feat: !shell passthrough and custom slash commands (96c9332)
- feat: thinking spinner and dim reasoning preview (0c127b0)
- feat(tasks): background shell tasks with REPL visibility (a9d8c86)
- feat(cli): /undo retracts the last conversation turn when no file snapshot exists (a87550f)
- feat(cli): scope /undo to the last conversation turn (a26e77f)
- feat(permissions): add yolo mode and /permission command (f0d0ce0)
- feat(llm): two-phase stream watchdog with configurable idle timeout (3aab16a)
- feat(permissions): add plan mode with read-only research and plan approval flow (36afa26)
- feat(agent): add subagent tool for delegating focused subtasks (8cfd0ed)
- feat(cli): add git integration (/commit, /diff, git status in system prompt) (5d36224)
- feat(session): add /rewind checkpoints for multi-step rollback (4a233f5)
- feat(cli): enhance /resume with --all and add star -c to continue last session (fab5f65)
- feat(session): auto-generate conversation titles after the first turn (565ae8c)
- feat(config): add PreToolUse/PostToolUse/Stop hooks (e6b596e)
- feat(cli): add /usage dashboard aggregating token usage across sessions (2f32467)
- feat(cli): add terminal bell notification for long turns and background tasks (1b7a834)
- feat(session): add /new and /clear-sessions for session lifecycle management (0190521)
- feat(cli): support multimodal image input via @mentions and --image (a026ae4)
- feat(cli): UX bundle — project memory, input queue, path completion, clipboard paste, /copy, status bar, session budget (255a240)

### Bug Fixes

- fix: unify render tick to stop flicker; tolerate corrupt session JSON (c917e04)
- fix: reconcile dangling tool calls to unblock poisoned sessions (45fd8af)
- fix(cli): stop double-rendering tool cards, shrink live redraw area, surface background task starts (1e8bc1a)
- fix(llm): recover from relays that never close the stream, silence abort errors (14ead32)
- fix(repl): redraw transcript on /undo and /clear (b8b99e6)
- fix(hooks): kill the hook process group on POSIX timeouts (26f570c)

