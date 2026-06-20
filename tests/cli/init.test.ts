import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { init } from "../../src/cli/init.js";
import { status } from "../../src/cli/status.js";
import {
  DIRECTIVE_END,
  DIRECTIVE_START,
} from "../../src/core/directive.js";
import { resolveStatePath } from "../../src/utils/paths.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "zipmem-cli-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("zipmem init", () => {
  it("creates state and a CLAUDE.md with the directive", async () => {
    await init(dir);
    expect(existsSync(resolveStatePath(dir))).toBe(true);

    const claude = await readFile(path.join(dir, "CLAUDE.md"), "utf8");
    expect(claude).toContain(DIRECTIVE_START);
    expect(claude).toContain(DIRECTIVE_END);
    expect(claude).toContain("zipmem_load_memory");
  });

  it("appends to an existing CLAUDE.md without clobbering content", async () => {
    await writeFile(path.join(dir, "CLAUDE.md"), "# My project\n\nExisting notes.\n", "utf8");
    await init(dir);
    const claude = await readFile(path.join(dir, "CLAUDE.md"), "utf8");
    expect(claude).toContain("Existing notes.");
    expect(claude).toContain(DIRECTIVE_START);
  });

  it("is idempotent — running twice does not duplicate the directive", async () => {
    await init(dir);
    await init(dir);
    const claude = await readFile(path.join(dir, "CLAUDE.md"), "utf8");
    expect(countOccurrences(claude, DIRECTIVE_START)).toBe(1);
  });

  it("default mode adds .zipmem/ to an existing .gitignore", async () => {
    await writeFile(path.join(dir, ".gitignore"), "node_modules/\n", "utf8");
    await init(dir);
    const gi = await readFile(path.join(dir, ".gitignore"), "utf8");
    expect(gi).toContain(".zipmem/");
  });

  it("--shared leaves .gitignore untouched and marks state shared", async () => {
    await writeFile(path.join(dir, ".gitignore"), "node_modules/\n", "utf8");
    await init(dir, { shared: true });
    const gi = await readFile(path.join(dir, ".gitignore"), "utf8");
    expect(gi).not.toContain(".zipmem/");

    const state = JSON.parse(await readFile(resolveStatePath(dir), "utf8"));
    expect(state.meta.shared).toBe(true);
  });

  it("prefers memory.md when CLAUDE.md is absent", async () => {
    await writeFile(path.join(dir, "memory.md"), "# Memory\n", "utf8");
    await init(dir);
    expect(existsSync(path.join(dir, "CLAUDE.md"))).toBe(false);
    const mem = await readFile(path.join(dir, "memory.md"), "utf8");
    expect(mem).toContain(DIRECTIVE_START);
  });
});

describe("zipmem status", () => {
  it("runs without throwing after init", async () => {
    await init(dir);
    await expect(status(dir)).resolves.toBeUndefined();
  });
});
