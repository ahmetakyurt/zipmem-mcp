import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    // dist/coverage are generated; smoke-mcp.mjs is a standalone manual runner.
    ignores: ["dist/**", "node_modules/**", "coverage/**", "tests/smoke-mcp.mjs"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },
  {
    // The MCP server must never write to stdout (it corrupts the stdio JSON-RPC
    // framing). Diagnostics belong on stderr. CLI files are exempt.
    files: ["src/server/**/*.ts", "src/index.ts"],
    rules: {
      "no-console": ["error", { allow: ["error", "warn"] }],
    },
  },
);
