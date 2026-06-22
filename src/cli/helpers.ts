import { existsSync } from "node:fs";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  DIRECTIVE_END,
  DIRECTIVE_START,
  getDirective,
} from "../core/directive.js";
import type { CheckpointMode } from "../core/schema.js";

/* Minimal ANSI styling — no dependency. Disabled when NO_COLOR is set. */
const useColor = !process.env.NO_COLOR && process.stdout.isTTY;
const wrap = (code: string, s: string): string =>
  useColor ? `[${code}m${s}[0m` : s;

export const c = {
  bold: (s: string): string => wrap("1", s),
  dim: (s: string): string => wrap("2", s),
  green: (s: string): string => wrap("32", s),
  yellow: (s: string): string => wrap("33", s),
  cyan: (s: string): string => wrap("36", s),
};

export function info(msg: string): void {
  console.log(msg);
}
export function success(msg: string): void {
  console.log(`${c.green("✓")} ${msg}`);
}
export function warn(msg: string): void {
  console.log(`${c.yellow("!")} ${msg}`);
}

/** Infer a project name from package.json#name, else the directory name. */
export async function inferProjectName(projectDir: string): Promise<string> {
  const pkgPath = path.join(projectDir, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(await readFile(pkgPath, "utf8")) as {
        name?: string;
      };
      if (pkg.name && pkg.name.trim()) return pkg.name.trim();
    } catch {
      // ignore malformed package.json
    }
  }
  return path.basename(path.resolve(projectDir));
}

/**
 * Write `.zipmem/.gitignore` so runtime artifacts (the ephemeral session
 * buffer, temp files) are never committed — even in --shared mode, where the
 * outer .gitignore intentionally tracks `.zipmem/` to share `state.json`.
 */
export async function writeInternalGitignore(zipmemDir: string): Promise<void> {
  const giPath = path.join(zipmemDir, ".gitignore");
  if (existsSync(giPath)) return;
  await writeFile(giPath, "session.json\n*.tmp\n", "utf8");
}

export type DirectiveResult =
  | { action: "created"; file: string }
  | { action: "appended"; file: string }
  | { action: "updated"; file: string }
  | { action: "skipped"; file: string };

/**
 * Inject (or refresh) the Constitutional Directive into the project's agent
 * config file for the given checkpoint mode. Preference: existing CLAUDE.md >
 * existing memory.md > create CLAUDE.md. Never overwrites surrounding content;
 * idempotent via the zipmem:start / zipmem:end markers — a stale block (old
 * version or a different checkpoint mode) is replaced in place.
 */
export async function injectDirective(
  projectDir: string,
  mode: CheckpointMode,
): Promise<DirectiveResult> {
  const directive = getDirective(mode);
  const claudePath = path.join(projectDir, "CLAUDE.md");
  const memoryPath = path.join(projectDir, "memory.md");

  const target = existsSync(claudePath)
    ? claudePath
    : existsSync(memoryPath)
      ? memoryPath
      : claudePath;

  if (!existsSync(target)) {
    await writeFile(target, `${directive}\n`, "utf8");
    return { action: "created", file: target };
  }

  const current = await readFile(target, "utf8");
  const startIdx = current.indexOf(DIRECTIVE_START);
  const endIdx = current.indexOf(DIRECTIVE_END);

  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    const before = current.slice(0, startIdx);
    const after = current.slice(endIdx + DIRECTIVE_END.length);
    const existingBlock = current.slice(startIdx, endIdx + DIRECTIVE_END.length);
    if (existingBlock === directive) {
      return { action: "skipped", file: target };
    }
    // Replace the stale block in place, preserving everything around it.
    await writeFile(target, `${before}${directive}${after}`, "utf8");
    return { action: "updated", file: target };
  }

  const sep = current.endsWith("\n") ? "\n" : "\n\n";
  await appendFile(target, `${sep}${directive}\n`, "utf8");
  return { action: "appended", file: target };
}

export type GitignoreResult =
  | { action: "added"; file: string }
  | { action: "created"; file: string }
  | { action: "present"; file: string }
  | { action: "none" }
  | { action: "shared-skip" };

const IGNORE_LINE = ".zipmem/";

/**
 * Ensure `.zipmem/` is git-ignored for local (non-shared) memory. For shared
 * memory we leave .gitignore untouched (the state file is meant to be committed).
 */
export async function ensureGitignore(
  projectDir: string,
  shared: boolean,
): Promise<GitignoreResult> {
  if (shared) return { action: "shared-skip" };

  const gitignorePath = path.join(projectDir, ".gitignore");
  if (!existsSync(gitignorePath)) {
    // Only create a .gitignore when this is actually a git repo — otherwise
    // there is nothing to ignore and leaving a stray file would be presumptuous.
    if (existsSync(path.join(projectDir, ".git"))) {
      await writeFile(
        gitignorePath,
        `# zipmem local memory\n${IGNORE_LINE}\n`,
        "utf8",
      );
      return { action: "created", file: gitignorePath };
    }
    return { action: "none" };
  }

  const content = await readFile(gitignorePath, "utf8");
  const lines = content.split(/\r?\n/).map((l) => l.trim());
  if (lines.includes(IGNORE_LINE) || lines.includes(".zipmem")) {
    return { action: "present", file: gitignorePath };
  }

  const sep = content.endsWith("\n") ? "" : "\n";
  await appendFile(
    gitignorePath,
    `${sep}\n# zipmem local memory\n${IGNORE_LINE}\n`,
    "utf8",
  );
  return { action: "added", file: gitignorePath };
}
