import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const server = spawn("node", ["server/index.mjs"], {
  cwd: root,
  stdio: "inherit",
  shell: true,
});

const tauri = spawn("node", ["scripts/run-tauri.mjs", "dev"], {
  cwd: root,
  stdio: "inherit",
  shell: true,
});

function shutdown() {
  server.kill();
  tauri.kill();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

server.on("exit", (code) => {
  if (code && code !== 0) shutdown();
});

tauri.on("exit", (code) => {
  if (code && code !== 0) shutdown();
});
