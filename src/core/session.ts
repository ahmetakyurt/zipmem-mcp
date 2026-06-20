import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { mergeState, type MergeStats } from "./state.js";
import type { CompactionPayload, State } from "./schema.js";
import { resolveZipmemDir } from "../utils/paths.js";

/**
 * Session lifecycle + crash-recovery layer.
 *
 * The `.zipmem/session.json` file tracks the *current* live session and a
 * `pending` buffer of incremental checkpoints the agent has staged but not yet
 * finalized into `state.json`. It is the durability bridge across abrupt exits:
 * because every checkpoint writes it atomically, a hard kill loses at most the
 * work since the last checkpoint — and the next session folds the leftover
 * pending data back into `state.json`.
 */

export const SESSION_FILE = "session.json";
export const SESSION_VERSION = 1 as const;

/** Accumulated, not-yet-finalized deltas. Mirrors CompactionPayload loosely. */
export interface PendingPayload {
  session_summary: string;
  blueprints: Array<{
    category: CompactionPayload["blueprints"][number]["category"];
    title: string;
    content: string;
    immutable: boolean;
  }>;
  anchors: Array<{ file_path: string; line_range: string; concept: string }>;
  lessons: Array<{ summary: string; detail: string; related_files: string[] }>;
}

export interface RecoveryInfo {
  from_session: string;
  reason: string;
  recovered_blueprints: number;
  recovered_anchors: number;
  recovered_lessons: number;
  uncompacted_files: string[];
  acknowledged: boolean;
}

export type SessionStatus = "active" | "closed" | "interrupted";

export interface SessionFile {
  version: typeof SESSION_VERSION;
  session_id: string;
  status: SessionStatus;
  pid: number;
  ppid: number;
  started_at: string;
  updated_at: string;
  reason?: string;
  uncompacted_files?: string[];
  pending: PendingPayload;
  recovery?: RecoveryInfo;
}

const PendingSchema = z.object({
  session_summary: z.string().default(""),
  blueprints: z
    .array(
      z.object({
        category: z.enum([
          "architecture",
          "schema",
          "decision",
          "convention",
          "dependency",
        ]),
        title: z.string(),
        content: z.string(),
        immutable: z.boolean().default(true),
      }),
    )
    .default([]),
  anchors: z
    .array(
      z.object({
        file_path: z.string(),
        line_range: z.string(),
        concept: z.string(),
      }),
    )
    .default([]),
  lessons: z
    .array(
      z.object({
        summary: z.string(),
        detail: z.string().default(""),
        related_files: z.array(z.string()).default([]),
      }),
    )
    .default([]),
});

const RecoverySchema = z.object({
  from_session: z.string(),
  reason: z.string(),
  recovered_blueprints: z.number().int().nonnegative().default(0),
  recovered_anchors: z.number().int().nonnegative().default(0),
  recovered_lessons: z.number().int().nonnegative().default(0),
  uncompacted_files: z.array(z.string()).default([]),
  acknowledged: z.boolean().default(false),
});

const SessionFileSchema = z.object({
  version: z.literal(SESSION_VERSION),
  session_id: z.string(),
  status: z.enum(["active", "closed", "interrupted"]),
  pid: z.number(),
  ppid: z.number(),
  started_at: z.string(),
  updated_at: z.string(),
  reason: z.string().optional(),
  uncompacted_files: z.array(z.string()).optional(),
  pending: PendingSchema,
  recovery: RecoverySchema.optional(),
});

export function resolveSessionPath(projectDir: string): string {
  return path.join(resolveZipmemDir(projectDir), SESSION_FILE);
}

export function emptyPending(): PendingPayload {
  return { session_summary: "", blueprints: [], anchors: [], lessons: [] };
}

export function pendingHasContent(p: PendingPayload): boolean {
  return (
    p.blueprints.length > 0 ||
    p.anchors.length > 0 ||
    p.lessons.length > 0 ||
    p.session_summary.trim().length > 0
  );
}

export function newActiveSession(recovery?: RecoveryInfo): SessionFile {
  const now = new Date().toISOString();
  return {
    version: SESSION_VERSION,
    session_id: randomUUID(),
    status: "active",
    pid: process.pid,
    ppid: process.ppid,
    started_at: now,
    updated_at: now,
    pending: emptyPending(),
    ...(recovery ? { recovery } : {}),
  };
}

/**
 * Fold an incoming checkpoint into the running pending buffer, deduplicating:
 * anchors by file_path+line_range, lessons by case-insensitive summary,
 * blueprints by category+title (latest content wins). A non-empty incoming
 * summary replaces the running one.
 */
