import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CompactionPayloadSchema,
  type CompactionPayload,
} from "../../core/schema.js";
import { loadState, mergeState, pruneState, saveState } from "../../core/state.js";
import {
  accumulatePending,
  emptyPending,
  pendingToPayload,
  readSession,
  writeSession,
} from "../../core/session.js";
import { resolveProjectDir } from "../../utils/paths.js";
import type { ToolResult } from "./load-memory.js";

export const SAVE_COMPACT_TOOL = "zipmem_save_and_compact";

export const SAVE_COMPACT_DESCRIPTION =
  "Compress the current session and merge it into long-term memory. CALL THIS " +
  "when the user signals they are done (exit/quit/goodbye/wrap up) OR when you " +
  "sense your context window is nearing capacity. Provide your work as " +
  "structured sections: blueprints (verbatim architecture/schemas/decisions), " +
  "anchors (file coordinates instead of raw code), and lessons (distilled bug " +
  "fixes). Never include raw code blocks — use anchors.";

/** Raw zod shape (zod 3/4 compatible) for the MCP inputSchema. */
export const saveCompactInputShape = {
  project_dir: z
    .string()
    .optional()
    .describe(
      "Absolute path to the project root. Defaults to CLAUDE_PROJECT_DIR, then the nearest .zipmem/ ancestor, then cwd.",
    ),
  session_summary: z
    .string()
    .describe("One paragraph: what was accomplished this session."),
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
        immutable: z
          .boolean()
          .optional()
          .describe("Set false to supersede an existing blueprint with this title."),
      }),
    )
    .optional()
    .describe("New/updated architectural facts to preserve verbatim."),
  anchors: z
    .array(
      z.object({
        file_path: z.string(),
        line_range: z.string().describe('e.g. "42-67" or "42".'),
        concept: z.string().describe("The structural change concept — not the code."),
      }),
    )
    .optional()
    .describe("File-coordinate anchors that replace raw code blocks."),
  lessons: z
    .array(
      z.object({
        summary: z.string(),
        detail: z.string().optional(),
        related_files: z.array(z.string()).optional(),
      }),
    )
    .optional()
    .describe("Bug resolutions and gotchas distilled into lessons learned."),
};

export interface SaveCompactArgs {
  project_dir?: string;
  session_summary: string;
  blueprints?: CompactionPayload["blueprints"];
  anchors?: CompactionPayload["anchors"];
  lessons?: Array<{
    summary: string;
    detail?: string;
    related_files?: string[];
  }>;
}

/** Pure handler — directly unit-testable without an MCP transport. */
export async function saveCompactHandler(
  args: SaveCompactArgs,
): Promise<ToolResult> {
  try {
    const projectDir = resolveProjectDir(args.project_dir);

    // Validate + apply defaults through the canonical schema.
    const payload = CompactionPayloadSchema.parse({
      session_summary: args.session_summary,
      blueprints: args.blueprints ?? [],
      anchors: args.anchors ?? [],
      lessons: args.lessons ?? [],
    });

    // Fold any staged checkpoints from this session into the final payload so
    // nothing buffered for crash-safety is lost, and a single session record
    // is produced.
    const session = await readSession(projectDir);
    const folded = accumulatePending(session?.pending ?? emptyPending(), {
      session_summary: payload.session_summary,
      blueprints: payload.blueprints,
      anchors: payload.anchors,
      lessons: payload.lessons,
    });
    const combined = pendingToPayload(folded, payload.session_summary);

    const existing = await loadState(projectDir);
    const now = new Date().toISOString();
    const { state: merged, stats } = mergeState(existing, combined, now);
    const { state: finalState, pruned } = pruneState(merged, projectDir);

    await saveState(projectDir, finalState);

    // Mark the session cleanly closed and clear the pending buffer so the next
    // session's startup recovery does not re-fold already-persisted data.
    if (session) {
      session.status = "closed";
      session.pending = emptyPending();
      delete session.recovery;
      await writeSession(projectDir, session);
    }

    const sizeKb = (finalState.meta.state_size_bytes / 1024).toFixed(1);
    const prunedNote = pruned ? " (state pruned to stay under the hard limit)" : "";
    const text =
      `Memory compacted${prunedNote}. ` +
      `Blueprints: ${stats.blueprintsTotal} (+${stats.blueprintsAdded}), ` +
      `Anchors: ${stats.anchorsTotal} (+${stats.anchorsAdded}), ` +
      `Lessons: ${stats.lessonsTotal} (+${stats.lessonsAdded}), ` +
      `Sessions: ${finalState.meta.total_sessions}. State size: ${sizeKb}KB.`;

    return { content: [{ type: "text", text }] };
  } catch (err) {
    return {
      content: [
        {
          type: "text",
          text: `zipmem_save_and_compact failed: ${(err as Error).message}`,
        },
      ],
      isError: true,
    };
  }
}

export function registerSaveCompact(server: McpServer): void {
  server.registerTool(
    SAVE_COMPACT_TOOL,
    {
      title: "Save & compact ZipMem memory",
      description: SAVE_COMPACT_DESCRIPTION,
      inputSchema: saveCompactInputShape,
    },
    async (args) => saveCompactHandler(args as SaveCompactArgs),
  );
}
