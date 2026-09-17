# AGENTS.md

Guidance for AI agents working in this repository.

## Project

Star CLI — an AI agent CLI in TypeScript (strict ESM). Build: tsup. Tests: vitest. Lint: biome. Package manager: pnpm.

## Commands

- `pnpm build` — bundle to `dist/` (entry `src/main.tsx`)
- `pnpm test` — run all vitest tests (must stay green)
- `pnpm typecheck` — `tsc --noEmit` (must stay clean)
- `pnpm lint` — biome check

## Layout

- `src/core/` — shared types: `messages.ts` (CoreMessage), `events.ts` (StreamEvent)
- `src/config/` — zod schema (`schema.ts`), TOML loader chain, API key resolution, paths (`STAR_HOME` env overrides `~/.star-cli`, use it in tests)
- `src/llm/` — Vercel AI SDK provider factory + normalized streaming (`streamChat` yields StreamEvent)
- `src/tools/` — Tool interface (`types.ts`), registry, built-in fs/bash/todo tools; no new npm deps for glob/grep (self-implemented)
- `src/agent/loop.ts` — agent main loop: multi-step tool calling, permission gate, compaction, persistence; implements the `ChatBackend` shape `stream(input, signal)`
- `src/cli/` — Ink REPL: components, slash commands, streaming with 30ms frame batching
- `src/context/` — token estimation + truncation compaction
- `src/permissions/` — modes auto/ask/readonly + hard safety rules (`checkPermission` pure function)
- `src/session/` — JSONL session persistence + resume

## Conventions

- No new npm dependencies without discussion; prefer stdlib/self-implemented.
- 2-space indent, biome formatting, no decorative comments.
- Tests live in `tests/`, use temp dirs (`fs.mkdtempSync(os.tmpdir())`) and `STAR_HOME` for isolation; never hit the network in tests (use `MockLanguageModelV1` from `ai/test`).
- Relative imports are extensionless (bundler module resolution).
- Commit style: Conventional Commits.
