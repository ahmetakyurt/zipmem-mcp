import type { State } from "./schema.js";
import { SOFT_LIMIT_BYTES } from "./state.js";

export type Section =
  | "blueprints"
  | "anchors"
  | "lessons"
  | "session_log"
  | "all";

const CATEGORY_TAG: Record<string, string> = {
  architecture: "ARCH",
  schema: "SCHEMA",
  decision: "DECISION",
  convention: "CONVENTION",
  dependency: "DEPENDENCY",
};

function wants(sections: Section[], s: Section): boolean {
  return sections.includes("all") || sections.includes(s);
}

function shortDate(iso: string): string {
  // YYYY-MM-DD for compactness; falls back to the raw value if unparseable.
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toISOString().slice(0, 10);
}

/**
 * Render persistent state into the compact, agent-readable text returned by
 * `zipmem_load_memory`. The format is intentionally terse: tags + one line per
 * item, anchors as `[path -> lines -> concept]`, so a large history costs few
 * tokens while remaining expandable on demand (the agent can re-read files).
 */
export function formatMemory(
  state: State,
  sections: Section[] = ["all"],
): string {
  const lines: string[] = [];

  lines.push("# ZipMem: Project Memory Loaded");
  lines.push(
    `## Project: ${state.project_name} | Sessions: ${state.meta.total_sessions} | Updated: ${shortDate(
      state.updated_at,
    )}`,
  );

  const isEmpty =
    state.blueprints.length === 0 &&
    state.anchors.length === 0 &&
    state.lessons.length === 0 &&
    state.session_log.length === 0;

  if (isEmpty) {
    lines.push("");
    lines.push(
      "_No memory recorded yet. This is a fresh project — work normally, then call `zipmem_save_and_compact` before ending the session._",
    );
    return lines.join("\n");
  }

  if (wants(sections, "blueprints") && state.blueprints.length > 0) {
    lines.push("");
    lines.push(`### Blueprints (${state.blueprints.length})`);
    for (const b of state.blueprints) {
      const tag = CATEGORY_TAG[b.category] ?? b.category.toUpperCase();
      lines.push(`[${tag}] ${b.title}`);
      if (b.content.trim()) {
        for (const cl of b.content.trim().split("\n")) {
          lines.push(`    ${cl}`);
        }
      }
    }
  }

  if (wants(sections, "anchors") && state.anchors.length > 0) {
    lines.push("");
    lines.push(`### File Anchors (${state.anchors.length})`);
    for (const a of state.anchors) {
      lines.push(`[${a.file_path} -> ${a.line_range} -> ${a.concept}]`);
    }
    lines.push(
      "_Anchors are coordinates, not code. Read the file at those lines to expand any anchor._",
    );
  }

  if (wants(sections, "lessons") && state.lessons.length > 0) {
    lines.push("");
    lines.push(`### Lessons Learned (${state.lessons.length})`);
    state.lessons.forEach((l, i) => {
      const files =
        l.related_files.length > 0 ? ` (${l.related_files.join(", ")})` : "";
      lines.push(`[L${i + 1}] ${l.summary}${files}`);
      if (l.detail.trim()) {
        lines.push(`    ${l.detail.trim().replace(/\n/g, " ")}`);
      }
    });
  }

  if (wants(sections, "session_log") && state.session_log.length > 0) {
    lines.push("");
    const recent = state.session_log.slice(-5);
    lines.push(`### Recent Sessions (${recent.length} of ${state.session_log.length})`);
    recent.forEach((s, i) => {
      const n = state.session_log.length - recent.length + i + 1;
      lines.push(`[S${n}] ${shortDate(s.ended_at)}: ${s.summary}`);
    });
  }

  if (state.meta.state_size_bytes > SOFT_LIMIT_BYTES) {
    lines.push("");
    lines.push(
      `> ⚠️ Memory is ${(state.meta.state_size_bytes / 1024).toFixed(0)}KB (soft limit ${(
        SOFT_LIMIT_BYTES / 1024
      ).toFixed(0)}KB). Consider consolidating blueprints on the next compaction.`,
    );
  }

  return lines.join("\n");
}
