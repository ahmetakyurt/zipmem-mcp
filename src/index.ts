#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools } from "./server/index.js";
import { initializeSession, LifecycleMonitor } from "./server/lifecycle.js";
import { resolveProjectDir } from "./utils/paths.js";
import { getVersion } from "./utils/version.js";

/**
 * zipmem-mcp — the MCP server entry point (bin: "zipmem-mcp").
 *
 * Communicates over stdio JSON-RPC. CRITICAL: nothing here may write to stdout
 * (it would corrupt the protocol framing). All diagnostics go to stderr.
 */
async function main(): Promise<void> {
  const server = new McpServer({
    name: "zipmem-mcp",
    version: getVersion(),
  });

  // Resolve the project once at startup and pin the lifecycle/recovery to it.
  const projectDir = resolveProjectDir();

  // Fold any leftover checkpoints from a previously interrupted session into
  // state.json and open a fresh active session.
  await initializeSession(projectDir);

  registerTools(server);

  // Best-effort flush of staged checkpoints on a catchable parent termination.
  new LifecycleMonitor(projectDir).install();

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Connected. Stay alive until stdin closes; the transport handles the loop.
  console.error(`[zipmem-mcp] ready (project: ${projectDir})`);
}

main().catch((err: unknown) => {
  console.error("[zipmem-mcp] fatal:", err);
  process.exit(1);
});
