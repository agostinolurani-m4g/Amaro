import { amaroJson } from "./amaroAuth";
import { getDoc, getProfile, listCalendar, saveCalendarEntry, saveDoc, deleteCalendarEntry } from "../hooks/useStorage";
import { metricsFromPoints, plannedCompliance, storageSeries } from "./sessionEvaluation";
import { sportFromStrava } from "./sportTypes";
import type { CalendarEntry } from "../types";

export interface StravaSyncCursor {
  lastActivityStart: number;
  lastSyncAt: string;
  imported: number;
}

interface StravaListItem {
  id: number;
  name: string;
  sport_type?: string;
  type?: string;
  start_date?: string;
  start_date_local?: string;
  moving_time?: number;
  elapsed_time?: number;
  distance?: number;
  total_elevation_gain?: number;
  average_watts?: number;
  weighted_average_watts?: number;
  average_heartrate?: number;
  max_heartrate?: number;
  kilojoules?: number;
  suffer_score?: number;
  perceived_exertion?: number;
  trainer?: boolean;
  device_watts?: boolean;
  has_heartrate?: boolean;
  updated_at?: string;
}

interface ListResponse {
  activities: StravaListItem[];
  nearLimit?: boolean;
  note?: string;
}

interface DetailResponse {
  series?: { t: number; power?: number; hr?: number; cadence?: number }[];
  activity?: { perceived_exertion?: number };
}

function asInt(n: number | undefined | null): number | undefined {
  if (n == null || !Number.isFinite(n) || n <= 0) return undefined;
  return Math.round(n);
}

function startUnix(a: StravaListItem): number {
  const raw = a.start_date_local || a.start_date || "";
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : 0;
}

function activityDate(a: StravaListItem): string {
  return (a.start_date_local || a.start_date || "").slice(0, 10);
}

function durationOf(a: { durationSecs?: number; moving_time?: number; elapsed_time?: number }): number {
  return Math.round(a.durationSecs || a.moving_time || a.elapsed_time || 0);
}

/** Stessa uscita: stesso giorno e durata vicina, oppure stessa distanza. */
function sameOuting(
  entry: CalendarEntry,
  other: { date: string; durationSecs: number; distanceM?: number },
): boolean {
  if (entry.entryType === "planned" || entry.date !== other.date) return false;
  const dur = durationOf(entry);
  const durClose = other.durationSecs >= 8 * 60 && dur > 0 && Math.abs(dur - other.durationSecs) <= 8 * 60;
  const bothDist = (entry.distanceM ?? 0) > 500 && (other.distanceM ?? 0) > 500;
  if (bothDist) {
    const closeDist = Math.abs(entry.distanceM! - other.distanceM!) / other.distanceM! < 0.05;
    return closeDist && Math.abs(dur - other.durationSecs) <= 20 * 60;
  }
  return durClose;
}

function preferKeep(a: CalendarEntry, b: CalendarEntry): CalendarEntry {
  const score = (e: CalendarEntry) =>
    (e.entryType === "completed" ? 4 : 0) + (e.workoutId ? 2 : 0) + (e.series?.length ? 1 : 0);
  return score(a) >= score(b) ? a : b;
}

/** Toglie i doppioni già salvati e segna l'id Strava sulla sessione WattLab tenuta. */
export async function collapseStravaDuplicates(): Promise<number> {
  const calendar = await listCalendar().catch(() => [] as CalendarEntry[]);
  const drop = new Set<string>();
  const stamp = new Map<string, string>();

  const byExt = new Map<string, CalendarEntry[]>();
  for (const entry of calendar) {
    if (!entry.externalId) continue;
    const group = byExt.get(entry.externalId) ?? [];
    group.push(entry);
    byExt.set(entry.externalId, group);
  }
  for (const group of byExt.values()) {
    if (group.length < 2) continue;
    const keep = group.reduce(preferKeep);
    for (const entry of group) {
      if (entry.id !== keep.id) drop.add(entry.id);
    }
  }

  const alive = calendar.filter((entry) => !drop.has(entry.id));
  for (const entry of alive) {
    if (drop.has(entry.id) || entry.externalSource !== "strava") continue;
    const twin = alive.find(
      (other) => other.id !== entry.id && !drop.has(other.id) && sameOuting(other, {
        date: entry.date,
        durationSecs: entry.durationSecs ?? 0,
        distanceM: entry.distanceM,
      }),
    );
    if (!twin) continue;
    const keep = preferKeep(twin, entry);
    const lose = keep.id === entry.id ? twin : entry;
    if (lose.entryType === "completed" && keep.externalSource === "strava") continue;
    drop.add(lose.id);
    if (keep.entryType === "completed" && entry.externalId && !keep.externalId) {
      stamp.set(keep.id, entry.externalId);
    }
  }

  for (const id of drop) await deleteCalendarEntry(id);
  for (const [id, externalId] of stamp) {
    const entry = calendar.find((item) => item.id === id);
    if (!entry || drop.has(id)) continue;
    await saveCalendarEntry({ ...entry, externalSource: "strava", externalId });
  }
  return drop.size;
}

function isDuplicate(calendar: CalendarEntry[], a: StravaListItem): CalendarEntry | undefined {
  const date = activityDate(a);
  const durationSecs = durationOf(a);
  return calendar.find(
    (entry) =>
      entry.entryType !== "planned" &&
      sameOuting(entry, { date, durationSecs, distanceM: a.distance }),
  );
}

