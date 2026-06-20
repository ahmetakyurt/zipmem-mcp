#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools } from "./server/index.js";
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

  registerTools(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Connected. Stay alive until stdin closes; the transport handles the loop.
  console.error("[zipmem-mcp] ready");
}

main().catch((err: unknown) => {
  console.error("[zipmem-mcp] fatal:", err);
  process.exit(1);
});
