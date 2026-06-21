import { describe, expect, it } from "vitest";
import {
  DIRECTIVE_END,
  DIRECTIVE_START,
  DIRECTIVE_VERSION,
  getDirective,
} from "../../src/core/directive.js";

describe("getDirective", () => {
  it("wraps every mode in the idempotency markers and version header", () => {
    for (const mode of ["conservative", "balanced", "aggressive"] as const) {
      const d = getDirective(mode);
      expect(d.startsWith(DIRECTIVE_START)).toBe(true);
      expect(d.endsWith(DIRECTIVE_END)).toBe(true);
      expect(d).toContain(`Session Memory Protocol (v${DIRECTIVE_VERSION})`);
      expect(d).toContain(`Checkpoint mode for this project: **${mode}**`);
      // Shared sections are present regardless of mode.
      expect(d).toContain("zipmem_load_memory");
      expect(d).toContain("zipmem_save_and_compact");
    }
  });

  it("aggressive asks for a checkpoint after each meaningful unit of work", () => {
    const d = getDirective("aggressive");
    expect(d).toContain("after each meaningful unit");
    expect(d).not.toContain("Do NOT call");
  });

  it("balanced restricts checkpoints to major milestones", () => {
    const d = getDirective("balanced");
    expect(d).toContain("major milestones");
    expect(d).toContain("not** after");
  });

  it("conservative forbids self-persisting but maps the two plain-word commands to their tools", () => {
    const d = getDirective("conservative");
    // Collapse whitespace so assertions don't depend on line wrapping.
    const flat = d.replace(/\s+/g, " ");
    expect(flat).toContain(
      "Do NOT call `zipmem_checkpoint` or `zipmem_save_and_compact`",
    );
    // "checkpoint" → checkpoint tool, "save" → save_and_compact tool.
    expect(flat).toMatch(/"checkpoint".*`zipmem_checkpoint`/);
    expect(flat).toMatch(/"save".*`zipmem_save_and_compact`/);
    expect(flat).toContain("single-line confirmation");
    // No slash commands (Claude Code intercepts them) and English-only.
    expect(d).not.toContain("/checkpoint");
    expect(d).not.toContain("/save");
    expect(d).not.toContain("hafızayı");
  });

  it("produces distinct bodies per mode", () => {
    const modes = ["conservative", "balanced", "aggressive"] as const;
    const bodies = modes.map((m) => getDirective(m));
    expect(new Set(bodies).size).toBe(modes.length);
  });
});
