import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  HARD_LIMIT_BYTES,
  createEmptyState,
  loadState,
  mergeState,
  pruneState,
  saveState,
  stateExists,
} from "../../src/core/state.js";
import type { CompactionPayload } from "../../src/core/schema.js";
import { resolveStatePath } from "../../src/utils/paths.js";

function payload(over: Partial<CompactionPayload> = {}): CompactionPayload {
  return {
    session_summary: "did things",
    blueprints: [],
    anchors: [],
    lessons: [],
    ...over,
  };
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "zipmem-test-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("load/save round-trip", () => {
  it("returns empty state when none exists", async () => {
    expect(stateExists(dir)).toBe(false);
    const s = await loadState(dir);
    expect(s.blueprints).toEqual([]);
    expect(s.version).toBe(1);
  });

  it("persists atomically and reloads identically", async () => {
    const s = createEmptyState("demo");
    await saveState(dir, s);
    expect(stateExists(dir)).toBe(true);

    const loaded = await loadState(dir);
    expect(loaded.project_name).toBe("demo");
    expect(loaded.meta.state_size_bytes).toBeGreaterThan(0);

    // No leftover temp files.
    const raw = await readFile(resolveStatePath(dir), "utf8");
    expect(raw.endsWith("\n")).toBe(true);
  });

  it("throws on corrupt JSON", async () => {
    const s = createEmptyState("demo");
    await saveState(dir, s);
    await readFile(resolveStatePath(dir), "utf8");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(resolveStatePath(dir), "{ not json", "utf8");
    await expect(loadState(dir)).rejects.toThrow(/not valid JSON/);
  });
});

describe("mergeState", () => {
  it("adds new blueprints and dedups by category+title", () => {
    const base = createEmptyState("demo");
    const a = mergeState(
      base,
      payload({
        blueprints: [{ category: "schema", title: "Users", content: "v1", immutable: true }],
      }),
    ).state;
    expect(a.blueprints).toHaveLength(1);

    // Same title+category, immutable existing -> ignored.
    const b = mergeState(
      a,
      payload({
        blueprints: [{ category: "schema", title: "Users", content: "v2", immutable: true }],
      }),
    ).state;
    expect(b.blueprints).toHaveLength(1);
    expect(b.blueprints[0]!.content).toBe("v1");
  });

  it("supersedes a blueprint when immutable:false", () => {
    const base = createEmptyState("demo");
    const a = mergeState(
      base,
      payload({
        blueprints: [{ category: "decision", title: "API", content: "REST", immutable: true }],
      }),
    ).state;
    const b = mergeState(
      a,
      payload({
        blueprints: [{ category: "decision", title: "API", content: "tRPC", immutable: false }],
      }),
    ).state;
    expect(b.blueprints).toHaveLength(1);
    expect(b.blueprints[0]!.content).toBe("tRPC");
  });

  it("merges overlapping anchors and appends sessions", () => {
    const base = createEmptyState("demo");
    const r = mergeState(
      base,
      payload({
        anchors: [
          { file_path: "a.ts", line_range: "10-20", concept: "first" },
          { file_path: "a.ts", line_range: "15-30", concept: "second" },
        ],
      }),
    );
    expect(r.state.anchors).toHaveLength(1);
    expect(r.state.anchors[0]!.line_range).toBe("10-30");
    expect(r.state.session_log).toHaveLength(1);
    expect(r.state.meta.total_sessions).toBe(1);
  });

  it("skips duplicate lessons", () => {
    const base = createEmptyState("demo");
    const r = mergeState(
      base,
      payload({
        lessons: [
          { summary: "Back up before migrate", detail: "", related_files: [] },
          { summary: "back up before migrate", detail: "", related_files: [] },
        ],
      }),
    );
    expect(r.state.lessons).toHaveLength(1);
    expect(r.stats.lessonsAdded).toBe(1);
  });
});

describe("pruneState", () => {
  it("is a no-op below the hard limit", () => {
    const s = createEmptyState("demo");
    const { pruned } = pruneState(s, dir);
    expect(pruned).toBe(false);
  });

  it("drops oldest lessons when far over the hard limit", () => {
    const s = createEmptyState("demo");
    const big = "x".repeat(2000);
    const oldTs = new Date(Date.now() - 90 * 864e5).toISOString();
    for (let i = 0; i < 400; i++) {
      s.lessons.push({
        id: `id-${i}`,
        summary: `lesson ${i} ${big}`,
        detail: big,
        related_files: [],
        timestamp: oldTs,
      });
    }
    const before = s.lessons.length;
    const { state, pruned } = pruneState(s, dir);
    expect(pruned).toBe(true);
    expect(state.lessons.length).toBeLessThan(before);
    const size = Buffer.byteLength(JSON.stringify(state, null, 2));
    expect(size).toBeLessThanOrEqual(HARD_LIMIT_BYTES);
  });
});