export async function syncStrava(opts?: {
  days?: number;
  force?: boolean;
  onProgress?: (msg: string) => void;
}): Promise<{ imported: number; note?: string }> {
  const days = Math.min(365, Math.max(7, opts?.days ?? 90));
  const cursor = await getDoc<StravaSyncCursor>("strava_sync");
  const after =
    !opts?.force && cursor?.lastActivityStart
      ? cursor.lastActivityStart - 2 * 86400
      : Math.floor(Date.now() / 1000) - days * 86400;
  if (opts?.force) {
    await amaroJson("/api/wattlab/strava/invalidate", { method: "POST", body: "{}" }).catch(() => undefined);
  }
  const calendar = await listCalendar().catch(() => [] as CalendarEntry[]);
  await collapseStravaDuplicates();
  const fresh = await listCalendar().catch(() => calendar);
  const profile = await getProfile().catch(() => null);
  const known = new Set(fresh.map((e) => e.externalId).filter(Boolean) as string[]);
  let page = 1;
  let imported = 0;
  let streams = 0;
  let newest = cursor?.lastActivityStart ?? 0;
  let note: string | undefined;
  while (page <= 12) {
    opts?.onProgress?.(`Strava: pagina ${page}…`);
    const res = await amaroJson<ListResponse>(
      `/api/wattlab/strava/activities?after=${after}&page=${page}${opts?.force && page === 1 ? "&force=1" : ""}`,
    );
    note = res.note;
    const list = res.activities ?? [];
    if (!list.length) break;
    for (const a of list) {
      const start = startUnix(a);
      if (start > newest) newest = start;
      const id = String(a.id);
      const date = activityDate(a);
      const twin = isDuplicate(fresh, a);
      if (known.has(id) || twin) {
        if (twin && twin.entryType === "completed" && !twin.externalId) {
          const stamped = await saveCalendarEntry({ ...twin, externalSource: "strava", externalId: id, sport: twin.sport });
          const idx = fresh.findIndex((entry) => entry.id === twin.id);
          if (idx >= 0) fresh[idx] = stamped;
          known.add(id);
        }
        continue;
      }
      let series: DetailResponse["series"];
      if (streams < 40 && (a.device_watts || a.has_heartrate)) {
        try {
          const detail = await amaroJson<DetailResponse>(
            `/api/wattlab/strava/activities/${id}?updatedAt=${encodeURIComponent(a.updated_at ?? "")}&movingTime=${a.moving_time ?? 0}`,
          );
          series = detail.series;
          streams += 1;
        } catch {
          series = undefined;
        }
      }
      const points = (series ?? []).map((p) => ({
        t: Math.round(p.t),
        power: asInt(p.power),
        hr: asInt(p.hr),
        cadence: asInt(p.cadence),
      }));
      const metrics = points.length && profile ? metricsFromPoints(points, profile) : null;
      const planned = fresh.find((e) => e.entryType === "planned" && e.date === date);
      const durationSecs = metrics?.durationSecs || a.moving_time || a.elapsed_time || 0;
      const entry: CalendarEntry = {
        id: "",
        date,
        entryType: "imported",
        title: a.name || "Attività Strava",
        sport: sportFromStrava(a.sport_type || a.type),
        externalSource: "strava",
        externalId: id,
        durationSecs: Math.round(durationSecs),
        distanceM: a.distance,
        elevationM: a.total_elevation_gain,
        avgPower: asInt(metrics?.avgPower ?? a.average_watts),
        maxPower: asInt(metrics?.maxPower),
        np: asInt(metrics?.np ?? a.weighted_average_watts),
        tss: metrics?.np ? metrics.tss : metrics?.tss || a.suffer_score || undefined,
        ifactor: metrics?.ifactor,
        kj: metrics?.kj ?? a.kilojoules,
        avgHr: asInt(metrics?.avgHr ?? a.average_heartrate),
        maxHr: asInt(metrics?.maxHr ?? a.max_heartrate),
        avgCadence: asInt(metrics?.avgCadence),
        decoupling: metrics?.decoupling ?? undefined,
        mmp: metrics?.mmp?.map((w) => Math.round(w)),
        zoneSecs: metrics?.zoneSecs?.map((s) => Math.round(s)),
        rpe: asInt(a.perceived_exertion),
        series: points.length ? storageSeries(points) : undefined,
        plannedEntryId: planned?.id,
        plannedTss: planned?.plannedTss,
        sessionType: planned?.sessionType,
        compliance: planned ? plannedCompliance({ durationSecs, tss: metrics?.tss }, planned) : undefined,
        notes: a.suffer_score ? `Strava · relativo sforzo ${a.suffer_score}` : "Strava",
      };
      const savedEntry = await saveCalendarEntry(entry);
      known.add(id);
      fresh.push(savedEntry);
      imported += 1;
    }
    if (list.length < 30 || res.nearLimit) break;
    page += 1;
  }
  const saved: StravaSyncCursor = {
    lastActivityStart: newest,
    lastSyncAt: new Date().toISOString(),
    imported: (cursor?.imported ?? 0) + imported,
  };
  await saveDoc("strava_sync", saved);
  await amaroJson("/api/wattlab/strava/synced", {
    method: "POST",
    body: JSON.stringify({ imported: saved.imported }),
  }).catch(() => undefined);
  return { imported, note };
}

export async function maybeAutoSync(): Promise<void> {
  const status = await amaroJson<{ connected: boolean; canRead: boolean }>("/api/wattlab/strava/status").catch(
    () => null,
  );
  if (!status?.connected || !status.canRead) return;
  await collapseStravaDuplicates().catch(() => undefined);
  const changes = await amaroJson<{ pending: boolean }>("/api/wattlab/strava/changes").catch(() => ({ pending: false }));
  const cursor = await getDoc<StravaSyncCursor>("strava_sync");
  const age = cursor?.lastSyncAt ? Date.now() - Date.parse(cursor.lastSyncAt) : Infinity;
  if (!changes.pending && age < 6 * 3600 * 1000) return;
  await syncStrava();
}
