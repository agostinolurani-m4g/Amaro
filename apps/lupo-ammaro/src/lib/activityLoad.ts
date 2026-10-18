import { entryTss } from "../../shared/engine/load.mjs";
import { saveCalendarEntry } from "../hooks/useStorage";
import type { CalendarEntry, UserProfile } from "../types";

export function sufferScore(entry: Pick<CalendarEntry, "notes">): number | undefined {
  const match = /relativo sforzo\s+(\d+)/.exec(entry.notes ?? "");
  if (!match) return undefined;
  const value = Number(match[1]);
  return value > 0 ? value : undefined;
}

/** TSS da mostrare: valore salvato, relativo sforzo Strava, poi stima del motore. */
export function activityTss(entry: CalendarEntry, profile?: UserProfile | null): number {
  if (entry.entryType === "planned") return Number(entry.plannedTss ?? entry.tss ?? 0) || 0;
  if (entry.np && entry.tss && entry.tss > 0) return entry.tss;
  const suffer = sufferScore(entry);
  if (suffer && !entry.np) return suffer;
  if (entry.tss && entry.tss > 0) return entry.tss;
  return entryTss(entry, profile?.ftpWatts ?? 0, profile?.lthr ?? 0, profile?.lthrRun ?? 0);
}

/** Scrive il relativo sforzo sulle uscite Strava che non hanno ancora un TSS. */
export async function persistStravaLoad(entries: CalendarEntry[]): Promise<CalendarEntry[]> {
  const out: CalendarEntry[] = [];
  for (const entry of entries) {
    const suffer = sufferScore(entry);
    if (entry.entryType !== "planned" && !(entry.tss && entry.tss > 0) && suffer && !entry.np) {
      out.push(await saveCalendarEntry({ ...entry, tss: suffer }));
    } else {
      out.push(entry);
    }
  }
  return out;
}
