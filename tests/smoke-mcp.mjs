// Ad-hoc stdio smoke test: spawn the built server, run the MCP handshake,
// list tools, then exercise save -> load. Not part of the vitest suite.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const serverPath = path.join(root, "dist", "index.js");
const projectDir = process.argv[2] ?? process.cwd();

const child = spawn(process.execPath, [serverPath], {
  stdio: ["pipe", "pipe", "inherit"],
  env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
});

let buf = "";
const pending = new Map();
child.stdout.on("data", (d) => {
  buf += d.toString();
  let nl;
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});

let nextId = 1;
function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}
function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}

const init = await rpc("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "smoke", version: "0" },
});
console.log("initialize ->", init.result.serverInfo);
notify("notifications/initialized", {});

const tools = await rpc("tools/list", {});
console.log("tools ->", tools.result.tools.map((t) => t.name).join(", "));

const save = await rpc("tools/call", {
  name: "zipmem_save_and_compact",
  arguments: {
    session_summary: "Smoke session",
    blueprints: [{ category: "decision", title: "Transport", content: "stdio JSON-RPC" }],
    anchors: [{ file_path: "src/index.ts", line_range: "1-30", concept: "server bootstrap" }],
  },
});
console.log("save ->", save.result.content[0].text);

const load = await rpc("tools/call", {
  name: "zipmem_load_memory",
  arguments: {},
});
console.log("load ->\n" + load.result.content[0].text);

child.stdin.end();
child.kill();
process.exit(0);
