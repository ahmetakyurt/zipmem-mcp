import { existsSync } from "node:fs";
import path from "node:path";

export const ZIPMEM_DIR = ".zipmem";
export const STATE_FILE = "state.json";

/**
 * Resolve the project root the tool should operate on, in priority order:
 *  1. an explicit path argument (from a tool/CLI parameter),
 *  2. `CLAUDE_PROJECT_DIR` (set by Claude Code when it spawns the stdio server),
 *  3. git-style upward search for an existing `.zipmem/` directory,
 *  4. the current working directory.
 */
export function resolveProjectDir(explicit?: string): string {
  if (explicit && explicit.trim()) return path.resolve(explicit.trim());

  const envDir = process.env.CLAUDE_PROJECT_DIR;
  if (envDir && envDir.trim()) return path.resolve(envDir.trim());

  const discovered = findZipmemRoot(process.cwd());
  if (discovered) return discovered;

  return process.cwd();
}

/** Walk upward from `start` looking for a directory that contains `.zipmem/`. */
export function findZipmemRoot(start: string): string | null {
  let dir = path.resolve(start);
  // Bound the walk by the filesystem root.
  for (;;) {
    if (existsSync(path.join(dir, ZIPMEM_DIR))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function resolveZipmemDir(projectDir: string): string {
  return path.join(projectDir, ZIPMEM_DIR);
}

export function resolveStatePath(projectDir: string): string {
  return path.join(resolveZipmemDir(projectDir), STATE_FILE);
}
