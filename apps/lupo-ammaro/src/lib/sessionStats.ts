import type {
  PersonalRecordHit,
  PersonalRecords,
  PowerWindowBest,
  SessionSample,
  SessionStats,
  SessionSummary,
} from "../types";

export const POWER_WINDOWS: { windowSecs: number; label: string }[] = [
  { windowSecs: 5, label: "5 s" },
  { windowSecs: 10, label: "10 s" },
  { windowSecs: 30, label: "30 s" },
  { windowSecs: 60, label: "1 min" },
  { windowSecs: 120, label: "2 min" },
  { windowSecs: 300, label: "5 min" },
  { windowSecs: 600, label: "10 min" },
  { windowSecs: 1200, label: "20 min" },
];

function resamplePower1Hz(samples: SessionSample[]): number[] {
  if (samples.length === 0) return [];
  const start = samples[0].timestampMs;
  const end = samples[samples.length - 1].timestampMs;
  const duration = Math.max(0, Math.floor((end - start) / 1000));
  const series = new Array<number>(duration + 1).fill(0);
  let i = 0;
  let lastPower = 0;
  for (let t = 0; t <= duration; t++) {
    const target = start + t * 1000;
    while (i + 1 < samples.length && samples[i + 1].timestampMs <= target) {
      i += 1;
    }
    lastPower = samples[i].power ?? lastPower;
    const stale = target - samples[i].timestampMs > 3000;
    series[t] = stale ? 0 : lastPower;
  }
  return series;
}

function meanMaxWatts(series: number[], windowSecs: number): number | undefined {
  if (series.length < windowSecs || windowSecs <= 0) return undefined;
  let sum = 0;
  for (let i = 0; i < windowSecs; i++) sum += series[i];
  let best = sum;
  for (let i = windowSecs; i < series.length; i++) {
    sum += series[i] - series[i - windowSecs];
    if (sum > best) best = sum;
  }
  return Math.round(best / windowSecs);
}

function integrateDistanceM(samples: SessionSample[]): number {
  let meters = 0;
  for (let i = 1; i < samples.length; i++) {
    const dt = (samples[i].timestampMs - samples[i - 1].timestampMs) / 1000;
    if (dt <= 0 || dt > 10) continue;
    const v0 = samples[i - 1].speedKmh ?? 0;
    const v1 = samples[i].speedKmh ?? 0;
    meters += ((v0 + v1) / 2) * (1000 / 3600) * dt;
  }
  return meters;
}

function integrateWorkKj(samples: SessionSample[]): number {
  let joules = 0;
  for (let i = 1; i < samples.length; i++) {
    const dt = (samples[i].timestampMs - samples[i - 1].timestampMs) / 1000;
    if (dt <= 0 || dt > 10) continue;
    const p0 = samples[i - 1].power ?? 0;
    const p1 = samples[i].power ?? 0;
    joules += ((p0 + p1) / 2) * dt;
  }
  return joules / 1000;
}

function heartRateStats(samples: SessionSample[]): {
  avg?: number;
  max?: number;
} {
  const hrs = samples.map((s) => s.heartRate).filter((v): v is number => v != null && v > 0);
  if (hrs.length === 0) return {};
  return {
    avg: Math.round(hrs.reduce((a, b) => a + b, 0) / hrs.length),
    max: Math.max(...hrs),
  };
}

export function computeSessionStats(
  samples: SessionSample[],
  summary: SessionSummary,
): SessionStats {
  const series = resamplePower1Hz(samples);
  const movingSecs = series.filter((w) => w > 0).length;
  const hr = heartRateStats(samples);
  const bests: PowerWindowBest[] = [];
  for (const window of POWER_WINDOWS) {
    const watts = meanMaxWatts(series, window.windowSecs);
    if (watts == null) continue;
    bests.push({ ...window, watts });
  }

  return {
    durationSecs: summary.durationSecs,
    movingSecs,
    avgPower: summary.avgPower,
    maxPower: summary.maxPower,
    distanceM: integrateDistanceM(samples),
    workKj: integrateWorkKj(samples),
    avgHeartRate: hr.avg,
    maxHeartRate: hr.max,
    bests,
  };
}

export function emptyPersonalRecords(): PersonalRecords {
  return {
    bests: {},
    maxDurationSecs: 0,
    maxDistanceM: 0,
    maxWorkKj: 0,
  };
}

function formatWatts(watts: number): string {
  return `${watts} W`;
}

export function formatKm(meters: number): string {
  if (meters < 100) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toFixed(1)} km`;
}

export function formatHours(secs: number): string {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  if (h > 0) return `${h} h ${m} min`;
  if (m > 0) return `${m} min`;
  return `${s} s`;
}

export function applyPersonalRecords(
  current: PersonalRecords,
  stats: SessionStats,
  at = new Date().toISOString(),
): { records: PersonalRecords; hits: PersonalRecordHit[] } {
  const records: PersonalRecords = {
    bests: { ...(current.bests ?? {}) },
    maxDurationSecs: current.maxDurationSecs ?? 0,
    maxDistanceM: current.maxDistanceM ?? 0,
    maxWorkKj: current.maxWorkKj ?? 0,
    maxPower: current.maxPower,
  };
  const hits: PersonalRecordHit[] = [];

  for (const best of stats.bests) {
    const key = String(best.windowSecs);
    const previous = records.bests[key];
    if (!previous || best.watts > previous.watts) {
      hits.push({
        kind: "power",
        label: `Best ${best.label}`,
        value: formatWatts(best.watts),
        previous: previous ? formatWatts(previous.watts) : undefined,
      });
      records.bests[key] = { watts: best.watts, at };
    }
  }

  if (stats.durationSecs > records.maxDurationSecs) {
    hits.push({
      kind: "duration",
      label: "Durata massima",
      value: formatHours(stats.durationSecs),
      previous: records.maxDurationSecs
        ? formatHours(records.maxDurationSecs)
        : undefined,
    });
    records.maxDurationSecs = stats.durationSecs;
  }

  if (stats.distanceM > records.maxDistanceM) {
    hits.push({
      kind: "distance",
      label: "Distanza massima",
      value: formatKm(stats.distanceM),
      previous: records.maxDistanceM ? formatKm(records.maxDistanceM) : undefined,
    });
    records.maxDistanceM = stats.distanceM;
  }

  if (stats.workKj > records.maxWorkKj) {
    hits.push({
      kind: "work",
      label: "Lavoro massimo",
      value: `${stats.workKj.toFixed(0)} kJ`,
      previous: records.maxWorkKj ? `${records.maxWorkKj.toFixed(0)} kJ` : undefined,
    });
    records.maxWorkKj = stats.workKj;
  }

  if (stats.maxPower != null && (records.maxPower == null || stats.maxPower > records.maxPower)) {
    hits.push({
      kind: "maxPower",
      label: "Potenza di picco",
      value: formatWatts(stats.maxPower),
      previous: records.maxPower != null ? formatWatts(records.maxPower) : undefined,
    });
    records.maxPower = stats.maxPower;
  }

  return { records, hits };
}

export function isPowerRecord(
  hits: PersonalRecordHit[],
  windowSecs: number,
): boolean {
  const label = POWER_WINDOWS.find((w) => w.windowSecs === windowSecs)?.label;
  if (!label) return false;
  return hits.some((hit) => hit.kind === "power" && hit.label === `Best ${label}`);
}
