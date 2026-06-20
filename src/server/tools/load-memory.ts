import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { formatMemory, type Section } from "../../core/format.js";
import { loadState } from "../../core/state.js";
import { readSession, writeSession } from "../../core/session.js";
import { resolveProjectDir } from "../../utils/paths.js";

export const LOAD_MEMORY_TOOL = "zipmem_load_memory";

export const LOAD_MEMORY_DESCRIPTION =
  "Load this project's compressed long-term memory. CALL THIS FIRST, at the very " +
  "start of every session, before doing anything else. Returns architectural " +
  "blueprints, file-coordinate anchors, and lessons learned from previous " +
  "sessions so you regain full context at near-zero token cost.";

/** Raw zod shape (zod 3/4 compatible) for the MCP inputSchema. */
export const loadMemoryInputShape = {
  project_dir: z
    .string()
    .optional()
    .describe(
      "Absolute path to the project root. Defaults to CLAUDE_PROJECT_DIR, then the nearest .zipmem/ ancestor, then cwd.",
    ),
  sections: z
    .array(
      z.enum(["blueprints", "anchors", "lessons", "session_log", "all"]),
    )
    .optional()
    .describe("Which sections to load. Defaults to all."),
};

export interface ToolResult {
  // Index signature keeps this structurally compatible with the MCP SDK's
  // CallToolResult type expected by registerTool's callback.
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export interface LoadMemoryArgs {
  project_dir?: string;
  sections?: Section[];
}

/** Pure handler — directly unit-testable without an MCP transport. */
export async function loadMemoryHandler(
  args: LoadMemoryArgs,
): Promise<ToolResult> {
  try {
    const projectDir = resolveProjectDir(args.project_dir);
    const state = await loadState(projectDir);
    const sections = args.sections?.length ? args.sections : (["all"] as Section[]);
    const memory = formatMemory(state, sections);

    const banner = await consumeRecoveryBanner(projectDir);
    const text = banner ? `${banner}\n\n${memory}` : memory;
    return { content: [{ type: "text", text }] };
  } catch (err) {
    return {
      content: [
        {
          type: "text",
          text: `zipmem_load_memory failed: ${(err as Error).message}`,
        },
      ],
      isError: true,
    };
  }
}

/**
 * If the previous session ended without a clean compaction, the startup
 * recovery left a `recovery` block on the session file. Surface it once as a
 * banner instructing the agent to reconcile the uncompacted changes, then mark
 * it acknowledged so it is not shown again.
 */
async function consumeRecoveryBanner(
  projectDir: string,
): Promise<string | null> {
  const session = await readSession(projectDir);
  if (!session?.recovery || session.recovery.acknowledged) return null;

  const r = session.recovery;
  const recovered =
    r.recovered_blueprints + r.recovered_anchors + r.recovered_lessons;
  if (recovered === 0 && r.uncompacted_files.length === 0) {
    // Nothing actionable — acknowledge silently.
    session.recovery.acknowledged = true;
    await writeSession(projectDir, session);
    return null;
  }

  const lines: string[] = [];
  lines.push("> ⚠️ **ZipMem recovery**");
  lines.push(
    `> The previous session ended without a clean compaction (reason: ${r.reason}).`,
  );
  if (recovered > 0) {
    lines.push(
      `> Recovered from checkpoints: ${r.recovered_blueprints} blueprint(s), ${r.recovered_anchors} anchor(s), ${r.recovered_lessons} lesson(s).`,
    );
  }
  if (r.uncompacted_files.length > 0) {
    lines.push(
      `> These files had uncommitted changes that may not be captured — review them and add anchors/lessons now, then call zipmem_save_and_compact:`,
    );
    for (const f of r.uncompacted_files.slice(0, 20)) lines.push(`>   - ${f}`);
  }

  session.recovery.acknowledged = true;
  await writeSession(projectDir, session);
  return lines.join("\n");
}

export function registerLoadMemory(server: McpServer): void {
  server.registerTool(
    LOAD_MEMORY_TOOL,
    {
      title: "Load ZipMem memory",
      description: LOAD_MEMORY_DESCRIPTION,
      inputSchema: loadMemoryInputShape,
    },
    async (args) => loadMemoryHandler(args as LoadMemoryArgs),
  );
}
