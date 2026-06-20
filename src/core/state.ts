import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  buildLesson,
  isDuplicateLesson,
  mergeAnchor,
  normalizeIncomingAnchors,
  randomUUID,
} from "./compactor.js";
import {
  type Blueprint,
  type CompactionPayload,
  type SessionRecord,
  type State,
  StateSchema,
  STATE_VERSION,
} from "./schema.js";
import { resolveStatePath, resolveZipmemDir } from "../utils/paths.js";

/** Soft limit: a warning is surfaced to the agent on load above this size. */
export const SOFT_LIMIT_BYTES = 100 * 1024;
/** Hard limit: save triggers automatic pruning above this size. */
export const HARD_LIMIT_BYTES = 500 * 1024;
/** Age (ms) beyond which anchors/sessions become prune candidates. */
export const PRUNE_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export interface MergeStats {
  blueprintsAdded: number;
  anchorsAdded: number;
  lessonsAdded: number;
  blueprintsTotal: number;
  anchorsTotal: number;
  lessonsTotal: number;
  pruned: boolean;
}

/** A fresh, schema-valid empty state for a brand-new project. */
export function createEmptyState(projectName: string, shared = false): State {
  const now = new Date().toISOString();
  return {
    version: STATE_VERSION,
    project_name: projectName,
    created_at: now,
    updated_at: now,
    blueprints: [],
    anchors: [],
    lessons: [],
    session_log: [],
    meta: {
      total_compactions: 0,
      total_sessions: 0,
      state_size_bytes: 0,
      shared,
    },
  };
}

export function stateExists(projectDir: string): boolean {
  return existsSync(resolveStatePath(projectDir));
}

/**
 * Read and validate `.zipmem/state.json`. Returns a fresh empty state when the
 * file is missing so callers never special-case first run. Throws (with a clear
 * message) only when the file exists but is corrupt/invalid.
 */
