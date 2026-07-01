# ZipMem — Token Economics and Efficiency Analysis

> **What this document is:** a realistic, stated-assumption model of *where* ZipMem spends
> tokens, *where* it saves them, and how that changes with `checkpoint_mode` and chat length.
> It exists to set honest expectations — ZipMem is not a universal win, and this page explains
> exactly when it pays off and when it doesn't.
>
> **These numbers are estimates and will change.** Every figure below is a model (measurement +
> reasonable assumption), not a billed invoice, and should be read with a ±30% margin. They
> depend on the tokenizer, the active model, prompt-cache behavior, and the current
> implementation of `src/core/directive.ts`, `src/core/format.ts`, and `src/server/tools/*.ts`.
> As those evolve, the numbers here will drift; treat the *shape* of the argument as the durable
> part, not the exact values. To measure your own case, compare against Claude Code's token
> counters (`/cost`) over a few real sessions.

---

## 0. TL;DR — Where does the saving actually happen?

**ZipMem does not save tokens within a single chat.** On the contrary, within one session it
**net *adds* a small number of tokens** (the directive + tool definitions + checkpoint/save
outputs). It does not shrink a session's live context window — that is not its job.

**The saving is realized at the session boundary.** When a *new* chat is opened, instead of
re-reading files from scratch and re-deriving the architecture, the agent loads the compressed
memory in one shot via `zipmem_load_memory`.

There are two *indirect* in-session effects, but they are a side effect, not the core mechanism:

1. The directive steers the agent toward emitting an **anchor** (file + line coordinate) instead
   of pasting a raw code block, so in long sessions the window bloats a little more slowly.
2. Checkpoint discipline nudges the agent to periodically summarize "what I did", which is a
   natural hygiene benefit.

Neither is the *source* of the saving. **The core value is avoiding cross-session context
re-acquisition cost.**

**Bottom line:**
- **Short, one-off chats** → net loss (pure overhead). Don't use ZipMem for these.
- **Long and/or multi-session projects** → net positive; the saving percentage grows as the
  project matures.

---

## 1. Assumptions (the basis of the calculation)

| Assumption | Value | Note |
|---|---|---|
| Token ≈ character ratio | 1 token ≈ 4 characters | Standard approximation for English/code |
| Prompt caching | Active (Claude Code uses it) | Static blocks are written once, then read at ~10% cost |
| Static block = "window cost" | Cached, **billed cost low** | But occupies window space; reported separately |
| Generated tokens | **Never cached** | This is the real incremental cost |
| "Memory-less re-acquisition" | The most uncertain variable | A range is given; the midpoint is used |

### 1.1 Measured static sizes

| Component | Measurement | Tokens (≈) | Cached? |
|---|---|---|---|
| Directive body (balanced) | ~3,150 characters | **~790** | ✅ in CLAUDE.md, once per session |
| Directive (conservative) | longer | ~950 | ✅ |
| Directive (aggressive) | shorter | ~760 | ✅ |
| 3 tool definitions (name + description + JSON schema) | estimated from measurement | **~1,300/turn** | ✅ every turn, cached |

### 1.2 Generated (uncached) costs

| Event | Tokens (≈) | Frequency |
|---|---|---|
| `load_memory` result (read, then becomes input) | empty project ~60 · small ~400 · **mature ~1,500** · large (near 100KB) ~3,000+ | **once** per session |
| `checkpoint` output (per call) | ~250 (one-line summary + a few anchors) | **varies by mode** |
| `save_and_compact` output | ~500 | **once** at end of session |

---

## 2. Stage-by-stage token consumption

Every stage ZipMem touches in a single session:

| # | Stage | Type | Tokens (≈) | Description |
|---|---|---|---|---|
| 1 | Directive (CLAUDE.md) is loaded | Static/cached | ~790 | Stays fixed in the window throughout the session |
| 2 | 3 tool definitions appear every turn | Static/cached | ~1,300/turn | Cached → low billed cost |
| 3 | `zipmem_load_memory` call + result | Generated + input | ~1,500 (mature project) | Session start, **once** |
| 4 | `zipmem_checkpoint` (during work) | Generated | ~250 × N | N depends on mode + length |
| 5 | `zipmem_save_and_compact` (at close) | Generated | ~500 | **once** |
| 6 | Death/crash moment (recovery) | **0** | 0 | LLM does not run; only a file marker |

**Summary:** Static window occupation ≈ **~2,100 tokens** (cached, small billed impact).
The real incremental cost = `load (1,500)` + `N × checkpoint (250)` + `save (500)`.

---

## 3. Cost by chat length (mode × length)

Checkpoint count by mode (modeled estimate): aggressive ≈ 1 per ~8k tokens of work;
balanced ≈ 1 per ~33k (milestones only); conservative ≈ only when the user says
"checkpoint"/"save".

| Chat peak | aggressive (ckpt) | balanced (ckpt) | conservative (ckpt) |
|---|---|---|---|
| 30k | 4 | 1 | 0–1 |
| 100k | 12 | 3 | 1 |
| 200k | 24 | 6 | 2 |
| 300k | 36 | 9 | 3 |

