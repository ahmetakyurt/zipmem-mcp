import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { formatMemory, type Section } from "../../core/format.js";
import { loadState } from "../../core/state.js";
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
    const text = formatMemory(state, sections);
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
