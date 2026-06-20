# zipmem-mcp

**Endless semantic memory for terminal AI agents — without the bloated context window.**

`zipmem-mcp` is a local-first [MCP](https://modelcontextprotocol.io) server + CLI that lets agents like Claude Code carry an entire project's history across sessions while keeping the live context window small. It works by **Anchored Compacting**: stripping semantic noise, replacing massive code blocks with file-coordinate *anchors*, and preserving architectural blueprints, schemas, and hard-won lessons verbatim.

No cloud. No API keys. No AI calls on the server side. Your memory lives in a single human-readable JSON file under `.zipmem/`.

---

## The problem

Long, high-intensity agent sessions **fill up the context window**:

- **Prompt caching only saves money, not space.** Cached or not, every re-read of a giant terminal history still consumes window tokens.
- **A 5-minute idle invalidates the cloud KV cache.** The next turn re-reads the whole history at *full price*.
- **Manual "summarize the session" is lossy and tedious**, and dumping raw terminal logs just moves the bloat around.

## The approach: Anchored Compacting

Instead of storing the session, `zipmem` stores its *meaning*:

| Raw session content | What zipmem keeps |
| --- | --- |
| 200-line code block you just wrote | `[src/auth/oauth.ts -> 15-42 -> PKCE flow with refresh-token rotation]` |
| A 6-step debugging saga | A one-line **lesson**: _"Stripe webhook must be idempotent — it retries on 5xx"_ |
| Architecture you designed | A **blueprint**, preserved verbatim |
| Repetitive logs, dead ends, pleasantries | _Discarded_ |

Anchors are coordinates, not code — the agent re-reads the file on demand when it actually needs the detail. The result is an endless memory loop where the window stays small but nothing foundational is ever lost.

> **The intelligence lives in the prompt, not the server.** `zipmem init` injects a *Constitutional Directive* into your `CLAUDE.md`. The agent itself produces the compact, structured payload; the server only validates, deduplicates, merges, and persists. That keeps the server dependency-free and instant.

---

## Install

```bash
npm install -g zipmem-mcp
```

Requires Node.js ≥ 18.

## Quick start

```bash
# 1. Initialize in your project root (once)
cd your-project
zipmem init

# 2. Register the MCP server with Claude Code (once)
claude mcp add zipmem-mcp -- npx zipmem-mcp
```

That's it. `zipmem init`:

- creates `.zipmem/state.json` (your memory store),
- injects the Constitutional Directive into `CLAUDE.md` (or `memory.md`, or creates `CLAUDE.md`),
- adds `.zipmem/` to `.gitignore` (keep memory local — see [Shared memory](#shared-vs-local-memory)).

From the next session on, the agent **loads memory automatically at the start** and **compacts automatically when you say goodbye or it nears its context limit**. You don't run anything by hand.

### Manual MCP config

If you register MCP servers via a JSON config (`claude_desktop_config.json` or similar):

```json
{
  "mcpServers": {
    "zipmem-mcp": {
      "command": "npx",
      "args": ["zipmem-mcp"]
    }
  }
}
```

The server reads `CLAUDE_PROJECT_DIR` (set automatically by Claude Code) to find the project's `.zipmem/`. It otherwise falls back to the nearest `.zipmem/` ancestor of the working directory.

---

## How the loop works

```
Session start ──► agent calls zipmem_load_memory ──► regains full context (few tokens)
      │
      │   ... work ...
      │
Exit intent / context pressure ──► agent calls zipmem_save_and_compact
                                         │
                                         ▼
                          validate → dedup-merge → prune → write .zipmem/state.json
```

### MCP tools

| Tool | When the agent calls it | What it does |
| --- | --- | --- |
| **`zipmem_load_memory`** | First thing, every session | Returns blueprints, anchors, and lessons as compact text. Surfaces a recovery banner if the previous session ended abruptly. |
| **`zipmem_checkpoint`** | Periodically, after each meaningful unit of work | Stages incremental progress durably (crash-safe) without finalizing the session. |
| **`zipmem_save_and_compact`** | On "exit/quit/goodbye" or near the context limit | Folds staged checkpoints + the final delta into persistent memory and closes the session. |

The tool *descriptions* are written so the agent knows **when and why** to call them without you prompting it.

---

## Crash safety (hard exits & Ctrl+C)

Relying on the agent to gracefully call `zipmem_save_and_compact` on the way out is fragile: a closed terminal window, `Ctrl+C`, or a killed process can skip it. zipmem defends against this in layers — and is honest about the limits:

1. **Continuous checkpointing.** `zipmem_checkpoint` writes `.zipmem/session.json` atomically on every call. A hard exit therefore loses *at most the work since the last checkpoint*, and that data is already on disk — no death-handler required.
2. **Parent-process lifecycle monitor.** The server watches the `claude` process via the stdin pipe (EOF when the parent dies), `SIGINT`/`SIGTERM`/`SIGHUP`, and a PID liveness probe. On any *catchable* termination it **synchronously folds the staged checkpoints into `state.json`** and records why the session ended.
3. **Next-session recovery.** On startup the server detects a session that never closed cleanly, folds any leftover checkpoints into `state.json`, and `zipmem_load_memory` shows a **⚠️ ZipMem recovery** banner listing the git-changed files so the agent re-anchors them.

> **Honest limitation:** a true hard kill (`SIGKILL`, `kill -9`, power loss) cannot be intercepted by *any* in-process handler — and semantic compaction can't run at death time anyway, because it requires the LLM. zipmem does **not** dump raw code or `git diff` into memory (that would violate Anchored Compacting). Instead, durability comes from **checkpoints already on disk** + **next-session recovery**, which together guarantee no *silent* loss: the worst case is "the last few un-checkpointed steps need redoing," and the next session is explicitly told what changed.

The practical takeaway: **checkpoint as you go** (the injected directive tells the agent to), and abrupt exits become recoverable instead of catastrophic.

> `.zipmem/session.json` is runtime state and is always gitignored (via `.zipmem/.gitignore`), even in `--shared` mode — only `state.json` is shared.

---

## CLI

```bash
zipmem init [--shared]   # set up .zipmem/ and inject the directive
zipmem status            # summary: counts, size vs. limits, mode, timestamps
zipmem --version
zipmem --help
```

### `zipmem status`

```
ZipMem status — my-app

  Blueprints : 4
  Anchors    : 11
  Lessons    : 6
  Sessions   : 18
  Compactions: 18

  Size       : 7.4KB
  Mode       : local (gitignored)
  Created    : 2026-05-02T10:01:55.000Z
  Updated    : 2026-06-20T13:32:17.324Z
```

---

## The memory file

Everything lives in one validated JSON file at `.zipmem/state.json`:

- **`blueprints[]`** — immutable-by-default architectural facts (architecture, schema, decision, convention, dependency), preserved verbatim.
- **`anchors[]`** — `{ file_path, line_range, concept }` coordinate stand-ins for code.
- **`lessons[]`** — distilled bug fixes and gotchas, so regressions don't recur.
- **`session_log[]`** — an append-only audit trail of compactions.

**Merging** is deterministic: blueprints dedup by title+category (immutable ones are never overwritten unless explicitly superseded), overlapping anchors for a file union-merge with the newest concept winning, and duplicate lessons are skipped. Writes are **atomic** (temp file + rename) so a crash can never corrupt your memory.

**Size management:** above a 100 KB soft limit you get a nudge; above a 500 KB hard limit the next compaction auto-prunes least-valuable data first (stale anchors whose files are gone, then old session-log rows, then oldest lessons).

### Shared vs. local memory

By default memory is **local** (`.zipmem/` is gitignored) — personal to each developer, no merge conflicts.

To **share** memory with your team (commit it to git so everyone's agent inherits the same blueprints and lessons):

```bash
zipmem init --shared
```

This leaves `.gitignore` untouched so you can commit `.zipmem/state.json`.

---

## Why this saves thousands of tokens

A single 200-line code block can cost ~2,000+ tokens every time it re-enters the window. One anchor costs ~20. Multiply across a day of dense work — dozens of code blocks, debugging transcripts, repeated file reads — and a session that would re-load tens of thousands of tokens of history instead loads a few hundred tokens of structured memory. Because the compaction is semantic (not just truncation), the agent loses none of the *decisions* — only the bulk.

---

## Development

```bash
npm install
npm run build        # tsc -> dist/
npm test             # vitest
npm run test:watch
npm run lint
npm run format
```

Run a single test file:

```bash
npx vitest run tests/core/state.test.ts
npx vitest run -t "merges overlapping anchors"
```

Manual end-to-end smoke tests (build first):

```bash
npm run build
node tests/smoke-mcp.mjs /path/to/a/project   # handshake + save→load
node tests/smoke-crash.mjs                     # checkpoint → hard exit → recovery
```

---

## License

MIT — see [LICENSE](./LICENSE).
