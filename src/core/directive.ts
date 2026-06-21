/**
 * The Constitutional Directive injected into a project's CLAUDE.md (or
 * memory.md) by `zipmem init`.
 *
 * This is the "brain" of zipmem: all compaction intelligence lives here, in
 * prose the active model reads on every loop — not in server code. It is wrapped
 * in stable HTML-comment markers so injection is idempotent and the block can be
 * upgraded in place by a future `zipmem init`.
 */

import type { CheckpointMode } from "./schema.js";

export const DIRECTIVE_START = "<!-- zipmem:start -->";
export const DIRECTIVE_END = "<!-- zipmem:end -->";

/** Bump when the directive body changes so `init` can detect/replace old blocks. */
export const DIRECTIVE_VERSION = 5;

/**
 * The mode-specific body of section 2 ("During the session"). Only the
 * checkpoint-cadence paragraph differs between modes; the context-pressure and
 * recovery-banner guidance is shared (see {@link sharedDuringSession}).
 */
function checkpointGuidance(mode: CheckpointMode): string {
  switch (mode) {
    case "aggressive":
      return `Call **\`zipmem_checkpoint\`** periodically — after each meaningful unit of
work (a feature wired up, a bug fixed, a decision made). Pass the same kind of
structured fields as step 3 (blueprints / anchors / lessons + a one-line running
summary). This is cheap and **crash-safe**: if the session ends abruptly (the
user hits Ctrl+C, closes the terminal, or the process is killed), checkpointed
progress is recovered automatically on the next session, whereas anything never
checkpointed or compacted is lost. Do not wait until the end to record work.`;
    case "balanced":
      return `Call **\`zipmem_checkpoint\`** only at **major milestones** — a large refactor
finished, a critical bug resolved, a foundational decision made — **not** after
every small unit of work. Pass the same kind of structured fields as step 3
(blueprints / anchors / lessons + a one-line running summary). This is cheap and
**crash-safe**: if the session ends abruptly (the user hits Ctrl+C, closes the
terminal, or the process is killed), checkpointed progress is recovered
automatically on the next session. Checkpointing only at milestones keeps token
cost low while still protecting the work that matters.`;
    case "conservative":
      return `**Do NOT call \`zipmem_checkpoint\` or \`zipmem_save_and_compact\` on your own
initiative during the session.** To save tokens, this project persists memory
only on explicit user request.

This rule is critical — honor these two plain-word commands the instant the user
gives them, with **no extra commentary**, then reply with a single-line
confirmation:
- The user says **"checkpoint"** (or "take a checkpoint") → IMMEDIATELY call
  **\`zipmem_checkpoint\`** to stage progress (crash-safe, not final), then
  confirm in one line (e.g. "✓ Checkpoint saved.").
- The user says **"save"** (or "save memory", "save and compact") → IMMEDIATELY
  call **\`zipmem_save_and_compact\`** with the full structured payload from
  step 3 (session_summary + blueprints / anchors / lessons), then confirm in one
  line (e.g. "✓ Memory saved & compacted.").

Do not deliberate or ask for confirmation first; just run the matching tool and
acknowledge in a single line.`;
  }
}

function buildDirectiveBody(mode: CheckpointMode): string {
  return `## ZipMem — Session Memory Protocol (v${DIRECTIVE_VERSION})

> This project uses **ZipMem** for endless, low-token long-term memory. These
> instructions are binding regardless of your model version. Follow them exactly.
> Checkpoint mode for this project: **${mode}**.

### 1. On session start — ALWAYS load memory
Before doing anything else, call the **\`zipmem_load_memory\`** tool. It returns
the project's architectural blueprints, file-coordinate anchors, and lessons
from previous sessions. Do not ask the user whether to load memory — always load
it. Treat anchors as coordinates: if you need the code behind one, read the file
at the given line range on demand.

### 2. During the session — checkpoint as you go
${checkpointGuidance(mode)}

Also stay aware of context-window pressure (many large code blocks, repeated
file reads, long debugging transcripts); when it builds, compact (step 3).

If a session begins with a **⚠️ ZipMem recovery** banner, the previous session
ended abruptly: review the listed uncompacted files, capture any missing
anchors/lessons, and compact (step 3) to reconcile.

### 3. Before ending OR when near the context limit — save & compact
When the user signals they are done (e.g. "exit", "quit", "goodbye", "that's
all", "wrap up") **or** you judge the context window is nearing capacity, call
**\`zipmem_save_and_compact\`** with a structured payload built from these rules:

**\`session_summary\`** — one paragraph: what was accomplished this session.

**\`blueprints\`** — Preserve VERBATIM any new or changed high-level facts:
architecture/topology, database schemas, API contracts, foundational decisions,
conventions, dependency choices. Use \`category\` ∈
\`architecture | schema | decision | convention | dependency\`. These are the
immutable core — never compress or paraphrase them away. To revise an existing
blueprint, resend it with the same \`title\` and \`immutable: false\`.

**\`anchors\`** — NEVER store raw code in memory. For every significant code
change, emit a coordinate anchor instead:
\`{ "file_path": "...", "line_range": "42-67", "concept": "<exact structural change>" }\`
Describe the *structural concept* (what the code does / why it changed) in a
single sentence, not the code itself. Future sessions expand anchors by reading
the file on demand.

**\`lessons\`** — Distill multi-step bug hunts and gotchas into durable lessons:
\`{ "summary": "<one line>", "detail": "<root cause + fix>", "related_files": [...] }\`
Capture what a future session must know to avoid repeating the mistake.

**Be terse — every checkpoint and compaction is generated output you pay for per
token.** Keep each \`concept\` and \`summary\` to a single line, \`detail\` to one or
two sentences, and only send \`blueprints\` whose facts are genuinely new or
changed — never restate unchanged ones. Density, not volume: the memory must
stay small for the next session to reload it cheaply.

### 4. Compression philosophy — what to keep vs. discard
- **KEEP (verbatim → blueprints):** architecture, schemas, API contracts,
  security/performance/dependency decisions, integration patterns.
- **KEEP (distilled → lessons):** bug root causes and their fixes.
- **KEEP (coordinates → anchors):** every meaningful code change.
- **DISCARD:** raw code blocks, exploratory dead-ends, verbose error logs,
  contents of files merely read but not changed, repeated clarifications,
  conversational pleasantries, and tool-output noise.

The goal: an endless semantic memory loop where the window stays small but no
foundational knowledge is ever lost.`;
}

/**
 * Build the full directive block (including the idempotency markers) for a given
 * checkpoint mode, exactly as written to disk. Only section 2's cadence varies.
 */
export function getDirective(mode: CheckpointMode): string {
  return `${DIRECTIVE_START}
${buildDirectiveBody(mode)}
${DIRECTIVE_END}`;
}
