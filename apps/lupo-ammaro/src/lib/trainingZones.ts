import type { SessionSeriesPoint, ZoneShare } from "../types";
import { COGGAN_ZONES as ENGINE_COGGAN, normalizedPower as npFrom1Hz, resample1Hz } from "../../shared/engine/load.mjs";

export const COGGAN_ZONES = ENGINE_COGGAN;

export const HR_ZONES = [
  { id: "hr1", label: "FC1 Recupero", minPct: 0, maxPct: 60, color: "#8a93a8" },
  { id: "hr2", label: "FC2 Aerobica", minPct: 60, maxPct: 70, color: "#60a5fa" },
  { id: "hr3", label: "FC3 Tempo", minPct: 70, maxPct: 80, color: "#4ade80" },
  { id: "hr4", label: "FC4 Soglia", minPct: 80, maxPct: 90, color: "#facc15" },
  { id: "hr5", label: "FC5 VO2", minPct: 90, maxPct: 110, color: "#ff0a54" },
] as const;

function bucketShares(
  zones: readonly { id: string; label: string; minPct: number; maxPct: number; color: string }[],
  seconds: number[],
): ZoneShare[] {
  const total = seconds.reduce((s, n) => s + n, 0);
  return zones.map((z, i) => ({
    id: z.id,
    label: z.label,
    range: z.maxPct >= 400 ? `>${z.minPct}%` : `${z.minPct}–${z.maxPct}%`,
    seconds: seconds[i] ?? 0,
    percent: total > 0 ? Math.round(((seconds[i] ?? 0) / total) * 1000) / 10 : 0,
    color: z.color,
  }));
}

function shares(
  values: number[],
  ref: number,
  zones: readonly { id: string; label: string; minPct: number; maxPct: number; color: string }[],
): ZoneShare[] {
  const seconds = zones.map(() => 0);
  if (!ref) return bucketShares(zones, seconds);
  for (const v of values) {
    if (v <= 0) continue;
    const pct = (v / ref) * 100;
    const idx = zones.findIndex((z) => pct >= z.minPct && pct < z.maxPct);
    seconds[idx >= 0 ? idx : zones.length - 1] += 1;
  }
  return bucketShares(zones, seconds);
}

export function powerZoneShares(series: SessionSeriesPoint[], ftp: number): ZoneShare[] {
  return shares(resample1Hz(series).power, ftp, COGGAN_ZONES);
}

export function zoneSharesFromSeconds(zoneSecs: number[]): ZoneShare[] {
  return bucketShares(COGGAN_ZONES, COGGAN_ZONES.map((_, i) => zoneSecs[i] ?? 0));
}

export function hrZoneShares(series: SessionSeriesPoint[], hrMax: number): ZoneShare[] {
  return shares(resample1Hz(series).hr, hrMax, HR_ZONES);
}

export function estimateHrMax(seriesList: SessionSeriesPoint[][], profileHrMax?: number): number {
  if (profileHrMax && profileHrMax > 120) return profileHrMax;
  let peak = 0;
  for (const series of seriesList) {
    for (const p of series) {
      if ((p.hr ?? 0) > peak) peak = p.hr ?? 0;
    }
  }
  if (peak < 120) return 0;
  return Math.round(peak * 1.03);
}

/** NP su serie ricampionata a 1 Hz (finestra 30 s reali). */
export function normalizedPower(series: SessionSeriesPoint[]): number {
  return npFrom1Hz(resample1Hz(series).power);
}

export function intensityFactor(np: number, ftp: number): number {
  if (!ftp || !np) return 0;
  return Math.round((np / ftp) * 100) / 100;
}

export function estimateTssFromIf(durationSecs: number, ifactor: number): number {
  if (durationSecs <= 0 || ifactor <= 0) return 0;
  return Math.round((durationSecs / 3600) * ifactor * ifactor * 100);
}
