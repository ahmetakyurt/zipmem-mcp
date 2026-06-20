import { describe, expect, it } from "vitest";
import {
  buildLesson,
  formatLineRange,
  isDuplicateLesson,
  mergeAnchor,
  normalizeIncomingAnchors,
  parseLineRange,
  rangesOverlap,
} from "../../src/core/compactor.js";
import type { Anchor } from "../../src/core/schema.js";

const NOW = "2026-06-20T00:00:00.000Z";

describe("parseLineRange", () => {
  it("parses single lines", () => {
    expect(parseLineRange("42")).toEqual({ start: 42, end: 42 });
  });
  it("parses spans and tolerates whitespace", () => {
    expect(parseLineRange(" 42 - 67 ")).toEqual({ start: 42, end: 67 });
  });
  it("normalizes reversed spans", () => {
    expect(parseLineRange("67-42")).toEqual({ start: 42, end: 67 });
  });
  it("returns null for non-numeric ranges", () => {
    expect(parseLineRange("whole file")).toBeNull();
  });
});

describe("formatLineRange", () => {
  it("collapses equal bounds to a single number", () => {
    expect(formatLineRange({ start: 5, end: 5 })).toBe("5");
    expect(formatLineRange({ start: 5, end: 9 })).toBe("5-9");
  });
});

describe("rangesOverlap", () => {
  it("treats adjacent ranges as overlapping (mergeable)", () => {
    expect(rangesOverlap({ start: 1, end: 5 }, { start: 6, end: 9 })).toBe(true);
  });
  it("returns false for clearly separate ranges", () => {
    expect(rangesOverlap({ start: 1, end: 5 }, { start: 20, end: 25 })).toBe(
      false,
    );
  });
});

describe("normalizeIncomingAnchors", () => {
  it("canonicalizes ranges and stamps timestamps", () => {
    const out = normalizeIncomingAnchors(
      [{ file_path: " src/a.ts ", line_range: "67-42", concept: " x " }],
      NOW,
    );
    expect(out[0]).toEqual({
      file_path: "src/a.ts",
      line_range: "42-67",
      concept: "x",
      timestamp: NOW,
    });
  });
});

describe("mergeAnchor", () => {
  const base: Anchor = {
    file_path: "src/a.ts",
    line_range: "10-20",
    concept: "old",
    timestamp: NOW,
  };

  it("unions overlapping ranges and keeps the new concept", () => {
    const merged = mergeAnchor([base], {
      file_path: "src/a.ts",
      line_range: "15-30",
      concept: "new",
      timestamp: NOW,
    });
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ line_range: "10-30", concept: "new" });
  });

  it("keeps non-overlapping ranges for the same file", () => {
    const merged = mergeAnchor([base], {
      file_path: "src/a.ts",
      line_range: "100-120",
      concept: "other",
      timestamp: NOW,
    });
    expect(merged).toHaveLength(2);
  });

  it("never merges across different files", () => {
    const merged = mergeAnchor([base], {
      file_path: "src/b.ts",
      line_range: "10-20",
      concept: "b",
      timestamp: NOW,
    });
    expect(merged).toHaveLength(2);
  });
});

describe("lessons", () => {
  it("builds a lesson with id and trimmed fields", () => {
    const l = buildLesson(
      { summary: " be careful ", detail: " x ", related_files: [" a.ts "] },
      NOW,
    );
    expect(l.summary).toBe("be careful");
    expect(l.related_files).toEqual(["a.ts"]);
    expect(l.id).toBeTruthy();
  });

  it("detects substring-duplicate summaries case-insensitively", () => {
    const existing = [buildLesson({ summary: "Migrations need a backup", detail: "", related_files: [] }, NOW)];
    const dup = buildLesson({ summary: "migrations need a backup", detail: "", related_files: [] }, NOW);
    expect(isDuplicateLesson(existing, dup)).toBe(true);
  });
});
