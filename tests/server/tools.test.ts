import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadMemoryHandler } from "../../src/server/tools/load-memory.js";
import { saveCompactHandler } from "../../src/server/tools/save-compact.js";
import { loadState } from "../../src/core/state.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "zipmem-tools-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("loadMemoryHandler", () => {
  it("returns the empty-state header on a fresh project", async () => {
    const res = await loadMemoryHandler({ project_dir: dir });
    expect(res.isError).toBeFalsy();
    expect(res.content[0]!.text).toContain("Project Memory Loaded");
    expect(res.content[0]!.text).toContain("No memory recorded yet");
  });
});

describe("saveCompactHandler", () => {
  it("writes state and reports stats", async () => {
    const res = await saveCompactHandler({
      project_dir: dir,
      session_summary: "Implemented auth",
      blueprints: [
        { category: "decision", title: "Auth", content: "OAuth2 PKCE", immutable: true },
      ],
      anchors: [
        { file_path: "src/auth.ts", line_range: "15-42", concept: "PKCE flow" },
      ],
      lessons: [
        { summary: "Webhook must be idempotent", detail: "Stripe retries", related_files: ["src/webhook.ts"] },
      ],
    });
    expect(res.isError).toBeFalsy();
    expect(res.content[0]!.text).toContain("Blueprints: 1 (+1)");

    const state = await loadState(dir);
    expect(state.blueprints).toHaveLength(1);
    expect(state.anchors).toHaveLength(1);
    expect(state.lessons).toHaveLength(1);
    expect(state.meta.total_compactions).toBe(1);
  });

  it("round-trips: save then load shows the content", async () => {
    await saveCompactHandler({
      project_dir: dir,
      session_summary: "Set up schema",
      blueprints: [{ category: "schema", title: "Users", content: "id, email", immutable: true }],
    });
    const res = await loadMemoryHandler({ project_dir: dir });
    expect(res.content[0]!.text).toContain("[SCHEMA] Users");
  });

  it("merges across two compactions", async () => {
    await saveCompactHandler({
      project_dir: dir,
      session_summary: "s1",
      anchors: [{ file_path: "a.ts", line_range: "1-10", concept: "v1" }],
    });
    await saveCompactHandler({
      project_dir: dir,
      session_summary: "s2",
      anchors: [{ file_path: "a.ts", line_range: "5-20", concept: "v2" }],
    });
    const state = await loadState(dir);
    expect(state.anchors).toHaveLength(1);
    expect(state.anchors[0]!.line_range).toBe("1-20");
    expect(state.meta.total_sessions).toBe(2);
  });

  it("reports an error result for an empty session_summary", async () => {
    const res = await saveCompactHandler({
      project_dir: dir,
      session_summary: "",
    });
    expect(res.isError).toBe(true);
  });
});
