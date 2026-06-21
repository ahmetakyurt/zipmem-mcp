# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository. It is intentionally complete: reading it should be enough to fully understand the project's purpose, architecture, data contracts, runtime behavior, and known limits.

---

## 1. What this project is

`zipmem-mcp` is an open-source, **local-first** MCP (Model Context Protocol) server **+ CLI** that gives terminal AI agents (Claude Code and similar) an **endless, low-token long-term memory**. It compresses session history via **Anchored Compacting** and persists it to a single JSON file under `.zipmem/`, so a new session can restore full project context at near-zero token cost.

It runs entirely on the local machine: no cloud, no API keys, no AI calls on the server side. The only runtime dependencies are `@modelcontextprotocol/sdk` and `zod`.

### The problem it solves
- Long agent sessions **bloat the context window**. Prompt caching reduces *cost* but not *window occupancy*.
- A ~5-minute idle invalidates the cloud KV cache, forcing full-price re-reads of huge histories.
- Manual "summarize the session" is lossy and tedious; dumping raw terminal logs just relocates the bloat.

### Anchored Compacting (the core philosophy)
Instead of storing the session, store its *meaning*:
- **Blueprints** — architecture, schemas, decisions, conventions, dependency choices → preserved **verbatim**.
- **Anchors** — code blocks are **never** stored; they become coordinates `[file_path -> line_range -> concept]`. The agent re-reads the file on demand to expand one.
- **Lessons** — multi-step bug hunts distilled into one-line summary + root-cause/fix, to prevent regressions.
- Everything else (raw code, dead ends, verbose logs, pleasantries, read-only file dumps) is **discarded**.

### The key architectural bet
**Compaction intelligence lives in a prompt directive, not in server code.** The agent (LLM) produces the structured payload; the server only validates, normalizes, deduplicates, merges, and persists. This keeps the server dependency-free, zero-latency, and key-free. The server can never compact on its own — it has no LLM.

---

## 2. Tech stack & layout

- **Language/runtime:** TypeScript, Node.js ≥ 18, **ESM** (`"type": "module"`).
- **Deps:** `@modelcontextprotocol/sdk` ^1.29 (supports zod `^3.25 || ^4`), `zod` ^4.
- **Dev:** vitest (+ v8 coverage), eslint (flat config) + typescript-eslint, prettier, typescript.
- **Two binaries** from one shared core (`package.json#bin`):
  - `zipmem` → `dist/cli.js` (developer CLI)
  - `zipmem-mcp` → `dist/index.js` (MCP stdio server)
- **`files: ["dist", ...]`** — only compiled output ships to npm; devDeps (vitest/vite/esbuild) never reach end users. (Those carry dev-only audit advisories; there are **no production vulnerabilities**.)

```
src/
  index.ts              # bin "zipmem-mcp": MCP stdio server entry + lifecycle wiring
  cli.ts                # bin "zipmem": CLI dispatcher (init | status), node:util parseArgs
  core/                 # SHARED KERNEL (imported by both entry points; they never import each other)
    schema.ts           # zod schemas + inferred types — single source of truth for on-disk shape
    state.ts            # state.json load/save/merge/prune (+ sync variants for shutdown)
    compactor.ts        # deterministic helpers: line-range parse/union-merge, lesson dedup, ids
    format.ts           # render State -> compact agent-readable text (load_memory output)
    directive.ts        # mode-aware Constitutional Directive: getDirective(mode) + markers, DIRECTIVE_VERSION
    session.ts          # crash-recovery layer: session.json lifecycle, pending buffer, git capture
  server/
    index.ts            # registerTools(server) — wires all three tools
    lifecycle.ts        # parent-process monitor, shutdown marker, startup recovery
    tools/
      load-memory.ts    # zipmem_load_memory  (handler + register fn)
      save-compact.ts   # zipmem_save_and_compact
      checkpoint.ts     # zipmem_checkpoint
  cli/
    init.ts             # zipmem init [--shared] [--checkpoint=<mode>]
    status.ts           # zipmem status
    helpers.ts          # ANSI, project-name inference, directive injection, .gitignore handling
  utils/
    paths.ts            # project-dir resolution + .zipmem path helpers
    version.ts          # read version from package.json at runtime
tests/                  # vitest, mirrors src/ (core, server, cli) + smoke-mcp.mjs, smoke-crash.mjs
```

