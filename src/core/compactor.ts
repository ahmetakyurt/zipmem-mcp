import { randomUUID } from "node:crypto";
import type { Anchor, Lesson } from "./schema.js";

/**
 * The Anchored Compacting helpers.
 *
 * IMPORTANT: this module contains no LLM/AI logic. The semantic intelligence
 * lives in the Constitutional Directive injected into CLAUDE.md — the agent
 * does the compression and hands us already-structured data. This module's job
 * is purely deterministic: normalize line ranges, stamp ids/timestamps, and
 * deduplicate. That keeps the server dependency-free and zero-latency.
 */

export interface ParsedRange {
  start: number;
  end: number;
}

/**
 * Parse a human line-range string ("42-67", "42", " 42 - 67 ") into numeric
 * bounds. Returns null for un-parseable input (e.g. "whole file") so callers
 * can fall back to plain string equality.
 */
export function parseLineRange(range: string): ParsedRange | null {
  const trimmed = range.trim();
  const single = /^(\d+)$/.exec(trimmed);
  if (single) {
    const n = Number(single[1]);
    return { start: n, end: n };
  }
  const span = /^(\d+)\s*-\s*(\d+)$/.exec(trimmed);
  if (span) {
    const a = Number(span[1]);
    const b = Number(span[2]);
    return { start: Math.min(a, b), end: Math.max(a, b) };
  }
  return null;
}

/** Format numeric bounds back into the canonical "start-end" / "n" string. */
export function formatLineRange(r: ParsedRange): string {
  return r.start === r.end ? `${r.start}` : `${r.start}-${r.end}`;
}

/** Two ranges overlap or touch (adjacent ranges merge into one). */
export function rangesOverlap(a: ParsedRange, b: ParsedRange): boolean {
  return a.start <= b.end + 1 && b.start <= a.end + 1;
}

/**
 * Stamp incoming anchor payloads with a timestamp and normalize their ranges.
 * Parse failures keep the original string untouched.
 */
export function normalizeIncomingAnchors(
  incoming: ReadonlyArray<{
    file_path: string;
    line_range: string;
    concept: string;
  }>,
  now: string,
): Anchor[] {
  return incoming.map((a) => {
    const parsed = parseLineRange(a.line_range);
    return {
      file_path: a.file_path.trim(),
      line_range: parsed ? formatLineRange(parsed) : a.line_range.trim(),
      concept: a.concept.trim(),
      timestamp: now,
    };
  });
}

/**
 * Merge a new anchor into an existing list for the same file. Overlapping (or
 * adjacent) ranges collapse — the newer concept and the union range win.
 * Anchors for other files, or non-overlapping ranges, are left as-is.
 */
export function mergeAnchor(existing: Anchor[], incoming: Anchor): Anchor[] {
  const incomingRange = parseLineRange(incoming.line_range);

  // Un-parseable range: fall back to exact (path + range) replacement.
  if (!incomingRange) {
    const idx = existing.findIndex(
      (e) =>
        e.file_path === incoming.file_path &&
        e.line_range === incoming.line_range,
    );
    if (idx === -1) return [...existing, incoming];
    const next = [...existing];
    next[idx] = incoming;
    return next;
  }

  const kept: Anchor[] = [];
  let merged = { ...incoming };
  let mergedRange = incomingRange;

  for (const e of existing) {
    if (e.file_path !== incoming.file_path) {
      kept.push(e);
      continue;
    }
    const eRange = parseLineRange(e.line_range);
    if (eRange && rangesOverlap(eRange, mergedRange)) {
      // Absorb the older overlapping anchor into the union range.
      mergedRange = {
        start: Math.min(eRange.start, mergedRange.start),
        end: Math.max(eRange.end, mergedRange.end),
      };
      merged = { ...merged, line_range: formatLineRange(mergedRange) };
    } else {
      kept.push(e);
    }
  }

  merged.line_range = formatLineRange(mergedRange);
  return [...kept, merged];
}

/**
 * Build a Lesson record from an incoming payload. Dedup against existing
 * lessons by case-insensitive summary containment (no LLM): if either summary
 * contains the other, treat them as the same lesson and skip the new one.
 */
export function buildLesson(
  incoming: { summary: string; detail: string; related_files: string[] },
  now: string,
): Lesson {
  return {
    id: randomUUID(),
    summary: incoming.summary.trim(),
    detail: incoming.detail.trim(),
    related_files: incoming.related_files.map((f) => f.trim()).filter(Boolean),
    timestamp: now,
  };
}

export function isDuplicateLesson(
  existing: ReadonlyArray<Lesson>,
  candidate: Lesson,
): boolean {
  const c = candidate.summary.toLowerCase();
  return existing.some((e) => {
    const s = e.summary.toLowerCase();
    return s === c || s.includes(c) || c.includes(s);
  });
}

export { randomUUID };
