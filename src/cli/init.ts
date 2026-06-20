import { existsSync } from "node:fs";
import path from "node:path";
import { createEmptyState, saveState, stateExists } from "../core/state.js";
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

  // 1. State file
  if (stateExists(resolved)) {
    warn(
      `State already exists at ${c.dim(resolveStatePath(resolved))} — left untouched.`,
    );
  } else {
    const projectName = await inferProjectName(resolved);
    const state = createEmptyState(projectName, shared);
    await saveState(resolved, state);
    await writeInternalGitignore(resolveZipmemDir(resolved));
    success(
      `Created ${c.cyan(".zipmem/state.json")} for project ${c.bold(projectName)}${
        shared ? c.dim(" (shared)") : ""
      }.`,
    );
  }

  // 2. Constitutional Directive
  const dir = await injectDirective(resolved);
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
