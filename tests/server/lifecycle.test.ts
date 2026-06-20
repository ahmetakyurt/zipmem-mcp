import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkpointHandler } from "../../src/server/tools/checkpoint.js";
import { saveCompactHandler } from "../../src/server/tools/save-compact.js";
import { loadMemoryHandler } from "../../src/server/tools/load-memory.js";
import {
  flushOnShutdownSync,
  initializeSession,
  runStartupRecovery,
} from "../../src/server/lifecycle.js";
import { loadState } from "../../src/core/state.js";
import { readSession } from "../../src/core/session.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "zipmem-life-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function startSession(): Promise<void> {
  // Fresh start: no prior session, just opens an active one.
  await initializeSession(dir);
}

describe("checkpoint staging", () => {
  it("accumulates pending without touching state.json", async () => {
    await startSession();
    await checkpointHandler({
      project_dir: dir,
      summary: "wiring auth",
      anchors: [{ file_path: "a.ts", line_range: "1-10", concept: "v1" }],
    });
    const session = await readSession(dir);
    expect(session?.pending.anchors).toHaveLength(1);

    // state.json must still be empty — checkpoints are not yet finalized.
    const state = await loadState(dir);
    expect(state.anchors).toHaveLength(0);
  });

  it("dedups anchors by file+range across checkpoints", async () => {
    await startSession();
    await checkpointHandler({
      project_dir: dir,
      anchors: [{ file_path: "a.ts", line_range: "1-10", concept: "v1" }],
    });
    await checkpointHandler({
      project_dir: dir,
      anchors: [{ file_path: "a.ts", line_range: "1-10", concept: "v2" }],
    });
    const session = await readSession(dir);
    expect(session?.pending.anchors).toHaveLength(1);
    expect(session?.pending.anchors[0]!.concept).toBe("v2");
  });
});

describe("clean compaction folds and clears pending", () => {
  it("merges checkpoints into state and closes the session", async () => {
    await startSession();
    await checkpointHandler({
      project_dir: dir,
      anchors: [{ file_path: "a.ts", line_range: "1-10", concept: "staged" }],
      lessons: [{ summary: "staged lesson", detail: "", related_files: [] }],
    });
    await saveCompactHandler({
      project_dir: dir,
      session_summary: "done",
      anchors: [{ file_path: "b.ts", line_range: "5-9", concept: "final" }],
    });

    const state = await loadState(dir);
    expect(state.anchors).toHaveLength(2); // staged + final
    expect(state.lessons).toHaveLength(1);
    expect(state.session_log).toHaveLength(1); // single record, not two

    const session = await readSession(dir);
    expect(session?.status).toBe("closed");
    expect(session?.pending.anchors).toHaveLength(0);
  });
});

describe("flushOnShutdownSync (catchable termination)", () => {
  it("folds pending into state and marks the session interrupted", async () => {
    await startSession();
    await checkpointHandler({
      project_dir: dir,
      summary: "half-done feature",
      blueprints: [{ category: "decision", title: "X", content: "chose X" }],
      anchors: [{ file_path: "a.ts", line_range: "1-10", concept: "wip" }],
    });

    flushOnShutdownSync(dir, "SIGINT");

    const state = await loadState(dir);
    expect(state.anchors).toHaveLength(1);
    expect(state.blueprints).toHaveLength(1);

    const session = await readSession(dir);
    expect(session?.status).toBe("interrupted");
    expect(session?.reason).toBe("SIGINT");
    expect(session?.recovery?.acknowledged).toBe(false);
    expect(session?.recovery?.recovered_anchors).toBe(1);
  });

  it("is a no-op for an already-closed (cleanly compacted) session", async () => {
    await startSession();
    await saveCompactHandler({ project_dir: dir, session_summary: "clean" });
    flushOnShutdownSync(dir, "SIGTERM");
    const session = await readSession(dir);
    expect(session?.status).toBe("closed"); // unchanged
  });
});

describe("startup recovery (hard kill with no handler)", () => {
  it("folds leftover pending from a still-active prior session", async () => {
    // Simulate a session that staged work then was SIGKILLed: status stays
    // "active" with pending intact and no recovery block.
    await startSession();
    await checkpointHandler({
      project_dir: dir,
      anchors: [{ file_path: "a.ts", line_range: "1-10", concept: "orphaned" }],
    });

    const recovery = runStartupRecovery(dir);
    expect(recovery?.recovered_anchors).toBe(1);

    const state = await loadState(dir);
    expect(state.anchors).toHaveLength(1);
  });

  it("returns undefined when the prior session closed cleanly", async () => {
    await startSession();
    await saveCompactHandler({ project_dir: dir, session_summary: "clean" });
    expect(runStartupRecovery(dir)).toBeUndefined();
  });
});

describe("recovery banner surfaced once by load_memory", () => {
  it("shows the banner, then acknowledges it", async () => {
    // Build an interrupted session via the shutdown path.
    await startSession();
    await checkpointHandler({
      project_dir: dir,
      anchors: [{ file_path: "a.ts", line_range: "1-10", concept: "wip" }],
    });
    flushOnShutdownSync(dir, "stdin-close");

    // Next session boots and recovers.
    await initializeSession(dir);

    const first = await loadMemoryHandler({ project_dir: dir });
    expect(first.content[0]!.text).toContain("ZipMem recovery");
    expect(first.content[0]!.text).toContain("stdin-close");

    const second = await loadMemoryHandler({ project_dir: dir });
    expect(second.content[0]!.text).not.toContain("ZipMem recovery");
  });
});

describe("session lifecycle across a clean start", () => {
  it("opens an active session on initializeSession", async () => {
    await initializeSession(dir);
    const session = await readSession(dir);
    expect(session?.status).toBe("active");
    expect(session?.pid).toBe(process.pid);
  });

  it("does not surface a banner when a fresh session is interrupted with no work", async () => {
    await initializeSession(dir);
    // No checkpoints, no git changes in a temp dir.
    flushOnShutdownSync(dir, "SIGINT");
    await initializeSession(dir);
    const res = await loadMemoryHandler({ project_dir: dir });
    expect(res.content[0]!.text).not.toContain("ZipMem recovery");
  });
});