### 3.1 Tokens ADDED by ZipMem (mature project: load≈1,500, ckpt≈250, save≈500)

| Chat peak | aggressive | balanced | conservative |
|---|---|---|---|
| 30k | 3,000 | 2,250 | 2,000 |
| 100k | 5,000 | 2,750 | 2,250 |
| 200k | 8,000 | 3,500 | 2,500 |
| 300k | 11,000 | 4,250 | 2,750 |

### 3.2 The same cost as a ratio of chat size (= "in-session overhead %")

| Chat peak | aggressive | balanced | conservative |
|---|---|---|---|
| 30k | **10.0%** | 7.5% | 6.7% |
| 100k | 5.0% | 2.8% | 2.3% |
| 200k | 4.0% | 1.8% | 1.3% |
| 300k | 3.7% | 1.4% | **0.9%** |

> **Reading:** This table is ZipMem's **pure in-session cost** (not saving). The ratio is high
> for small chats (30k + aggressive = 10% extra) and drops as the chat grows. This is the
> "extra consumption in short chats" effect. Because the static ~2,100 tokens are cached, the
> billed impact is below these figures; the table gives the upper bound on window occupation.

---

## 4. Saving when a new chat is opened (the core benefit)

A **memory-less** agent re-reads files and re-derives the architecture to re-acquire context in
a new session. A **ZipMem** agent instead pulls the compressed memory via `load_memory` and
opens only the files it needs via anchors.

Re-acquisition cost correlates with project maturity (≈ accumulated work):

| Project accumulation | Memory-less (re-acq, range) | mid | ZipMem restore | **Saving / new session** |
|---|---|---|---|---|
| ~30k | 3,000–6,000 | 4,500 | ~2,500 | **~2,000** |
| ~100k | 8,000–15,000 | 11,000 | ~4,000 | **~7,000** |
| ~200k | 15,000–28,000 | 20,000 | ~5,500 | **~14,500** |
| ~300k | 22,000–40,000 | 30,000 | ~7,000 | **~23,000** |

> ZipMem restore = `load_memory (~1,500)` + a few on-demand file reads (~2,000–5,500).
> On the memory-less side the agent typically re-reads 2–3× more files "just in case".

**Key point:** The saving grows not with the chat peak but with **accumulated project
knowledge**. The more mature the project, the more expensive it is to build context from
scratch → the more ZipMem saves.

---

## 5. Cumulative (multi-session) comparison: with vs. without

Realistic scenario: a project spans multiple sessions. Say each session does ~40k tokens of
productive work; the project reaches ~200k of productive work over 5 sessions. "Productive
work" tokens are identical on both sides — the difference is the **overhead vs. re-acquisition**
delta.

### 5.1 balanced mode, 5-session project (~200k productive work)

| Item | Memory-less (baseline) | ZipMem (balanced) |
|---|---|---|
| Productive work (5 × 40k) | 200,000 | 200,000 |
| Session 1 restore | 0 (new) | +2,250 (overhead) |
| Sessions 2–5 context acquisition | +4 × ~11,000 = **+44,000** | +4 × ~4,000 = **+16,000** |
| Sessions 2–5 ZipMem overhead | — | +4 × ~2,750 = +11,000 |
| **TOTAL** | **~244,000** | **~229,250** |
| **Net saving** | — | **~14,750 tokens (6.0%)** |

### 5.2 Larger/more mature project (per-session re-acq ~20k, 5 sessions)

| Item | Memory-less | ZipMem (balanced) |
|---|---|---|
| Productive work | 200,000 | 200,000 |
| Context acquisition (sessions 2–5) | +4 × 20,000 = **+80,000** | +4 × 5,500 = **+22,000** |
| ZipMem overhead (5 sessions) | — | +5 × 3,500 = +17,500 |
| **TOTAL** | **~280,000** | **~239,500** |
| **Net saving** | — | **~40,500 tokens (14.5%)** |

### 5.3 Mode comparison (scenario 5.2, mature project)

| Mode | ZipMem overhead (5 sess.) | Total | Net saving |
|---|---|---|---|
| conservative | ~12,500 | ~234,500 | **16.3%** |
| balanced | ~17,500 | ~239,500 | **14.5%** |
| aggressive | ~40,000 | ~262,000 | **6.4%** |

> **Interpretation:** In a multi-session mature project, **conservative and balanced** are by
> far the most efficient. **aggressive** mode's extra checkpoints eat about half the saving —
> choose it only when crash risk is high and losing recent work is unacceptable. This is why the
> default is `balanced`.

---

## 6. Summary formula

> **ZipMem costs ~1–10% *extra* tokens in a single short chat (pure overhead); but as a project
> spans multiple sessions and matures, the net saving turns positive and grows: ~6–15% at ~200k
> of accumulated work, and up to ~20–30% on ~300k+ and more mature projects. The saving depends
> less on chat length and more on how many times a new session is opened and how mature the
> project is.**

