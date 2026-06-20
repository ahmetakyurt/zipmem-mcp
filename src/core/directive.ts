/**
 * The Constitutional Directive injected into a project's CLAUDE.md (or
 * memory.md) by `zipmem init`.
 *
 * This is the "brain" of zipmem: all compaction intelligence lives here, in
 * prose the active model reads on every loop — not in server code. It is wrapped
 * in stable HTML-comment markers so injection is idempotent and the block can be
 * upgraded in place by a future `zipmem init`.
 */

export const DIRECTIVE_START = "<!-- zipmem:start -->";
export const DIRECTIVE_END = "<!-- zipmem:end -->";

/** Bump when the directive body changes so `init` can detect/replace old blocks. */
export const DIRECTIVE_VERSION = 1;

const DIRECTIVE_BODY = `## ZipMem — Session Memory Protocol (v${DIRECTIVE_VERSION})

> This project uses **ZipMem** for endless, low-token long-term memory. These
> instructions are binding regardless of your model version. Follow them exactly.

### 1. On session start — ALWAYS load memory
Before doing anything else, call the **\`zipmem_load_memory\`** tool. It returns
the project's architectural blueprints, file-coordinate anchors, and lessons
from previous sessions. Do not ask the user whether to load memory — always load
it. Treat anchors as coordinates: if you need the code behind one, read the file
at the given line range on demand.

### 2. During the session — watch context pressure
Stay aware of how full your context window is getting. Heavy signs: many large
code blocks pasted in, the same files read repeatedly, long debugging
transcripts. When pressure builds, proactively compact (step 3) rather than
waiting to be told.

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
Describe the *structural concept* (what the code does / why it changed), not the
code itself. Future sessions expand anchors by reading the file on demand.

**\`lessons\`** — Distill multi-step bug hunts and gotchas into durable lessons:
\`{ "summary": "<one line>", "detail": "<root cause + fix>", "related_files": [...] }\`
Capture what a future session must know to avoid repeating the mistake.

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

/** The full block, including idempotency markers, exactly as written to disk. */
export const CONSTITUTIONAL_DIRECTIVE = `${DIRECTIVE_START}
${DIRECTIVE_BODY}
${DIRECTIVE_END}`;
