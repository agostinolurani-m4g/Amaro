import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const wattlabRoot = path.resolve(__dirname, "..", "..", "wattlab");
const targetDir = path.resolve(__dirname, "..", "apps", "web", "releases", "wattlab");

function listInstallers(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.startsWith("WattLab_") && /\.(exe|msi)$/i.test(name))
    .map((name) => path.join(dir, name));
}

function bundleDirs() {
  const dirs = [];
  const pushBundle = (targetRoot) => {
    for (const profile of ["release", "debug"]) {
      dirs.push(path.join(targetRoot, profile, "bundle"));
    }
  };

  pushBundle(path.join(wattlabRoot, "src-tauri", "target"));

  if (process.env.CARGO_TARGET_DIR) {
    pushBundle(process.env.CARGO_TARGET_DIR);
  }

  const sandboxRoot = path.join(os.tmpdir(), "cursor-sandbox-cache");
  if (fs.existsSync(sandboxRoot)) {
    for (const entry of fs.readdirSync(sandboxRoot)) {
      pushBundle(path.join(sandboxRoot, entry, "cargo-target"));
    }
  }

  return dirs;
}

function findInstaller() {
  const files = [];
  for (const bundleRoot of bundleDirs()) {
    for (const subdir of ["nsis", "msi"]) {
      files.push(...listInstallers(path.join(bundleRoot, subdir)));
    }
  }

  if (files.length === 0) return null;
  files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return files[0];
}

const source = findInstaller();
if (!source) {
  console.error("Installer WattLab non trovato.");
  console.error("1. In wattlab: npm run tauri:build:clean");
  console.error("2. Poi rilancia questo script.");
  process.exit(1);
}

if (!fs.existsSync(targetDir)) {
  fs.mkdirSync(targetDir, { recursive: true });
}

const target = path.join(targetDir, path.basename(source));
fs.copyFileSync(source, target);
console.log(`Copiato in ${target}`);
