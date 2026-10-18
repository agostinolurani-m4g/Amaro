import type { CalendarEntry, LifeBlock, Workout } from "../types";

function stamp(entry: { updatedAt?: string; createdAt?: string; date?: string }): string {
  return entry.updatedAt ?? entry.createdAt ?? (entry.date ? `${entry.date}T00:00:00.000Z` : "");
}

export function mergeCalendarEntries(a: CalendarEntry[], b: CalendarEntry[]): CalendarEntry[] {
  const map = new Map<string, CalendarEntry>();
  for (const e of [...a, ...b]) {
    if (!e.id) continue;
    const prev = map.get(e.id);
    if (!prev || stamp(e) >= stamp(prev)) map.set(e.id, e);
  }
  return [...map.values()].sort((x, y) => x.date.localeCompare(y.date));
}

export function mergeLifeBlocks(a: LifeBlock[], b: LifeBlock[]): LifeBlock[] {
  const map = new Map<string, LifeBlock>();
  for (const e of [...a, ...b]) {
    if (!e.id) continue;
    const prev = map.get(e.id);
    if (!prev || stamp(e) >= stamp(prev)) map.set(e.id, e);
  }
  return [...map.values()].sort((x, y) => (x.date ?? x.weekday ?? "").localeCompare(y.date ?? y.weekday ?? ""));
}

export function mergeWorkouts(a: Workout[], b: Workout[]): Workout[] {
  const map = new Map<string, Workout>();
  for (const e of [...a, ...b]) {
    if (!e.id) continue;
    const prev = map.get(e.id);
    if (!prev || stamp(e) >= stamp(prev)) map.set(e.id, e);
  }
  return [...map.values()];
}

export function mergeCheckins<T extends { date: string }>(a: T[], b: T[]): T[] {
  const map = new Map<string, T>();
  for (const e of [...a, ...b]) {
    map.set(e.date, e);
  }
  return [...map.values()].sort((x, y) => x.date.localeCompare(y.date)).slice(-90);
}

export function mergeChatMessages<T>(a: T[], b: T[]): T[] {
  const list = [...a, ...b];
  return list.slice(-30);
}

export interface SyncBundle {
  calendar: CalendarEntry[];
  lifeBlocks: LifeBlock[];
  chat: unknown[];
  checkins: unknown[];
  athleteSettings: unknown | null;
  profile: unknown | null;
  workouts: Workout[];
  serverTime?: string;
}

export function mergeSyncBundles(local: SyncBundle, remote: SyncBundle): SyncBundle {
  return {
    calendar: mergeCalendarEntries(local.calendar ?? [], remote.calendar ?? []),
    lifeBlocks: mergeLifeBlocks(local.lifeBlocks ?? [], remote.lifeBlocks ?? []),
    chat: mergeChatMessages(local.chat ?? [], remote.chat ?? []),
    checkins: mergeCheckins(
      (local.checkins ?? []) as { date: string }[],
      (remote.checkins ?? []) as { date: string }[],
    ),
    athleteSettings: pickNewer(local.athleteSettings, remote.athleteSettings),
    profile: pickNewer(local.profile, remote.profile),
    workouts: mergeWorkouts(local.workouts ?? [], remote.workouts ?? []),
    serverTime: remote.serverTime ?? local.serverTime,
  };
}

function pickNewer(a: unknown, b: unknown): unknown {
  if (!b) return a ?? null;
  if (!a) return b;
  const ta = (a as { updatedAt?: string }).updatedAt ?? "";
  const tb = (b as { updatedAt?: string }).updatedAt ?? "";
  return tb >= ta ? b : a;
}
