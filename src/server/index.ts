import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerLoadMemory } from "./tools/load-memory.js";
import { registerSaveCompact } from "./tools/save-compact.js";

/** Register every zipmem tool onto an McpServer instance. */
export function registerTools(server: McpServer): void {
  registerLoadMemory(server);
  registerSaveCompact(server);
}
