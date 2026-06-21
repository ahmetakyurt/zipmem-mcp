#!/usr/bin/env node
import { parseArgs } from "node:util";
import { init } from "./cli/init.js";
import { status } from "./cli/status.js";
import { CheckpointMode } from "./core/schema.js";
import { getVersion } from "./utils/version.js";

const HELP = `zipmem — local-first AI session memory (Anchored Compacting)

Usage:
  zipmem init [--shared] [--checkpoint=<mode>]
                           Set up .zipmem/ and inject the directive into CLAUDE.md
  zipmem status            Show a summary of the project's memory
  zipmem --version         Print version
  zipmem --help            Show this help

Options:
  --shared                 Commit memory to git (default: keep .zipmem/ local)
  --checkpoint=<mode>      Checkpoint cadence the agent follows. One of:
                             conservative  only on an explicit user command (saves tokens)
                             balanced      at major milestones only (default)
                             aggressive    after every meaningful unit of work

After init, register the server with Claude Code:
  claude mcp add zipmem-mcp -- npx zipmem-mcp`;

/**
 * Validate the optional `--checkpoint` value against the allowed modes.
 * Returns `undefined` when the flag was not passed (so existing state's mode is
 * preserved); throws a clear error for an unknown value.
 */
function parseCheckpointMode(
  raw: string | undefined,
): CheckpointMode | undefined {
  if (raw === undefined) return undefined;
  const result = CheckpointMode.safeParse(raw);
  if (!result.success) {
    throw new Error(
      `invalid --checkpoint value "${raw}". Expected one of: ${CheckpointMode.options.join(", ")}.`,
    );
  }
  return result.data;
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
      shared: { type: "boolean" },
      checkpoint: { type: "string" },
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
    case "init": {
      const checkpoint = parseCheckpointMode(values.checkpoint);
      await init(process.cwd(), { shared: values.shared ?? false, checkpoint });
      break;
    }
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
