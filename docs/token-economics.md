# ZipMem — Token Economics and Efficiency Analysis

> Purpose: to model, realistically and objectively, **how many tokens ZipMem spends at
> each stage** while working on a project, **how much it saves across session boundaries**
> in return, and how that changes across different `checkpoint_mode` settings and different
> chat lengths.
>
> Every number in this document is a **stated-assumption model** (measurement + reasonable
> estimate) and should be read with a ±30% margin of error. Source: actual sizes measured
> via `src/core/directive.ts`, `src/core/format.ts`, `src/server/tools/*.ts` plus a token model.

---

## 0. TL;DR — First, the key question: "Where does the saving happen?"

**The user's thesis is correct — I confirm it with one small correction:**

> "Our project does not save tokens within a chat; it provides memory most efficiently across
> session boundaries."

✅ **Correct.** ZipMem **does not save tokens within a single chat/session** — on the contrary
it **net *adds* a small number of tokens** (directive + tool definitions + checkpoint/save
outputs). It does not shrink a session's live context window; that is not its job. The saving
is born entirely **at the session boundary**: **when a new chat is opened**, instead of reading
files from scratch and re-deriving the architecture, it loads the **compressed memory in one
shot**.

🔧 **Correction/nuance:** Saying "no benefit within a chat at all" is not quite right. There are
two indirect in-session effects, but they are a **side effect, not the core mechanism**:
1. The directive steers the agent toward producing an **anchor** (file + line coordinate)
   instead of pasting a code block → in long sessions the window bloats a little more slowly.
2. Checkpoint discipline pushes the agent to regularly summarize "what I did" → this provides
   natural hygiene as well.

But these are not the *source* of the saving. **The core value = avoiding the cross-session
context re-acquisition cost.**

**In conclusion:**
- **Short, one-off chats** → ZipMem is a **net loss** (pure overhead). Don't use it.
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

### 1.1 Measured static sizes (real)

| Component | Measurement | Tokens (≈) | Cache? |
|---|---|---|---|
| Directive body (balanced) | 3,152 characters | **~790** | ✅ in CLAUDE.md, once per session |
| Directive (conservative) | longer | ~950 | ✅ |
| Directive (aggressive) | shorter | ~760 | ✅ |
| 3 tool definitions (name + description + JSON schema) | estimated from measurement | **~1,300/turn** | ✅ every turn, cached |

> Note: CLAUDE.md §9 says the directive is "~600–700 tokens"; the actual measurement is
> **~790 (balanced)**. It was slightly underestimated — this document uses the real value.

### 1.2 Generated (uncached) costs

| Event | Tokens (≈) | Frequency |
|---|---|---|
| `load_memory` result (read, then becomes input) | empty project ~60 · small ~400 · **mature ~1,500** · large (near 100KB) ~3,000+ | **once** per session |
| `checkpoint` output (per call) | ~250 (one-line summary + a few anchors) | **varies by mode** |
| `save_and_compact` output | ~500 | **once** at end of session |

---

## 2. Stage-by-stage token consumption (short list)

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

Checkpoint count by mode (objective estimate): aggressive ≈ 1 per ~8k tokens of work;
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

> **Reading:** This table is ZipMem's **pure in-session cost** (not saving). As shown, the ratio
> is high for small chats (30k + aggressive = 10% extra) and drops as the chat grows. This
> confirms the "extra consumption in short chats" thesis. Because the static ~2,100 tokens are
> cached, the billed impact is below these figures; the table gives the upper bound on window
> occupation.

---

## 4. Saving when a new chat is opened (the core benefit)

The crucial part. A **memory-less** agent re-reads files / re-derives the architecture to
re-acquire context in a new session. A **ZipMem** agent instead pulls the compressed memory via
`load_memory` and opens only the files it needs via anchors.

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
work" tokens are identical on both sides — the difference is in the **overhead vs.
re-acquisition** delta.

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
> choose it only in "high crash risk, can't afford loss" scenarios. **The default `balanced`
> is chosen correctly.**

---

## 6. Statistical summary (one-sentence formula for the user)

> **ZipMem costs ~1–10% *extra* tokens in a single short chat (pure overhead); but as a project
> spans multiple sessions and matures, the net saving turns positive and grows: ~6–15% at ~200k
> of accumulated work, and up to ~20–30% net token saving on ~300k+ and more mature projects.
> The saving depends less on chat length and more on how many times a new session is opened and
> how mature the project is.**

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

## 8. Improving efficiency — prompt/cost levers

### 8.1 Myth-busting first: shortening static blocks yields **small** gains
The directive (~790) and tool definitions (~1,300) are **cached** → their billed impact is
already low. Shortening them mostly reduces **window occupation**, and the real token bill only
a little. Moreover, the directive's detail is what makes **weaker models follow the protocol** —
aggressive shortening can break compliance. So: trim moderately, don't overdo it.

### 8.2 The real levers (uncached, real tokens):

1. **Checkpoint cadence (the biggest lever).** aggressive mode can eat half the saving
   (see §5.3). The `balanced` default is right; recommend `aggressive` only at high crash risk.
2. **`load_memory` output size.** As memory approaches the soft limit (100KB), restore cost
   rises. Suggestion: **lazy/staged loading** — by default return only `blueprints + lessons`,
   and `anchors` on demand. The `sections` parameter already exists; making the default a
   "summary" instead of "all" could be considered.
3. **Token budget for `load_memory`.** Placing a soft upper bound on the output (e.g. the newest
   N blueprints/anchors + "use sections for more") keeps restore constant on large projects.
4. **Checkpoint payload discipline.** Summaries must stay one line; `format.ts` is already terse
   — keep this explicit in the directive too ("running summary = one line").

### 8.3 Concrete, low-risk improvement suggestions
- [ ] **A terser directive variant for strong models** (e.g. ~790 → ~550 tokens); optional
      `--directive=lean` at `init`. Cuts window occupation by ~30%.
- [ ] **Anchor lazy-load:** `load_memory` default is blueprints+lessons; anchors a separate call.
- [ ] **`load_memory` token ceiling** + a "truncated, use sections" note.
- [ ] Update the "~600–700 tokens" figure in CLAUDE.md §9 to **~790** (accuracy).
- [ ] Shorten tool descriptions by ~15% (preserving the signal) — a window-occupation gain.

> **Caution:** None of these levers create "saving within a single chat"; they all reduce either
> window occupation or per-session overhead. The core benefit is still cross-session.

---

## 9. Conclusion

1. **The user's thesis is correct:** ZipMem does not save within a session, and **should not even
   appear to** — its value is in cross-session context restore.
2. **Short/one-off chat → don't use** (net 1–10% loss).
3. **Long, multi-session, mature project → net 6–30% saving;** the multiplier = number of
   sessions + project maturity, not chat length.
4. **The default `balanced` mode is on point.** `aggressive` only for crash-critical work;
   `conservative` is most efficient in token-frugal / long-single-session scenarios.
5. **The biggest efficiency lever = checkpoint cadence** and **`load_memory` output size**;
   static prompt shortening is secondary (mostly cached).

---

*This report is a cost model, not an exact bill. The numbers are sensitive to the stated
assumptions. For real measurement: it is recommended to validate these estimates against Claude
Code's token counters (`/cost`) over a few real sessions.*
