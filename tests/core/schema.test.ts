import { describe, expect, it } from "vitest";
import {
  CompactionPayloadSchema,
  StateSchema,
} from "../../src/core/schema.js";
import { createEmptyState } from "../../src/core/state.js";

describe("StateSchema", () => {
  it("accepts a freshly created empty state", () => {
    const s = createEmptyState("demo", true);
    expect(StateSchema.safeParse(s).success).toBe(true);
  });

  it("rejects an unknown version", () => {
    const s = { ...createEmptyState("demo"), version: 2 };
    expect(StateSchema.safeParse(s).success).toBe(false);
  });
});

describe("CompactionPayloadSchema", () => {
  it("applies array defaults when sections are omitted", () => {
    const parsed = CompactionPayloadSchema.parse({ session_summary: "x" });
    expect(parsed.blueprints).toEqual([]);
    expect(parsed.anchors).toEqual([]);
    expect(parsed.lessons).toEqual([]);
  });

  it("defaults blueprint.immutable to true", () => {
    const parsed = CompactionPayloadSchema.parse({
      session_summary: "x",
      blueprints: [{ category: "schema", title: "T", content: "c" }],
    });
    expect(parsed.blueprints[0]!.immutable).toBe(true);
  });

  it("requires a session_summary", () => {
    expect(CompactionPayloadSchema.safeParse({}).success).toBe(false);
  });
});