Tool files export a **pure handler** (`loadMemoryHandler` / `saveCompactHandler` / `checkpointHandler`) plus a `register*` function. Tests call the pure handlers directly — no MCP transport needed.

---

## 3. On-disk data

Everything lives under `.zipmem/` in the project root.

### `.zipmem/state.json` — the persistent memory (schema in `core/schema.ts`)
```
version: 1
project_name, created_at, updated_at
blueprints[]   { id, category(architecture|schema|decision|convention|dependency), title, content, immutable, timestamp }
anchors[]      { file_path, line_range ("42-67"), concept, timestamp }
lessons[]      { id, summary, detail, related_files[], timestamp }
session_log[]  { session_id, started_at, ended_at, summary, anchors_added, lessons_added }
meta           { total_compactions, total_sessions, state_size_bytes, shared, checkpoint_mode }
```

`meta.checkpoint_mode` ∈ `conservative | balanced | aggressive` (default `balanced`). It only shapes the **injected directive** (how often the agent is told to checkpoint); the server treats every checkpoint identically. Defaulted in the schema so state files written before the field existed still validate.

### `.zipmem/session.json` — ephemeral runtime/recovery state (schema in `core/session.ts`)
```
version: 1
session_id, status(active|closed|interrupted), pid, ppid, started_at, updated_at
reason?              # why the session ended abruptly (e.g. "SIGINT", "stdin-end")
uncompacted_files?   # git-changed files captured as recovery hints (paths, never code)
pending: {           # staged checkpoints NOT yet folded into state.json
  session_summary, blueprints[], anchors[], lessons[]
}
recovery?: { from_session, reason, recovered_*, uncompacted_files[], acknowledged }
```
`session.json` is **always gitignored** (via `.zipmem/.gitignore`), even in `--shared` mode — only `state.json` is meant to be shared.

### Merge rules (`mergeState` in `core/state.ts`)
- **Blueprints:** dedup by `category`+`title`. Immutable existing ones are kept verbatim; an incoming blueprint with the same key and `immutable: false` supersedes it.
- **Anchors:** dedup by `file_path` + overlapping/adjacent `line_range`. Overlapping ranges **union-merge**; the newest `concept` wins. Non-overlapping ranges for the same file coexist.
- **Lessons:** appended; skipped if a case-insensitive summary-containment duplicate exists.
- **Session log:** always appended (audit trail).

### Size management (`pruneState`)
- Soft limit **100 KB** → a warning is surfaced in `load_memory` output.
- Hard limit **500 KB** → next compaction auto-prunes, least-valuable first: (1) anchors older than 30 days whose target file no longer exists, (2) collapse session-log rows older than 30 days into one summary row, (3) drop oldest lessons until under the limit.

### Atomicity
All writes are atomic: serialize → write `*.tmp` → `rename`. A crash mid-write can never corrupt `state.json` or `session.json`. Sync variants (`saveStateSync`, `writeSessionSync`) exist for the shutdown path where the event loop can't be awaited.

---

## 4. The three MCP tools

Tool names/descriptions are written to self-signal *when* to fire (agents read tool descriptions every loop).

