#!/usr/bin/env node
/**
 * Ensures Cargo is on PATH, then runs the Tauri CLI.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cargoBin = join(homedir(), ".cargo", "bin");
const vsTools = join(root, ".tools", "vsbuild");
const pathKey = process.platform === "win32" ? "Path" : "PATH";
const pathSep = process.platform === "win32" ? ";" : ":";

function findMsvcLinkDir() {
  if (process.platform !== "win32") return null;

  const bases = [
    join(vsTools, "VC", "Tools", "MSVC"),
    "C:\\Program Files\\Microsoft Visual Studio\\2022\\BuildTools\\VC\\Tools\\MSVC",
    "C:\\Program Files (x86)\\Microsoft Visual Studio\\2019\\BuildTools\\VC\\Tools\\MSVC",
  ];

  for (const base of bases) {
    if (!existsSync(base)) continue;
    for (const ver of readdirSync(base)) {
      const linkDir = join(base, ver, "bin", "Hostx64", "x64");
      if (existsSync(join(linkDir, "link.exe"))) return linkDir;
    }
  }
  return null;
}

const pathEntries = [cargoBin];
const msvcLinkDir = findMsvcLinkDir();
if (msvcLinkDir) pathEntries.push(msvcLinkDir);

const env = {
  ...process.env,
  [pathKey]: [...pathEntries, process.env[pathKey] ?? ""].join(pathSep),
};

function hasCargo() {
  const cargo = process.platform === "win32" ? "cargo.exe" : "cargo";
  return spawnSync(cargo, ["--version"], { env, shell: true }).status === 0;
}

function hasLinker() {
  if (process.platform !== "win32") return true;
  return spawnSync("where", ["link.exe"], { env, shell: true }).status === 0;
}

function freeDevPort(port = 1420) {
  if (process.platform !== "win32") return;
  spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      `$c = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess; if ($c) { Stop-Process -Id $c -Force -ErrorAction SilentlyContinue }`,
    ],
    { stdio: "ignore", shell: false },
  );
}

if (!hasCargo()) {
  console.error("Cargo non trovato. Installa Rust da https://rustup.rs e riavvia il terminale.");
  process.exit(1);
}

if (!hasLinker()) {
  console.error(`
Linker MSVC (link.exe) mancante. Tauri su Windows richiede Visual C++ Build Tools.

Esegui UNA volta (accetta UAC se compare):
  powershell -ExecutionPolicy Bypass -File scripts/setup-windows.ps1

Poi riavvia il terminale e lancia:
  npm run tauri:dev
`);
  process.exit(1);
}

const args = process.argv.slice(2);
if (args[0] === "dev") {
  freeDevPort(1420);
}

const result = spawnSync("npx", ["tauri", ...args], {
  stdio: "inherit",
  env,
  shell: true,
});

process.exit(result.status ?? 1);
