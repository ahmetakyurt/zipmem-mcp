import path from "node:path";
import {
  HARD_LIMIT_BYTES,
  SOFT_LIMIT_BYTES,
  loadState,
  stateExists,
} from "../core/state.js";
import { c, info, warn } from "./helpers.js";

/**
 * `zipmem status` — print a human-readable summary of the project's memory:
 * counts, size vs. limits, last update, and shared flag.
 */
export async function status(projectDir: string): Promise<void> {
  const resolved = path.resolve(projectDir);

  if (!stateExists(resolved)) {
    warn(
      `No ZipMem memory found in ${c.dim(resolved)}. Run ${c.cyan("zipmem init")} to get started.`,
    );
    return;
  }

  const state = await loadState(resolved);
  const sizeKb = state.meta.state_size_bytes / 1024;
  const softKb = SOFT_LIMIT_BYTES / 1024;
  const hardKb = HARD_LIMIT_BYTES / 1024;

  let sizeLabel = `${sizeKb.toFixed(1)}KB`;
  if (state.meta.state_size_bytes > HARD_LIMIT_BYTES) {
    sizeLabel = c.yellow(`${sizeLabel} (over hard limit ${hardKb}KB — will auto-prune)`);
  } else if (state.meta.state_size_bytes > SOFT_LIMIT_BYTES) {
    sizeLabel = c.yellow(`${sizeLabel} (over soft limit ${softKb}KB)`);
  }

  info(c.bold(`ZipMem status — ${state.project_name}`));
  info("");
  info(`  Blueprints : ${c.cyan(String(state.blueprints.length))}`);
  info(`  Anchors    : ${c.cyan(String(state.anchors.length))}`);
  info(`  Lessons    : ${c.cyan(String(state.lessons.length))}`);
  info(`  Sessions   : ${c.cyan(String(state.meta.total_sessions))}`);
  info(`  Compactions: ${c.cyan(String(state.meta.total_compactions))}`);
  info("");
  info(`  Size       : ${sizeLabel}`);
  info(`  Mode       : ${state.meta.shared ? "shared (committed)" : "local (gitignored)"}`);
  info(`  Checkpoint : ${c.cyan(state.meta.checkpoint_mode)}`);
  info(`  Created    : ${c.dim(state.created_at)}`);
  info(`  Updated    : ${c.dim(state.updated_at)}`);
}