Net saving band, as a short table:

| Accumulated work volume / maturity | Net saving band (balanced) |
|---|---|
| < ~30k, single session | **Negative** (~−5% to −10%; don't use) |
| ~100k, 2–3 sessions | ~3% – 8% |
| ~200k, 4–5 sessions | ~6% – 15% |
| ~300k+, mature, multi-session | ~15% – 30% |

> The 20–30% upper band appears only when **mature project + frequent new sessions + disciplined
> checkpointing** all occur together. A "300k-token chat" alone does not automatically yield
> 30%; the real multiplier is **number of sessions + work avoided in re-acquisition**.

---

## 7. Comparison with other memory approaches

| Approach | Persists across sessions | Token cost | Infra/keys | Determinism | Weakness |
|---|---|---|---|---|---|
| **Memory-less (re-read each session)** | ❌ | Highest (over time) | None | — | Context rebuilt from zero each time |
| **Paste old transcript** | ⚠️ manual | **Very high** | None | Low | Bloats the window; defeats the purpose |
| **Manual CLAUDE.md notes** | ✅ but static | Very low | None | Medium | Hand-maintained, goes stale, no anchors, lossy |
| **Claude Code `/compact`** | ❌ (within session) | Low | None | Medium | Only shrinks the live window, **not persistent**, lossy |
| **RAG / vector memory (mem0, Letta/MemGPT)** | ✅ | Medium (retrieval per query) | **Embeddings + DB/keys required** | Low (fuzzy) | Can retrieve noise, infra overhead, non-deterministic |
| **Whole context window (ingest everything)** | ❌ | Highest | None | High | Expensive, window-bound |
| **ZipMem** | ✅ | **Low** (fixed, mostly cached) | **None** (local, key-free) | **High** (deterministic) | One project, no concurrency, discipline-dependent, no fuzzy semantic search |

**ZipMem's positioning:** **complementary to, not a competitor of** `/compact` (`/compact` =
in-session window; ZipMem = cross-session meaning). Versus RAG memories it offers **zero infra +
deterministic + code anchors + verbatim blueprints**; in exchange it gives up **fuzzy semantic
retrieval breadth** and multi-project scope. Versus manual CLAUDE.md it's automatic, structured,
and anchor-based; versus pasting transcripts it's incomparably cheaper.

---

## 8. Improving efficiency — cost levers

### 8.1 Shortening static blocks yields *small* gains
The directive (~790) and tool definitions (~1,300) are **cached**, so their billed impact is
already low. Shortening them mostly reduces **window occupation**, not the real token bill.
Moreover, the directive's detail is part of what makes **weaker models follow the protocol**, so
aggressive shortening can hurt compliance. Trim moderately, not aggressively.

### 8.2 The real levers (uncached, real tokens)

1. **Checkpoint cadence (the biggest lever).** aggressive mode can eat half the saving
   (see §5.3). The `balanced` default is the general recommendation; `aggressive` fits high
   crash-risk work only.
2. **`load_memory` output size.** As memory approaches the soft limit (100KB), restore cost
   rises. Lazy/staged loading (return `blueprints + lessons` by default, `anchors` on demand)
   keeps restore cheap on large projects. The `sections` parameter already supports selective
   loading.
3. **Token budget for `load_memory`.** A soft upper bound on the output (e.g. the newest N
   blueprints/anchors + "use `sections` for more") keeps restore roughly constant on large
   projects.
4. **Checkpoint payload discipline.** Summaries should stay one line; the directive already
   instructs terseness, and keeping running summaries to a single line matters most here.

### 8.3 Possible future optimizations

These are directions, not commitments — noted here so the reasoning is on the record:

- A terser directive variant for strong models (e.g. ~790 → ~550 tokens), opt-in at `init`;
  reduces window occupation without changing behavior for capable models.
- Anchor lazy-load: make `load_memory` default to blueprints+lessons, with anchors as a
  separate request.
- A `load_memory` token ceiling with a "truncated, use `sections`" note.
- Trimming tool descriptions while preserving their self-signaling intent.

> **Caution:** None of these create "saving within a single chat"; they all reduce either window
> occupation or per-session overhead. The core benefit remains cross-session.

---

## 9. Conclusion

1. **ZipMem does not save within a session**, and should not appear to — its value is in
   cross-session context restore.
2. **Short/one-off chat → don't use** (net 1–10% loss).
3. **Long, multi-session, mature project → net 6–30% saving;** the multiplier is number of
   sessions + project maturity, not chat length.
4. **The default `balanced` mode is a sensible choice.** `aggressive` suits crash-critical work;
   `conservative` is most efficient in token-frugal / long-single-session scenarios.
5. **The biggest efficiency levers are checkpoint cadence and `load_memory` output size;**
   static prompt shortening is secondary (mostly cached).

---

*This report is a cost model, not an exact bill. The numbers are sensitive to the stated
assumptions and will change as the tokenizer, model, and implementation evolve. To validate for
your own workload, compare against Claude Code's token counters (`/cost`) over a few real
sessions.*
