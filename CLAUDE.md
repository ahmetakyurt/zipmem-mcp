# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`zipmem-mcp` is a local-first MCP server + CLI that gives terminal AI agents an endless, low-token memory via **Anchored Compacting**. Two binaries are produced from one shared core:

- **`zipmem`** (`src/cli.ts`) — the developer-facing CLI (`init`, `status`).
- **`zipmem-mcp`** (`src/index.ts`) — the MCP stdio server exposing the agent-facing tools.

## Commands

```bash
npm install
npm run build         # tsc -> dist/ (both bins emit here)
npm test              # vitest, all tests
npx vitest run tests/core/state.test.ts     # single file
npx vitest run -t "merges overlapping anchors"   # single test by name
npm run lint          # eslint (src + tests)
npm run format        # prettier --write
node tests/smoke-mcp.mjs <projectDir>   # manual end-to-end MCP handshake (build first)
```

## Architecture (the big picture)

```
src/cli.ts ─┐                          ┌─ src/index.ts
            ├──►  src/core/  ◄──────────┤
src/cli/*  ─┘    (shared kernel)        └─ src/server/*
```

`src/core/` is the **shared kernel** that both entry points import; the two entry points never import each other. Read these together to understand the system:

- **`core/schema.ts`** — the single source of truth. Zod schemas + inferred types for the on-disk `State` and for the agent's `CompactionPayload`. Every other module depends on these types. The on-disk shape is `.zipmem/state.json`.
- **`core/state.ts`** — the load/save/merge/prune kernel. Holds the size limits and `createEmptyState`, `loadState`, `saveState`, `mergeState`, `pruneState`.
- **`core/compactor.ts`** — deterministic helpers only (line-range parsing/union-merging, lesson dedup, id/timestamp stamping).
- **`core/format.ts`** — renders `State` into the compact text returned by `zipmem_load_memory`.
- **`core/directive.ts`** — the Constitutional Directive string injected into `CLAUDE.md` by `init`.
- **`server/tools/*.ts`** — each tool file exports a **pure handler** (`loadMemoryHandler` / `saveCompactHandler`) plus a `register*` wiring function. Tests call the pure handlers directly, with no MCP transport.

### Load/save data flow

`zipmem_load_memory` → `resolveProjectDir` → `loadState` → `formatMemory` → text.
`zipmem_save_and_compact` → validate payload via `CompactionPayloadSchema` → `loadState` → `mergeState` → `pruneState` → `saveState`.

## Invariants that are easy to violate

- **The server must never write to stdout.** stdout carries the MCP JSON-RPC framing; any stray `console.log` corrupts it. All server diagnostics go to `console.error`. This is enforced by an eslint `no-console` rule scoped to `src/server/**` and `src/index.ts` — keep that rule satisfied rather than disabling it. (CLI files are exempt; they print to stdout intentionally.)
- **The compaction intelligence lives in `core/directive.ts`, not in code.** `core/compactor.ts` contains *zero* LLM/AI logic — the agent produces the structured payload, the server only normalizes/dedups/merges. Do not add AI calls or network dependencies to the server; that is a deliberate architectural choice (dependency-free, zero-latency, no API keys).
- **`saveState` is atomic** (write to `*.tmp`, then `rename`). Preserve this; never write `state.json` in place.
- **Merge rules are precise** (see `mergeState`): immutable blueprints are kept verbatim and only superseded when an incoming blueprint with the same `category`+`title` sets `immutable: false`; anchors for the same file with overlapping/adjacent ranges union-merge (newest concept wins); duplicate lessons are skipped by case-insensitive summary containment. Changing any of these requires updating `tests/core/state.test.ts`.
- **Directive injection is idempotent** via the `<!-- zipmem:start -->` / `<!-- zipmem:end -->` markers and `DIRECTIVE_VERSION` in `core/directive.ts`. If you change the directive body, bump `DIRECTIVE_VERSION` so `init` replaces stale blocks in place instead of appending a duplicate.

## Conventions

- ESM throughout (`"type": "module"`); **relative imports must use the `.js` extension** (TypeScript `Node16` resolution), e.g. `import { loadState } from "../core/state.js"`.
- zod ^4 (the MCP SDK ^1.29 supports `^3.25 || ^4`). MCP tool input schemas are passed as **raw zod shapes** (plain objects of zod types) to `server.registerTool`, not `z.object(...)`.
- The package version is read at runtime from `package.json` (`utils/version.ts`); don't hardcode it elsewhere.
