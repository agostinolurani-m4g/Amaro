// Cache su disco per le chiamate Strava (limite 100/15 min, 1000/giorno).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "strava_cache");
const LIST_TTL_MS = 10 * 60 * 1000;
const PROFILE_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_ACTIVITIES = 300;

const inflight = new Map();

function dirOf(memberId) {
  const dir = path.join(ROOT, String(memberId));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value));
}

/** Dedup: una sola richiesta in corso per chiave. */
export function once(key, fn) {
  const existing = inflight.get(key);
  if (existing) return existing;
  const p = Promise.resolve()
    .then(fn)
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

export function readList(memberId, key, { maxAgeMs = LIST_TTL_MS, force = false } = {}) {
  if (force) return null;
  const row = readJson(path.join(dirOf(memberId), `list_${key}.json`));
  if (!row || Date.now() - row.savedAt > maxAgeMs) return null;
  return row.data;
}

export function writeList(memberId, key, data) {
  writeJson(path.join(dirOf(memberId), `list_${key}.json`), { savedAt: Date.now(), data });
}

export function invalidateLists(memberId) {
  const dir = dirOf(memberId);
  for (const name of fs.readdirSync(dir)) {
    if (name.startsWith("list_") || name.startsWith("profile_")) fs.unlinkSync(path.join(dir, name));
  }
}

export function readProfile(memberId, key, { force = false } = {}) {
  if (force) return null;
  const row = readJson(path.join(dirOf(memberId), `profile_${key}.json`));
  if (!row || Date.now() - row.savedAt > PROFILE_TTL_MS) return null;
  return row.data;
}

export function writeProfile(memberId, key, data) {
  writeJson(path.join(dirOf(memberId), `profile_${key}.json`), { savedAt: Date.now(), data });
}

/** Dettaglio attività immutabile finché updatedAt/movingTime non cambiano. */
export function readActivity(memberId, id, stamp) {
  const row = readJson(path.join(dirOf(memberId), `activity_${id}.json`));
  if (!row) return null;
  if (stamp && row.stamp && row.stamp !== stamp) return null;
  row.lastAccess = Date.now();
  writeJson(path.join(dirOf(memberId), `activity_${id}.json`), row);
  return row.data;
}

export function writeActivity(memberId, id, stamp, data) {
  writeJson(path.join(dirOf(memberId), `activity_${id}.json`), {
    stamp: stamp ?? "",
    lastAccess: Date.now(),
    data,
  });
  pruneActivities(memberId);
}

function pruneActivities(memberId) {
  const dir = dirOf(memberId);
  const files = fs
    .readdirSync(dir)
    .filter((n) => n.startsWith("activity_"))
    .map((n) => {
      const full = path.join(dir, n);
      const row = readJson(full);
      return { full, at: row?.lastAccess ?? 0 };
    })
    .sort((a, b) => a.at - b.at);
  while (files.length > MAX_ACTIVITIES) {
    const old = files.shift();
    if (old) fs.unlinkSync(old.full);
  }
}

export function pruneAll() {
  if (!fs.existsSync(ROOT)) return;
  for (const member of fs.readdirSync(ROOT)) pruneActivities(member);
}

const changes = new Map();

export function markChanges(athleteId) {
  changes.set(String(athleteId), Date.now());
}

export function takeChanges(athleteId) {
  const key = String(athleteId);
  const at = changes.get(key) ?? null;
  changes.delete(key);
  return at;
}
