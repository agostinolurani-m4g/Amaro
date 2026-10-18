import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const env = { ...process.env, VITE_APP_BASE: "/lupo/" };
const outDir = join(root, "..", "web", "app", "static", "lupo");

function run(args) {
  const result = spawnSync("npx", args, {
    cwd: root,
    env,
    stdio: "inherit",
    shell: true,
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run(["tsc", "--noEmit"]);
run(["vite", "build", "--outDir", outDir, "--emptyOutDir"]);
