import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Read this package's version from its package.json at runtime, so the version
 * string is never hardcoded in two places. Walks up from the compiled module
 * location (dist/utils/ -> package root) to find the manifest.
 */
export function getVersion(): string {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    let dir = here;
    for (;;) {
      const candidate = path.join(dir, "package.json");
      if (existsSync(candidate)) {
        const pkg = JSON.parse(readFileSync(candidate, "utf8")) as {
          name?: string;
          version?: string;
        };
        if (pkg.name === "zipmem-mcp" && pkg.version) return pkg.version;
        // Keep walking if we hit some other package.json first.
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // fall through
  }
  return "0.0.0";
}
