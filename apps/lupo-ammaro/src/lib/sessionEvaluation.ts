import type {
  CalendarEntry,
  CoachContext,
  LoadSnapshot,
  SessionEvaluation,
  SessionSample,
  SessionSeriesPoint,
  SessionStats,
  UserProfile,
  Workout,
} from "../types";
import {
  complianceScore,
  computePmc,
  downsamplePoints,
  loadSnapshot,
  samplesToPoints,
  sessionMetrics,
} from "../../shared/engine/load.mjs";
import { estimateHrMax, hrZoneShares, zoneSharesFromSeconds } from "./trainingZones";
import { docsForSessionVerdict } from "./trainingDocs";

export type EntryMetrics = Pick<
  CalendarEntry,
  | "durationSecs"
  | "avgPower"
  | "maxPower"
  | "np"
  | "tss"
  | "ifactor"
  | "kj"
  | "avgHr"
  | "maxHr"
  | "avgCadence"
  | "decoupling"
  | "mmp"
  | "zoneSecs"
>;

/** Metriche da salvare sulla voce di calendario (calcolate a 1 Hz). */
export function metricsFromPoints(
  points: SessionSeriesPoint[],
  profile: Pick<UserProfile, "ftpWatts" | "lthr">,
): EntryMetrics {
  const m = sessionMetrics(points, { ftp: profile.ftpWatts, lthr: profile.lthr });
  return {
    durationSecs: m.durationSecs || undefined,
    avgPower: m.avgPower,
    maxPower: m.maxPower,
    np: m.np,
    tss: m.tss,
    ifactor: m.ifactor,
    kj: m.kj,
    avgHr: m.avgHr,
    maxHr: m.maxHr,
    avgCadence: m.avgCadence,
    decoupling: m.decoupling ?? undefined,
    mmp: m.mmp,
    zoneSecs: m.zoneSecs,
  };
}

export function pointsFromSamples(samples: SessionSample[]): SessionSeriesPoint[] {
  return samplesToPoints(samples);
}

export function storageSeries(points: SessionSeriesPoint[]): SessionSeriesPoint[] {
  return downsamplePoints(points, 5);
}

export function plannedCompliance(
  done: Pick<CalendarEntry, "tss" | "durationSecs">,
  planned: Pick<CalendarEntry, "plannedTss" | "tss" | "durationSecs"> | null | undefined,
): number | undefined {
  if (!planned) return undefined;
  const score = complianceScore({
    doneTss: done.tss ?? 0,
    plannedTss: planned.plannedTss ?? planned.tss ?? 0,
    doneSecs: done.durationSecs ?? 0,
    plannedSecs: planned.durationSecs ?? 0,
  });
  return score ?? undefined;
}

export function evaluateSession(opts: {
  title: string;
  samples: SessionSample[];
  stats: SessionStats;
  ftp: number;
  profile?: UserProfile;
  workout?: Workout | null;
  recentSeries?: SessionSeriesPoint[][];
  plannedTss?: number;
}): SessionEvaluation {
  const points = samplesToPoints(opts.samples);
  const ftp = opts.ftp || 200;
  const m = sessionMetrics(points, { ftp, lthr: opts.profile?.lthr });
  const ifactor = Math.round((m.ifactor ?? 0) * 100) / 100;
  const tss = Math.round(m.tss ?? 0);
  const hrMax = estimateHrMax([points, ...(opts.recentSeries ?? [])], opts.profile?.hrMax);
  const powerZones = zoneSharesFromSeconds(m.zoneSecs ?? []);
  const hrZones = hrMax ? hrZoneShares(points, hrMax) : [];
  const drift = m.decoupling ?? null;

  const pct = (id: string) => powerZones.find((z) => z.id === id)?.percent ?? 0;
  const z2 = pct("z2");
  const z45 = pct("z4") + pct("z5");
  const z67 = pct("z6") + pct("z7");

  let verdict: SessionEvaluation["verdict"] = "on_target";
  if (ifactor >= 1.05 || z67 > 12 || (drift != null && drift > 10)) verdict = "hard";
  if (ifactor < 0.65 && z45 < 8) verdict = "easy";
  if (drift != null && drift > 12 && ifactor > 0.75) verdict = "fatigue";

  const notes: string[] = [];
  notes.push(`NP ${m.np ?? 0} W · IF ${ifactor.toFixed(2)} · TSS ${tss} · ${Math.round(m.kj ?? 0)} kJ.`);
  notes.push(`Tempo potenza: Z2 ${z2.toFixed(0)}% · Z4–Z5 ${z45.toFixed(0)}% · Z6–Z7 ${z67.toFixed(0)}%.`);
  if (hrMax && hrZones.length) {
    const hr4 = (hrZones.find((z) => z.id === "hr4")?.percent ?? 0) + (hrZones.find((z) => z.id === "hr5")?.percent ?? 0);
    notes.push(`FC max di riferimento ${hrMax} bpm · tempo FC4–FC5 ${hr4.toFixed(0)}%.`);
  } else {
    notes.push("Nessuna FC valida: collega una fascia per il confronto cardiaco.");
  }
  if (drift != null) {
    notes.push(
      drift > 5
        ? `Decoupling Pw:HR +${drift}%: la seconda metà è costata di più a parità di watt (soglia aerobica superata o calore/disidratazione).`
        : `Decoupling Pw:HR ${drift}%: buona tenuta aerobica.`,
    );
  }
  if (opts.plannedTss) {
    const ratio = Math.round((tss / opts.plannedTss) * 100);
    notes.push(`Rispetto al pianificato: ${ratio}% del TSS previsto (${Math.round(opts.plannedTss)}).`);
  } else if (opts.workout) {
    notes.push(`Workout «${opts.workout.name}» completato.`);
  }

  const summaries: Record<SessionEvaluation["verdict"], string> = {
    easy: "Sessione sotto-stimolo: utile recupero, poco specifica se cercavi intensità.",
    on_target: "Distribuzione zone coerente con un lavoro strutturato.",
    hard: "Carico alto (IF/VO2/anaerobica). Recupero Z1–Z2 nelle prossime 24–36 h.",
    fatigue: "Segnali di deriva cardiaca/fatica: deload prima di un'altra sessione dura.",
  };

  return {
    at: new Date().toISOString(),
    title: opts.title,
    intensityFactor: ifactor,
    tss,
    verdict,
    summary: summaries[verdict],
    notes,
    powerZones,
    hrZones,
    docs: docsForSessionVerdict(verdict, hrZones.some((z) => z.seconds > 0)),
  };
}

export function loadSnapshotFromContext(context: CoachContext): LoadSnapshot {
  const pmc = computePmc(context.activities, {
    ftp: context.profile.ftpWatts,
    lthr: context.profile.lthr,
    days: 120,
  });
  return loadSnapshot(pmc) as LoadSnapshot;
}
