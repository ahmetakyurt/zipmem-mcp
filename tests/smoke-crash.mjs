// Ad-hoc end-to-end crash test (not part of vitest): spawn the built server,
// stage a checkpoint over MCP, then abruptly drop the parent's stdin pipe (the
// "terminal closed / parent vanished" path). Verify state.json was flushed and
// a follow-up server surfaces the recovery banner.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const serverPath = path.join(root, "dist", "index.js");
const projectDir = mkdtempSync(path.join(tmpdir(), "zipmem-crash-"));

function makeClient(child) {
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
  let id = 1;
  return {
    rpc: (method, params) =>
      new Promise((res) => {
        const myId = id++;
        pending.set(myId, res);
        child.stdin.write(
          JSON.stringify({ jsonrpc: "2.0", id: myId, method, params }) + "\n",
        );
      }),
    notify: (method, params) =>
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n"),
  };
}

function spawnServer() {
  return spawn(process.execPath, [serverPath], {
    stdio: ["pipe", "pipe", "inherit"],
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
  });
}

async function handshake(c) {
  await c.rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "crash-smoke", version: "0" },
  });
  c.notify("notifications/initialized", {});
}

try {
  // ---- Session 1: checkpoint, then hard-exit (no save_and_compact) ----
  const child1 = spawnServer();
  const c1 = makeClient(child1);
  await handshake(c1);

  const cp = await c1.rpc("tools/call", {
    name: "zipmem_checkpoint",
    arguments: {
      summary: "half-finished feature",
      anchors: [
        { file_path: "src/feature.ts", line_range: "10-40", concept: "WIP handler" },
      ],
      lessons: [{ summary: "remember to debounce", detail: "", related_files: [] }],
    },
  });
  console.log("checkpoint ->", cp.result.content[0].text);

  const exited = new Promise((r) => child1.once("exit", r));
  // Simulate the parent (claude) vanishing: drop the stdin pipe.
  child1.stdin.end();
  await exited;
  console.log("server 1 exited after stdin drop");

  const statePath = path.join(projectDir, ".zipmem", "state.json");
  const sessionPath = path.join(projectDir, ".zipmem", "session.json");
  // state.json may not exist yet — the minimal handler never writes it; only
  // the next-startup recovery (or a clean compaction) creates it.
  const readState = () =>
    existsSync(statePath)
      ? JSON.parse(readFileSync(statePath, "utf8"))
      : { anchors: [], lessons: [], blueprints: [] };
  const state1 = readState();
  const session1 = JSON.parse(readFileSync(sessionPath, "utf8"));

  console.log(
    `after hard exit -> state.anchors=${state1.anchors.length} (expect 0, handler is minimal)`,
  );
  console.log(
    `session -> status=${session1.status} reason=${session1.reason} pending.anchors=${session1.pending.anchors.length}`,
  );

  // Minimal handler: state.json untouched, session marked interrupted, pending preserved.
  const ok1 =
    state1.anchors.length === 0 &&
    session1.status === "interrupted" &&
    session1.pending.anchors.length === 1 &&
    session1.pending.lessons.length === 1;
  if (!ok1)
    throw new Error(
      "FAIL: handler should mark interrupted and preserve pending without folding",
    );

  // ---- Session 2: startup recovery folds pending; load surfaces the banner ----
  const child2 = spawnServer();
  const c2 = makeClient(child2);
  await handshake(c2);
  const load = await c2.rpc("tools/call", {
    name: "zipmem_load_memory",
    arguments: {},
  });
  const text = load.result.content[0].text;
  console.log("\n--- load_memory (session 2) ---\n" + text);
  child2.stdin.end();

  const state2 = readState();
  console.log(
    `after recovery -> state.anchors=${state2.anchors.length} lessons=${state2.lessons.length}`,
  );

  const ok2 =
    text.includes("ZipMem recovery") &&
    text.includes("src/feature.ts") &&
    state2.anchors.length === 1 &&
    state2.lessons.length === 1;
  if (!ok2)
    throw new Error("FAIL: next-session recovery did not fold pending / surface banner");

  console.log(
    "\nPASS: minimal interrupt marker + next-session recovery fold verified.",
  );
} finally {
  if (existsSync(projectDir)) rmSync(projectDir, { recursive: true, force: true });
}
process.exit(0);
