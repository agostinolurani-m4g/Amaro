import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SYNC_DIR = path.resolve(process.env.WATTLAB_SYNC_DIR ?? path.join(__dirname, "sync_data"));

function memberDir(memberId) {
  const dir = path.join(SYNC_DIR, String(memberId));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function readJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

function docPath(memberId, name) {
  return path.join(memberDir(memberId), name);
}

function entryStamp(entry) {
  const t = entry?.updatedAt ?? entry?.createdAt;
  if (t) return String(t);
  return entry?.date ? `${entry.date}T00:00:00.000Z` : "";
}

function mergeById(local, remote) {
  const map = new Map();
  for (const item of [...(Array.isArray(local) ? local : []), ...(Array.isArray(remote) ? remote : [])]) {
    if (!item?.id) continue;
    const prev = map.get(item.id);
    if (!prev) {
      map.set(item.id, item);
      continue;
    }
    if (entryStamp(item) >= entryStamp(prev)) map.set(item.id, item);
  }
  return [...map.values()];
}

export function getMemberSync(memberId) {
  const dir = memberDir(memberId);
  return {
    calendar: readJson(path.join(dir, "calendar.json"), []),
    lifeBlocks: readJson(path.join(dir, "life_blocks.json"), []),
    chat: readJson(path.join(dir, "chat.json"), []),
    checkins: readJson(path.join(dir, "checkins.json"), []),
    athleteSettings: readJson(path.join(dir, "athlete_settings.json"), null),
    profile: readJson(path.join(dir, "profile.json"), null),
    workouts: readJson(path.join(dir, "workouts.json"), []),
    serverTime: new Date().toISOString(),
  };
}

export function mergeMemberSync(memberId, incoming) {
  const current = getMemberSync(memberId);
  const next = {
    calendar: mergeById(current.calendar, incoming.calendar ?? []),
    lifeBlocks: mergeById(current.lifeBlocks, incoming.lifeBlocks ?? []),
    chat: mergeChat(current.chat, incoming.chat ?? []),
    checkins: mergeById(current.checkins, incoming.checkins ?? []),
    athleteSettings: pickNewerDoc(current.athleteSettings, incoming.athleteSettings),
    profile: pickNewerDoc(current.profile, incoming.profile),
    workouts: mergeById(current.workouts, incoming.workouts ?? []),
  };

  const dir = memberDir(memberId);
  writeJson(path.join(dir, "calendar.json"), next.calendar);
  writeJson(path.join(dir, "life_blocks.json"), next.lifeBlocks);
  writeJson(path.join(dir, "chat.json"), next.chat);
  writeJson(path.join(dir, "checkins.json"), next.checkins);
  if (next.athleteSettings) writeJson(path.join(dir, "athlete_settings.json"), next.athleteSettings);
  if (next.profile) writeJson(path.join(dir, "profile.json"), next.profile);
  writeJson(path.join(dir, "workouts.json"), next.workouts);

  return { ...next, serverTime: new Date().toISOString() };
}

function mergeChat(a, b) {
  const list = [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])];
  if (list.length === 0) return [];
  return list.slice(-30);
}

function pickNewerDoc(a, b) {
  if (!b) return a ?? null;
  if (!a) return b;
  const ta = a.updatedAt ?? a.generatedAt ?? "";
  const tb = b.updatedAt ?? b.generatedAt ?? "";
  return tb >= ta ? b : a;
}
