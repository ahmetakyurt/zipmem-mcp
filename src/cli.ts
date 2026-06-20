#!/usr/bin/env node
import { parseArgs } from "node:util";
import { init } from "./cli/init.js";
import { status } from "./cli/status.js";
import { getVersion } from "./utils/version.js";

const HELP = `zipmem — local-first AI session memory (Anchored Compacting)

Usage:
  zipmem init [--shared]   Set up .zipmem/ and inject the directive into CLAUDE.md
  zipmem status            Show a summary of the project's memory
  zipmem --version         Print version
  zipmem --help            Show this help

Options:
  --shared                 Commit memory to git (default: keep .zipmem/ local)

After init, register the server with Claude Code:
  claude mcp add zipmem-mcp -- npx zipmem-mcp`;

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
      shared: { type: "boolean" },
    },
  });

  if (values.version) {
    console.log(getVersion());
    return;
  }

  const command = positionals[0];

  if (values.help || !command) {
    console.log(HELP);
    return;
  }

  switch (command) {
    case "init":
      await init(process.cwd(), { shared: values.shared ?? false });
      break;
    case "status":
      await status(process.cwd());
      break;
    default:
      console.error(`Unknown command: ${command}\n`);
      console.log(HELP);
      process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  console.error(`zipmem: ${(err as Error).message}`);
  process.exit(1);
});
