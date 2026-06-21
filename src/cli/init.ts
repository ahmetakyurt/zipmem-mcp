import { existsSync } from "node:fs";
import path from "node:path";
import { DEFAULT_CHECKPOINT_MODE } from "../core/schema.js";
import type { CheckpointMode } from "../core/schema.js";
import {
  createEmptyState,
  loadState,
  saveState,
  stateExists,
} from "../core/state.js";
import { resolveStatePath, resolveZipmemDir } from "../utils/paths.js";
import {
  c,
  ensureGitignore,
  info,
  inferProjectName,
  injectDirective,
  success,
  warn,
  writeInternalGitignore,
} from "./helpers.js";

export interface InitOptions {
  shared?: boolean;
  /**
   * Checkpoint cadence to bake into the directive and state. When omitted on a
   * brand-new project the default applies; when omitted on an existing project
   * the stored mode is left untouched.
   */
  checkpoint?: CheckpointMode;
}

/**
 * `zipmem init` — bootstrap zipmem in the given project directory:
 *  1. create `.zipmem/state.json` (preserve it if already present),
 *  2. inject the Constitutional Directive into CLAUDE.md / memory.md,
 *  3. handle .gitignore (local default vs. --shared),
 *  4. print the MCP registration command.
 */
export async function init(
  projectDir: string,
  opts: InitOptions = {},
): Promise<void> {
  const shared = opts.shared ?? false;
  const resolved = path.resolve(projectDir);

  info(c.bold(`zipmem init  ${c.dim(`(${resolved})`)}`));
  info("");

  // 1. State file. The effective checkpoint mode comes from (a) an explicit
  //    --checkpoint flag, else (b) an existing state's stored mode, else (c) the
  //    default. An explicit flag on an existing project updates the stored mode.
  let checkpointMode: CheckpointMode;
  if (stateExists(resolved)) {
    const existing = await loadState(resolved);
    if (opts.checkpoint && opts.checkpoint !== existing.meta.checkpoint_mode) {
      existing.meta.checkpoint_mode = opts.checkpoint;
      await saveState(resolved, existing);
      checkpointMode = opts.checkpoint;
      success(`Updated checkpoint mode to ${c.bold(checkpointMode)}.`);
    } else {
      checkpointMode = existing.meta.checkpoint_mode;
      warn(
        `State already exists at ${c.dim(resolveStatePath(resolved))} — left untouched ${c.dim(`(checkpoint mode: ${checkpointMode})`)}.`,
      );
    }
  } else {
    checkpointMode = opts.checkpoint ?? DEFAULT_CHECKPOINT_MODE;
    const projectName = await inferProjectName(resolved);
    const state = createEmptyState(projectName, shared, checkpointMode);
    await saveState(resolved, state);
    await writeInternalGitignore(resolveZipmemDir(resolved));
    success(
      `Created ${c.cyan(".zipmem/state.json")} for project ${c.bold(projectName)}${
        shared ? c.dim(" (shared)") : ""
      } ${c.dim(`(checkpoint mode: ${checkpointMode})`)}.`,
    );
  }

  // 2. Constitutional Directive
  const dir = await injectDirective(resolved, checkpointMode);
  const rel = path.relative(resolved, dir.file) || dir.file;
  switch (dir.action) {
    case "created":
      success(`Created ${c.cyan(rel)} with the ZipMem directive.`);
      break;
    case "appended":
      success(`Appended the ZipMem directive to ${c.cyan(rel)}.`);
      break;
    case "updated":
      success(`Updated the ZipMem directive block in ${c.cyan(rel)}.`);
      break;
    case "skipped":
      info(`${c.dim("•")} ZipMem directive already current in ${c.cyan(rel)}.`);
      break;
  }

  // 3. .gitignore
  const gi = await ensureGitignore(resolved, shared);
  switch (gi.action) {
    case "added":
      success(`Added ${c.cyan(".zipmem/")} to .gitignore (local memory).`);
      break;
    case "present":
      info(`${c.dim("•")} ${c.cyan(".zipmem/")} already in .gitignore.`);
      break;
    case "none":
      warn(
        `No .gitignore found. Add ${c.cyan(".zipmem/")} yourself to keep memory local, or re-run with ${c.cyan("--shared")} to commit it.`,
      );
      break;
    case "shared-skip":
      info(
        `${c.dim("•")} Shared mode: ${c.cyan(".zipmem/")} left tracked so you can commit memory.`,
      );
      break;
  }

  // 4. Next steps
  info("");
  info(c.bold("Next steps:"));
  info(`  Register the MCP server with Claude Code:`);
  info(`    ${c.cyan("claude mcp add zipmem-mcp -- npx zipmem-mcp")}`);
  info("");
  info(
    `  ${c.dim("Then start a new session — the agent will load memory automatically.")}`,
  );

  if (!existsSync(path.join(resolved, "package.json"))) {
    // purely informational; not an error
  }
}