export async function loadState(
  projectDir: string,
  fallbackProjectName?: string,
): Promise<State> {
  const statePath = resolveStatePath(projectDir);
  if (!existsSync(statePath)) {
    return createEmptyState(
      fallbackProjectName ?? path.basename(path.resolve(projectDir)),
    );
  }

  let raw: string;
  try {
    raw = await readFile(statePath, "utf8");
  } catch (err) {
    throw new Error(
      `zipmem: failed to read ${statePath}: ${(err as Error).message}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `zipmem: ${statePath} is not valid JSON. Fix or delete it and re-run \`zipmem init\`.`,
    );
  }

  const result = StateSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `zipmem: ${statePath} does not match the expected schema. ${result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    );
  }
  return result.data;
}

/**
 * Atomically persist state: validate, write to a temp file, then rename. The
 * rename is atomic on the same filesystem, so a crash mid-write can never leave
 * a half-written `state.json`.
 */
export async function saveState(
  projectDir: string,
  state: State,
): Promise<void> {
  const validated = StateSchema.parse(state);
  const serialized = `${JSON.stringify(validated, null, 2)}\n`;

  validated.meta.state_size_bytes = Buffer.byteLength(serialized, "utf8");
  const finalSerialized = `${JSON.stringify(validated, null, 2)}\n`;

  const dir = resolveZipmemDir(projectDir);
  await mkdir(dir, { recursive: true });

  const statePath = resolveStatePath(projectDir);
  const tmpPath = `${statePath}.${randomUUID()}.tmp`;
  await writeFile(tmpPath, finalSerialized, "utf8");
  await rename(tmpPath, statePath);
}

/**
 * Merge an agent's compaction payload into existing state, applying the
 * deduplication rules:
 *  - blueprints: dedup by category+title; immutable existing kept verbatim;
 *    immutable:false supersedes a same-title blueprint.
 *  - anchors: dedup by file_path + overlapping line_range (newer wins, ranges
 *    union-merged).
 *  - lessons: appended, skipping summary-substring duplicates.
 *  - session_log: always appended (audit trail).
 */
export function mergeState(
  existing: State,
  payload: CompactionPayload,
  now: string = new Date().toISOString(),
): { state: State; stats: MergeStats } {
  const blueprints = [...existing.blueprints];
  let blueprintsAdded = 0;

  for (const incoming of payload.blueprints) {
    const idx = blueprints.findIndex(
      (b) => b.category === incoming.category && b.title === incoming.title,
    );
    if (idx === -1) {
      blueprints.push({
        id: randomUUID(),
        category: incoming.category,
        title: incoming.title.trim(),
        content: incoming.content,
        immutable: incoming.immutable,
        timestamp: now,
      });
      blueprintsAdded += 1;
    } else if (!blueprints[idx]!.immutable || incoming.immutable === false) {
      // Existing is mutable, or the agent explicitly supersedes it.
      const superseded: Blueprint = {
        ...blueprints[idx]!,
        content: incoming.content,
        immutable: incoming.immutable,
        timestamp: now,
      };
      blueprints[idx] = superseded;
    }
    // else: immutable existing blueprint — kept verbatim, incoming ignored.
  }

  let anchors = [...existing.anchors];
  const normalizedAnchors = normalizeIncomingAnchors(payload.anchors, now);
  for (const a of normalizedAnchors) {
    anchors = mergeAnchor(anchors, a);
  }
  const anchorsAdded = anchors.length - existing.anchors.length;

  const lessons = [...existing.lessons];
  let lessonsAdded = 0;
  for (const incoming of payload.lessons) {
    const lesson = buildLesson(incoming, now);
    if (!isDuplicateLesson(lessons, lesson)) {
      lessons.push(lesson);
      lessonsAdded += 1;
    }
  }

  const session: SessionRecord = {
    session_id: randomUUID(),
    started_at: existing.updated_at,
    ended_at: now,
    summary: payload.session_summary.trim(),
    anchors_added: Math.max(0, anchorsAdded),
    lessons_added: lessonsAdded,
  };

  const state: State = {
    ...existing,
    updated_at: now,
    blueprints,
    anchors,
    lessons,
    session_log: [...existing.session_log, session],
    meta: {
      ...existing.meta,
      total_compactions: existing.meta.total_compactions + 1,
      total_sessions: existing.meta.total_sessions + 1,
    },
  };

  return {
    state,
    stats: {
      blueprintsAdded,
      anchorsAdded: Math.max(0, anchorsAdded),
      lessonsAdded,
      blueprintsTotal: blueprints.length,
      anchorsTotal: anchors.length,
      lessonsTotal: lessons.length,
      pruned: false,
    },
  };
}

function estimateSize(state: State): number {
  return Buffer.byteLength(`${JSON.stringify(state, null, 2)}\n`, "utf8");
}

/**
 * Reduce state below the hard limit when needed, least-valuable first:
 *  1. Drop anchors older than 30 days whose target file no longer exists.
 *  2. Collapse session_log entries older than 30 days into one summary row.
 *  3. As a last resort, drop the oldest non-immutable lessons.
 * Returns the (possibly identical) state and whether anything was pruned.
 */
export function pruneState(
  state: State,
  projectDir: string,
  now: number = Date.now(),
): { state: State; pruned: boolean } {
  if (estimateSize(state) <= HARD_LIMIT_BYTES) {
    return { state, pruned: false };
  }

  let working: State = { ...state };
  let pruned = false;

  // 1. Stale anchors whose files are gone.
  const survivingAnchors = working.anchors.filter((a) => {
    const age = now - Date.parse(a.timestamp);
    if (age <= PRUNE_AGE_MS) return true;
    const abs = path.isAbsolute(a.file_path)
      ? a.file_path
      : path.join(projectDir, a.file_path);
    return existsSync(abs);
  });
  if (survivingAnchors.length !== working.anchors.length) {
    working = { ...working, anchors: survivingAnchors };
    pruned = true;
  }

  // 2. Collapse old session log.
  if (estimateSize(working) > HARD_LIMIT_BYTES) {
    const old = working.session_log.filter(
      (s) => now - Date.parse(s.ended_at) > PRUNE_AGE_MS,
    );
    const recent = working.session_log.filter(
      (s) => now - Date.parse(s.ended_at) <= PRUNE_AGE_MS,
    );
    if (old.length > 1) {
      const collapsed: SessionRecord = {
        session_id: randomUUID(),
        started_at: old[0]!.started_at,
        ended_at: old[old.length - 1]!.ended_at,
        summary: `[collapsed ${old.length} sessions] ${old
          .map((s) => s.summary)
          .filter(Boolean)
          .slice(0, 5)
          .join(" | ")}`,
        anchors_added: old.reduce((n, s) => n + s.anchors_added, 0),
        lessons_added: old.reduce((n, s) => n + s.lessons_added, 0),
      };
      working = { ...working, session_log: [collapsed, ...recent] };
      pruned = true;
    }
  }

  // 3. Drop oldest non-immutable lessons until under the limit.
  if (estimateSize(working) > HARD_LIMIT_BYTES) {
    const lessons = [...working.lessons];
    while (estimateSize(working) > HARD_LIMIT_BYTES && lessons.length > 0) {
      lessons.shift();
      working = { ...working, lessons: [...lessons] };
      pruned = true;
    }
  }

  return { state: working, pruned };
}
