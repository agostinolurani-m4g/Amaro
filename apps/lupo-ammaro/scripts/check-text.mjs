import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dirs = ["src", "server", "shared", "src-tauri/src"];
const exts = new Set([".ts", ".tsx", ".mjs", ".md", ".rs", ".css", ".json"]);

const mojibake = /\u00c3[\u00a0-\u00bf]|â€|\u00c2[^\s]|\uFFFD/;
const badMultiply = /\d\?\d/;

let issues = 0;

function walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) {
      if (name === "node_modules" || name === "dist" || name === ".tools") continue;
      walk(full);
      continue;
    }
    const ext = path.extname(name);
    if (!exts.has(ext)) continue;
    const text = fs.readFileSync(full, "utf8");
    const rel = path.relative(root, full);
    if (mojibake.test(text)) {
      console.error(`[mojibake] ${rel}`);
      issues++;
    }
    if (badMultiply.test(text) && !rel.includes("check-text")) {
      console.error(`[digit?digit] ${rel}`);
      issues++;
    }
  }
}

for (const d of dirs) walk(path.join(root, d));

if (issues > 0) {
  console.error(`\n${issues} problema/i di testo trovati.`);
  process.exit(1);
}
console.log("check:text OK");