export function accumulatePending(
  prev: PendingPayload,
  incoming: Partial<PendingPayload>,
): PendingPayload {
  const next: PendingPayload = {
    session_summary: prev.session_summary,
    blueprints: [...prev.blueprints],
    anchors: [...prev.anchors],
    lessons: [...prev.lessons],
  };

  if (incoming.session_summary && incoming.session_summary.trim()) {
    next.session_summary = incoming.session_summary.trim();
  }

  for (const b of incoming.blueprints ?? []) {
    const idx = next.blueprints.findIndex(
      (x) => x.category === b.category && x.title === b.title,
    );
    const entry = { ...b, immutable: b.immutable ?? true };
    if (idx === -1) next.blueprints.push(entry);
    else next.blueprints[idx] = entry;
  }

  for (const a of incoming.anchors ?? []) {
    const key = `${a.file_path}|${a.line_range}`;
    const idx = next.anchors.findIndex(
      (x) => `${x.file_path}|${x.line_range}` === key,
    );
    if (idx === -1) next.anchors.push(a);
    else next.anchors[idx] = a;
  }

  for (const l of incoming.lessons ?? []) {
    const key = l.summary.trim().toLowerCase();
    const exists = next.lessons.some(
      (x) => x.summary.trim().toLowerCase() === key,
    );
    if (!exists) {
      next.lessons.push({
        summary: l.summary,
        detail: l.detail ?? "",
        related_files: l.related_files ?? [],
      });
    }
  }

  return next;
}

/** Turn a pending buffer (+ optional final payload) into one CompactionPayload. */
export function pendingToPayload(
  pending: PendingPayload,
  fallbackSummary: string,
): CompactionPayload {
  const summary =
    pending.session_summary.trim() || fallbackSummary.trim() || "(interrupted session)";
  return {
    session_summary: summary,
    blueprints: pending.blueprints,
    anchors: pending.anchors,
    lessons: pending.lessons,
  };
}

/**
 * Merge a pending buffer into state via the canonical {@link mergeState}.
 * Returns the new state plus merge stats. No-op (pruned-free) when empty.
 */
export function applyPendingToState(
  state: State,
  pending: PendingPayload,
  fallbackSummary: string,
  now: string = new Date().toISOString(),
): { state: State; stats: MergeStats } {
  return mergeState(state, pendingToPayload(pending, fallbackSummary), now);
}

/* ------------------------------- file I/O -------------------------------- */

function parse(raw: string): SessionFile | null {
  try {
    const result = SessionFileSchema.safeParse(JSON.parse(raw));
    return result.success ? (result.data as SessionFile) : null;
  } catch {
    return null;
  }
}

export async function readSession(
  projectDir: string,
): Promise<SessionFile | null> {
  const p = resolveSessionPath(projectDir);
  if (!existsSync(p)) return null;
  try {
    return parse(await readFile(p, "utf8"));
  } catch {
    return null;
  }
}

export function readSessionSync(projectDir: string): SessionFile | null {
  const p = resolveSessionPath(projectDir);
  if (!existsSync(p)) return null;
  try {
    return parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

export async function writeSession(
  projectDir: string,
  session: SessionFile,
): Promise<void> {
  session.updated_at = new Date().toISOString();
  await mkdir(resolveZipmemDir(projectDir), { recursive: true });
  const p = resolveSessionPath(projectDir);
  const tmp = `${p}.${randomUUID()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(session, null, 2)}\n`, "utf8");
  await rename(tmp, p);
}

/** Atomic synchronous write for the shutdown path. */
export function writeSessionSync(
  projectDir: string,
  session: SessionFile,
): void {
  session.updated_at = new Date().toISOString();
  mkdirSync(resolveZipmemDir(projectDir), { recursive: true });
  const p = resolveSessionPath(projectDir);
  const tmp = `${p}.${randomUUID()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(session, null, 2)}\n`, "utf8");
  renameSync(tmp, p);
}

/**
 * Best-effort list of git-tracked files with uncommitted changes. Used as a
 * recovery hint (coordinates, never code). Synchronous + tightly timed so it is
 * safe to call inside a shutdown handler; returns [] on any failure / non-repo.
 */
export function gitChangedFilesSync(projectDir: string): string[] {
  try {
    const out = execFileSync(
      "git",
      ["-C", projectDir, "diff", "--name-only", "HEAD"],
      { encoding: "utf8", timeout: 1500, stdio: ["ignore", "pipe", "ignore"] },
    );
    return out
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 50);
  } catch {
    return [];
  }
}