1. **`zipmem_load_memory`** — *Call first, every session.* Reads `state.json`, returns compact text (blueprints, anchors as `[path -> lines -> concept]`, lessons, recent sessions). Prepends a **⚠️ ZipMem recovery** banner if the previous session ended unclean. Params: `project_dir?`, `sections?`.
2. **`zipmem_checkpoint`** — *Call during work, at a cadence set by `checkpoint_mode`* (every unit / milestones-only / never-unless-the-user-says `checkpoint`). Stages incremental progress (blueprints/anchors/lessons + running summary) into `session.json.pending`. **Crash-safe but NOT finalization** — it never touches `state.json`. Params: `project_dir?`, `summary?`, `blueprints?`, `anchors?`, `lessons?`.
3. **`zipmem_save_and_compact`** — *Call when the session is wrapping up (an end-of-session intent expressed in a chat message — "we're done", "goodbye", or `save`) or near the context limit.* Folds `session.pending` + the final payload into a single `mergeState`, prunes if needed, writes `state.json`, then marks the session `closed` and clears pending. Params: `project_dir?`, `session_summary` (required), `blueprints?`, `anchors?`, `lessons?`. **Note:** the CLI's own `exit`/`quit` quit instantly and never reach the agent, so they cannot trigger this — see §7.

**Project-dir resolution** (`utils/paths.ts`): explicit param → `CLAUDE_PROJECT_DIR` (set by Claude Code) → nearest `.zipmem/` ancestor → `cwd`. The server pins one project dir at startup for its lifecycle/recovery.

---

## 5. The Constitutional Directive (`core/directive.ts`)

