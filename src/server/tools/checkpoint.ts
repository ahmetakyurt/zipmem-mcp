import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  accumulatePending,
  newActiveSession,
  readSession,
  writeSession,
  type PendingPayload,
} from "../../core/session.js";
import { resolveProjectDir } from "../../utils/paths.js";
import type { ToolResult } from "./load-memory.js";

export const CHECKPOINT_TOOL = "zipmem_checkpoint";

export const CHECKPOINT_DESCRIPTION =
  "Stage incremental progress for crash-safety. Call this PERIODICALLY during a " +
  "session — after each meaningful unit of work (a feature wired up, a bug " +
  "fixed, a decision made) — so that an abrupt exit (Ctrl+C, a closed terminal, " +
  "a crash) never loses more than the last few steps. It is cheap and does NOT " +
  "finalize the session: pass the same structured fields as save_and_compact " +
  "(blueprints/anchors/lessons + a running summary). The data is buffered " +
  "durably and folded into memory automatically on the next session if the " +
  "current one ends without a clean compaction.";

export const checkpointInputShape = {
  project_dir: z.string().optional().describe("Defaults to the server's project root."),
  summary: z
    .string()
    .optional()
    .describe("A running one-line summary of progress so far (optional)."),
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
        immutable: z.boolean().optional(),
      }),
    )
    .optional(),
  anchors: z
    .array(
      z.object({
        file_path: z.string(),
        line_range: z.string(),
        concept: z.string(),
      }),
    )
    .optional(),
  lessons: z
    .array(
      z.object({
        summary: z.string(),
        detail: z.string().optional(),
        related_files: z.array(z.string()).optional(),
      }),
    )
    .optional(),
};

export interface CheckpointArgs {
  project_dir?: string;
  summary?: string;
  blueprints?: PendingPayload["blueprints"];
  anchors?: PendingPayload["anchors"];
  lessons?: Array<{ summary: string; detail?: string; related_files?: string[] }>;
}

export async function checkpointHandler(
  args: CheckpointArgs,
): Promise<ToolResult> {
  try {
    const projectDir = resolveProjectDir(args.project_dir);
    const existing = await readSession(projectDir);
    // Reuse the live session if present; otherwise start a fresh active one.
    const session =
      existing && existing.status !== "interrupted"
        ? existing
        : newActiveSession();

    session.status = "active";
    session.pending = accumulatePending(session.pending, {
      session_summary: args.summary ?? "",
      blueprints: (args.blueprints ?? []).map((b) => ({
        ...b,
        immutable: b.immutable ?? true,
      })),
      anchors: args.anchors ?? [],
      lessons: (args.lessons ?? []).map((l) => ({
        summary: l.summary,
        detail: l.detail ?? "",
        related_files: l.related_files ?? [],
      })),
    });

    await writeSession(projectDir, session);

    const p = session.pending;
    return {
      content: [
        {
          type: "text",
          text:
            `Checkpoint staged. Pending — blueprints: ${p.blueprints.length}, ` +
            `anchors: ${p.anchors.length}, lessons: ${p.lessons.length}. ` +
            `This is crash-safe; finalize with zipmem_save_and_compact before exit.`,
        },
      ],
    };
  } catch (err) {
    return {
      content: [
        {
          type: "text",
          text: `zipmem_checkpoint failed: ${(err as Error).message}`,
        },
      ],
      isError: true,
    };
  }
}

export function registerCheckpoint(server: McpServer): void {
  server.registerTool(
    CHECKPOINT_TOOL,
    {
      title: "Checkpoint ZipMem progress",
      description: CHECKPOINT_DESCRIPTION,
      inputSchema: checkpointInputShape,
    },
    async (args) => checkpointHandler(args as CheckpointArgs),
  );
}
