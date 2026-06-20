import { z } from "zod";

/**
 * The state-file contract for `.zipmem/state.json`.
 *
 * This is the single source of truth for the on-disk shape. Every other module
 * imports types from here. Timestamps are plain ISO strings (generated
 * server-side via `new Date().toISOString()`), so we validate them loosely to
 * stay portable across zod 3/4 minor API differences.
 */

export const STATE_VERSION = 1 as const;

/** Categories a blueprint can belong to. Preserved verbatim, never anchored. */
export const BlueprintCategory = z.enum([
  "architecture",
  "schema",
  "decision",
  "convention",
  "dependency",
]);
export type BlueprintCategory = z.infer<typeof BlueprintCategory>;

/**
 * A code anchor: the coordinate-only replacement for a raw code block.
 * `line_range` is a human string such as "42-67" or "42" (single line).
 */
export const AnchorSchema = z.object({
  file_path: z.string().min(1),
  line_range: z.string().min(1),
  concept: z.string().min(1),
  timestamp: z.string().min(1),
});
export type Anchor = z.infer<typeof AnchorSchema>;

/** A distilled bug resolution / gotcha that future sessions must not repeat. */
export const LessonSchema = z.object({
  id: z.string().min(1),
  summary: z.string().min(1),
  detail: z.string(),
  related_files: z.array(z.string()),
  timestamp: z.string().min(1),
});
export type Lesson = z.infer<typeof LessonSchema>;

/** An immutable-by-default architectural fact, preserved verbatim. */
export const BlueprintSchema = z.object({
  id: z.string().min(1),
  category: BlueprintCategory,
  title: z.string().min(1),
  content: z.string(),
  immutable: z.boolean().default(true),
  timestamp: z.string().min(1),
});
export type Blueprint = z.infer<typeof BlueprintSchema>;

/** One row in the append-only audit trail of compaction events. */
export const SessionRecordSchema = z.object({
  session_id: z.string().min(1),
  started_at: z.string().min(1),
  ended_at: z.string().min(1),
  summary: z.string(),
  anchors_added: z.number().int().nonnegative(),
  lessons_added: z.number().int().nonnegative(),
});
export type SessionRecord = z.infer<typeof SessionRecordSchema>;

export const StateMetaSchema = z.object({
  total_compactions: z.number().int().nonnegative(),
  total_sessions: z.number().int().nonnegative(),
  state_size_bytes: z.number().int().nonnegative(),
  /** When true, memory is intended to be committed and shared via git. */
  shared: z.boolean().default(false),
});
export type StateMeta = z.infer<typeof StateMetaSchema>;

export const StateSchema = z.object({
  version: z.literal(STATE_VERSION),
  project_name: z.string(),
  created_at: z.string().min(1),
  updated_at: z.string().min(1),
  blueprints: z.array(BlueprintSchema),
  anchors: z.array(AnchorSchema),
  lessons: z.array(LessonSchema),
  session_log: z.array(SessionRecordSchema),
  meta: StateMetaSchema,
});
export type State = z.infer<typeof StateSchema>;

/**
 * The payload an agent supplies to `zipmem_save_and_compact`. Server-generated
 * fields (id, timestamp) are intentionally absent — the compactor adds them.
 */
export const CompactionPayloadSchema = z.object({
  session_summary: z.string().min(1),
  blueprints: z
    .array(
      z.object({
        category: BlueprintCategory,
        title: z.string().min(1),
        content: z.string(),
        /** Set false to supersede an existing blueprint with the same title. */
        immutable: z.boolean().default(true),
      }),
    )
    .default([]),
  anchors: z
    .array(
      z.object({
        file_path: z.string().min(1),
        line_range: z.string().min(1),
        concept: z.string().min(1),
      }),
    )
    .default([]),
  lessons: z
    .array(
      z.object({
        summary: z.string().min(1),
        detail: z.string().default(""),
        related_files: z.array(z.string()).default([]),
      }),
    )
    .default([]),
});
export type CompactionPayload = z.infer<typeof CompactionPayloadSchema>;