A markdown block injected into the project's `CLAUDE.md` (or `memory.md`) by `zipmem init`, wrapped in `<!-- zipmem:start -->` / `<!-- zipmem:end -->` markers and versioned by `DIRECTIVE_VERSION` (currently **5**). The block is **mode-aware**: `getDirective(mode)` builds it; only section 2's checkpoint-cadence paragraph varies between modes, everything else is shared. It instructs any model to:
1. **On start:** always call `zipmem_load_memory` (don't ask).
2. **During the session (cadence depends on `checkpoint_mode`):**
   - `aggressive` — call `zipmem_checkpoint` after each meaningful unit of work.
   - `balanced` (default) — checkpoint only at major milestones (big refactor done, critical bug fixed, foundational decision made).
   - `conservative` — never persist on its own; map two plain-word user commands to tools: "checkpoint" → `zipmem_checkpoint` (stage), "save" → `zipmem_save_and_compact` (full compaction). Run the matching tool immediately, no slash commands, then a one-line confirmation.
   All modes still watch context pressure and honor a recovery banner if present.
3. **Before exit / near limit:** call `zipmem_save_and_compact` with structured blueprints/anchors/lessons.
4. **Preserve vs. anchor vs. distill vs. discard** rules (see §1).
5. **Be terse** (added in v5): every checkpoint/compaction is paid-per-token agent output, so each `concept`/`summary` stays one line, `detail` one–two sentences, and only genuinely new/changed `blueprints` are resent — density over volume keeps the next session's reload cheap.

This directive is the only thing that makes agents compress correctly. Bump `DIRECTIVE_VERSION` whenever the body changes so `init` replaces stale blocks in place instead of appending duplicates. Because the rendered block embeds the active mode, switching modes (`zipmem init --checkpoint=…`) also rewrites the block in place via the same marker-replacement path.

---

## 6. CLI

```
zipmem init [--shared] [--checkpoint=<mode>]
                         # bootstrap: create .zipmem/state.json + .zipmem/.gitignore,
                         #   inject directive into CLAUDE.md/memory.md (idempotent),
                         #   handle outer .gitignore, print the `claude mcp add` command
                         #   <mode> ∈ conservative|balanced|aggressive (default balanced)
zipmem status            # counts (blueprints/anchors/lessons/sessions/compactions),
                         #   size vs. limits, mode (local|shared), checkpoint mode, timestamps
zipmem --version | --help
```

`init` behavior: never overwrites existing content; if `CLAUDE.md` exists it appends the directive, else `memory.md`, else creates `CLAUDE.md`. **Default (local):** adds `.zipmem/` to the outer `.gitignore`. **`--shared`:** leaves the outer `.gitignore` untouched (so `state.json` is committed) and marks `meta.shared = true`. **`--checkpoint=<mode>`:** validated against `conservative|balanced|aggressive` (an unknown value errors out); a new project stores it in `meta.checkpoint_mode`, and re-running `init` with a *different* mode updates an existing project's stored mode + directive (re-running *without* the flag leaves the stored mode untouched). Register the server with: `claude mcp add zipmem-mcp -- npx zipmem-mcp`.

---

## 7. Crash safety & lifecycle (the non-obvious part)

The whole design assumes the agent may NOT get to call `save_and_compact` (closed terminal, Ctrl+C, kill). Durability is layered, and deliberately does **not** rely on catching the death signal:

1. **Continuous checkpointing → disk.** Each `zipmem_checkpoint` writes `session.json` atomically. A hard exit loses at most the work since the last checkpoint, and that data is already on disk.
2. **Parent-process lifecycle monitor** (`LifecycleMonitor` in `server/lifecycle.ts`). Watches the `claude` process via stdin EOF/close (most reliable, cross-platform), `SIGINT`/`SIGTERM`/`SIGHUP`, and a PID-liveness probe (`process.kill(ppid, 0)`). On a *catchable* termination it does the **minimal safe thing**: one atomic `session.json` write marking the session `interrupted` + the reason. It does **not** fold into `state.json` or run git (heavy I/O risks a torn write in the narrow OS termination window).
3. **Next-startup recovery** (`runStartupRecovery`). On boot, if the prior session didn't close cleanly, it folds any leftover `pending` into `state.json`, captures git-changed files, and stamps a `recovery` block. `load_memory` then surfaces the banner once. This is the **authoritative** path and also covers `SIGKILL`/power-loss (where no handler ran, status stays `active`).

### Exit scenarios (what actually happens)
| User action | OS signal | Handler runs? | Result |
|---|---|---|---|
| Says "we're done"/"goodbye"/`save` **in a chat message** | none (message reaches the **agent**) | n/a | Agent calls `save_and_compact` → **clean, full save** (best case — LLM still alive to compact) |
| Types `exit` / `quit` (Claude Code CLI command) | stdin EOF / SIGHUP (terminal closes instantly) | yes (minimal) | Agent never gets a turn, so **no `save_and_compact`**; session marked `interrupted`; **last checkpointed** data recovered next startup |
| Ctrl+C | SIGINT (catchable) | yes | session marked `interrupted`; **last checkpointed** data recovered next startup |
| Close terminal (X) | SIGHUP / stdin EOF | yes | same as Ctrl+C |
| Kill / Task Manager / force-quit | SIGKILL (uncatchable) | no | status stays `active`; next-startup recovery still folds last checkpoint |

**Key correction (verified empirically):** `exit`/`quit` are Claude Code's own REPL commands — they close the terminal *before* the agent gets a turn, so they do **not** produce a clean `save_and_compact`. Only an end-of-session intent sent as a normal chat message does. The reliable clean-save flow is: send "save" / "we're done" in chat → let the agent compact → *then* type `exit`.

**The differentiator is not the signal — it's whether the agent persisted.** If the agent never called `checkpoint` or `save_and_compact`, there is nothing staged and that session's semantic memory is lost (the server cannot regenerate it without the LLM). In `conservative` mode this is entirely manual: say `checkpoint` to stage or `save` to compact.

---

## 8. Known limitations (be honest about these)

- **No concurrent same-project sessions.** `session.json` is a single "current session" file and `state.json` uses read-modify-write without locking. Two `claude` sessions in the **same** project simultaneously will clobber `session.json` and can lose compactions via RMW races. **Different** projects are fully isolated and safe. (Fixing this would need per-session files like `session-<pid>.json` + a lock / optimistic concurrency on `state.json`.)
- **Recovery depends on checkpoint discipline.** The agent must actually call `checkpoint`/`save` during the session; the directive instructs this but cannot force it.
- **No semantic compaction at death time.** It requires the LLM; the death handler only marks the event. Raw code / `git diff` is never written into memory — only file paths as hints.

---

## 9. Token-cost model

- **Static, cacheable (window cost, low $):** the three tool definitions (~1,300 tok/turn) and the injected directive (~790 tok/session for `balanced`; ~760 `aggressive`, ~950 `conservative`) sit in context but are prompt-cacheable.
- **Generated, never cached (real per-token cost):** each `checkpoint` and the final `save_and_compact` are agent output. Frequent checkpoints grow the transcript by small deltas (not "re-reading everything").
- **Read once per session:** `load_memory` returns the *compressed* memory.
- **Zero at death:** no LLM runs during shutdown/recovery.
- Net: a bounded, mostly-cacheable overhead now in exchange for avoiding an unbounded raw-history re-read in the next session. Strongly net-positive for long/multi-session work; pure overhead for one-off short chats. Checkpoint cadence (set in the directive) is the main cost/durability knob.

See `docs/token-economics.md` for a detailed, assumption-stated per-stage and cross-session cost model (cost by mode × chat length, cross-session savings, competitor comparison).

---

## 10. Commands

```bash
npm install
npm run build         # tsc -> dist/ (both bins emit here)
npm test              # vitest, all tests (58)
npx vitest run tests/core/state.test.ts        # single file
npx vitest run -t "merges overlapping anchors"  # single test by name
npm run lint          # eslint (src + tests); tests/*.mjs are ignored
npm run format        # prettier --write
# Manual end-to-end smoke tests (build first):
node tests/smoke-mcp.mjs <projectDir>   # MCP handshake + save->load
node tests/smoke-crash.mjs              # checkpoint -> hard exit -> next-session recovery
```

---

## 11. Invariants that are easy to violate

- **The server must never write to stdout.** stdout carries the MCP JSON-RPC framing; any stray `console.log` corrupts it. All server diagnostics go to `console.error`. Enforced by an eslint `no-console` rule scoped to `src/server/**` and `src/index.ts` — keep it satisfied rather than disabling it. (CLI files print to stdout intentionally and are exempt.)
- **Compaction intelligence lives in `core/directive.ts`, not in code.** `core/compactor.ts` contains *zero* LLM/AI logic. Do not add AI calls or network dependencies to the server — deliberate (dependency-free, zero-latency, no API keys).
- **All writes are atomic** (`*.tmp` then `rename`); never write `state.json`/`session.json` in place. `writeSessionSync` runs inside signal handlers and must stay synchronous; `loadStateSync`/`saveStateSync` are used by `runStartupRecovery`.
- **The death handler is deliberately minimal** — it only marks `interrupted` + records the reason. Do **not** move folding (or git) back into it. All folding happens in `runStartupRecovery` at the next calm startup.
- **The shutdown/recovery path must never throw** — both `flushOnShutdownSync` and `runStartupRecovery` are try/catch-wrapped and idempotent; failure degrades to "next session recovers from `session.json`."
- **Checkpoints are durability, not finalization.** `zipmem_checkpoint` writes only `session.json.pending`; the fold into `state.json` happens exactly once (in `save_and_compact` or recovery) to avoid double-counting `session_log`.
- **Merge rules are precise** (see §3 / `mergeState`); changing any requires updating `tests/core/state.test.ts`.
- **Directive injection is idempotent** via the markers + `DIRECTIVE_VERSION`; bump the version when the body changes. The rendered block also embeds the active `checkpoint_mode`, so equality (skip vs. replace) is computed against `getDirective(mode)`, not a single constant.

---

## 12. Conventions

- ESM throughout; **relative imports must use the `.js` extension** (TS `Node16` resolution), e.g. `import { loadState } from "../core/state.js"`.
- MCP tool input schemas are passed as **raw zod shapes** (plain objects of zod types) to `server.registerTool`, not `z.object(...)`.
- The package version is read at runtime from `package.json` (`utils/version.ts`); don't hardcode it.
- Tests are colocated under `tests/` mirroring `src/`; pure tool handlers are tested without a transport. `tests/*.mjs` are standalone manual runners (ignored by eslint/vitest).
