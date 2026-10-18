import { addDaysIso, diffDays, mondayOfIso, todayLocal } from "./dates.mjs";
import { isCycling } from "./sports.mjs";

/** Finestre mean-max (s). L'array `mmp` delle sessioni è allineato a questo elenco. */
export const MMP_WINDOWS = [1, 5, 10, 15, 30, 60, 120, 180, 300, 420, 600, 900, 1200, 1800, 2400, 3600];

export const COGGAN_ZONES = [
  { id: "z1", label: "Z1 Recupero", minPct: 0, maxPct: 55, color: "#8a93a8" },
  { id: "z2", label: "Z2 Endurance", minPct: 55, maxPct: 75, color: "#60a5fa" },
  { id: "z3", label: "Z3 Tempo", minPct: 75, maxPct: 90, color: "#4ade80" },
  { id: "z4", label: "Z4 Soglia", minPct: 90, maxPct: 105, color: "#facc15" },
  { id: "z5", label: "Z5 VO2max", minPct: 105, maxPct: 120, color: "#fb923c" },
  { id: "z6", label: "Z6 Anaerobica", minPct: 120, maxPct: 150, color: "#ff0a54" },
  { id: "z7", label: "Z7 Neuromusc.", minPct: 150, maxPct: 1000, color: "#c084fc" },
];

const MAX_HOLD_GAP_SECS = 10;

/**
 * Ricampiona una serie {t, power, hr, cadence} (t in secondi, anche irregolare)
 * in array a 1 Hz. I buchi > 10 s valgono come pausa (0 W, FC assente).
 */
export function resample1Hz(points) {
  const pts = (points ?? []).filter((p) => p && Number.isFinite(p.t)).sort((a, b) => a.t - b.t);
  if (pts.length === 0) return { power: [], hr: [], cadence: [] };
  const t0 = pts[0].t;
  const duration = Math.max(1, Math.round(pts[pts.length - 1].t - t0) + 1);
  const power = new Array(duration).fill(0);
  const hr = new Array(duration).fill(0);
  const cadence = new Array(duration).fill(0);
  let j = 0;
  for (let s = 0; s < duration; s++) {
    const target = t0 + s;
    while (j + 1 < pts.length && pts[j + 1].t <= target) j++;
    const p = pts[j];
    if (target - p.t > MAX_HOLD_GAP_SECS) continue;
    power[s] = Math.max(0, p.power ?? 0);
    hr[s] = Math.max(0, p.hr ?? 0);
    cadence[s] = Math.max(0, p.cadence ?? 0);
  }
  return { power, hr, cadence };
}

/** Campioni live (timestampMs) → punti con t in secondi. */
export function samplesToPoints(samples) {
  if (!samples?.length) return [];
  const start = samples[0].timestampMs;
  return samples.map((s) => ({
    t: Math.round((s.timestampMs - start) / 1000),
    power: s.power,
    hr: s.heartRate,
    cadence: s.cadence,
    target: s.targetPower,
  }));
}

/** Downsample a intervalli fissi (media potenza nel bucket, ultimo valore FC/cadenza). */
export function downsamplePoints(points, intervalSecs = 5) {
  const { power, hr, cadence } = resample1Hz(points);
  const targets = new Map();
  for (const p of points ?? []) {
    if (p.target != null) targets.set(Math.floor(p.t / intervalSecs) * intervalSecs, p.target);
  }
  const out = [];
  for (let s = 0; s < power.length; s += intervalSecs) {
    const slice = power.slice(s, s + intervalSecs);
    const avg = slice.reduce((a, b) => a + b, 0) / slice.length;
    const h = hr.slice(s, s + intervalSecs).filter((v) => v > 0);
    const c = cadence.slice(s, s + intervalSecs).filter((v) => v > 0);
    out.push({
      t: s,
      power: Math.round(avg),
      hr: h.length ? Math.round(h.reduce((a, b) => a + b, 0) / h.length) : undefined,
      cadence: c.length ? Math.round(c.reduce((a, b) => a + b, 0) / c.length) : undefined,
      target: targets.get(s),
    });
  }
  return out;
}

export function normalizedPower(power1Hz) {
  const n = power1Hz.length;
  if (n === 0) return 0;
  if (n < 30) return Math.round(power1Hz.reduce((a, b) => a + b, 0) / n);
  let sum = 0;
  let acc = 0;
  let count = 0;
  for (let i = 0; i < n; i++) {
    sum += power1Hz[i];
    if (i >= 30) sum -= power1Hz[i - 30];
    if (i >= 29) {
      const m = sum / 30;
      acc += m * m * m * m;
      count++;
    }
  }
  return Math.round(Math.pow(acc / count, 0.25));
}

export function intensityFactor(np, ftp) {
  if (!ftp || !np) return 0;
  return Math.round((np / ftp) * 1000) / 1000;
}

export function tssFromNp(durationSecs, np, ftp) {
  if (!ftp || !np || durationSecs <= 0) return 0;
  const ifactor = np / ftp;
  return Math.round(((durationSecs * np * ifactor) / (ftp * 3600)) * 100 * 10) / 10;
}

export function hrTss(durationSecs, avgHr, lthr) {
  if (!avgHr || !lthr || durationSecs <= 0) return 0;
  const r = avgHr / lthr;
  return Math.round((durationSecs / 3600) * r * r * 100 * 10) / 10;
}

/** TSS da RPE (1–10) quando mancano potenza e FC. */
export function rpeTss(durationSecs, rpe) {
  if (!rpe || durationSecs <= 0) return 0;
  const ifactor = Math.min(1.1, 0.45 + 0.055 * rpe);
  return Math.round((durationSecs / 3600) * ifactor * ifactor * 100 * 10) / 10;
}

export function meanMax(power1Hz, windowSecs) {
  const n = power1Hz.length;
  if (windowSecs <= 0 || n < windowSecs) return 0;
  let sum = 0;
  for (let i = 0; i < windowSecs; i++) sum += power1Hz[i];
  let best = sum;
  for (let i = windowSecs; i < n; i++) {
    sum += power1Hz[i] - power1Hz[i - windowSecs];
    if (sum > best) best = sum;
  }
  return Math.round(best / windowSecs);
}

export function mmpCurve(power1Hz) {
  return MMP_WINDOWS.map((w) => meanMax(power1Hz, w));
}

export function zoneSeconds(power1Hz, ftp) {
  const secs = COGGAN_ZONES.map(() => 0);
  if (!ftp) return secs;
  for (const w of power1Hz) {
    if (w <= 0) continue;
    const pct = (w / ftp) * 100;
    let idx = COGGAN_ZONES.findIndex((z) => pct >= z.minPct && pct < z.maxPct);
    if (idx < 0) idx = COGGAN_ZONES.length - 1;
    secs[idx] += 1;
  }
  return secs;
}

/** Pw:HR decoupling (%) tra prima e seconda metà della parte pedalata. */
export function decoupling(power1Hz, hr1Hz) {
  const idx = [];
  for (let i = 0; i < power1Hz.length; i++) {
    if (power1Hz[i] > 0 && hr1Hz[i] > 60) idx.push(i);
  }
  if (idx.length < 1200) return null;
  const half = Math.floor(idx.length / 2);
  const ratio = (list) => {
    let p = 0;
    let h = 0;
    for (const i of list) {
      p += power1Hz[i];
      h += hr1Hz[i];
    }
    return h > 0 ? p / h : 0;
  };
  const r1 = ratio(idx.slice(0, half));
  const r2 = ratio(idx.slice(half));
  if (!r1) return null;
  return Math.round(((r1 - r2) / r1) * 1000) / 10;
}

/**
 * Metriche complete di una sessione da serie (t in s).
 * @returns {{durationSecs:number,movingSecs:number,avgPower?:number,maxPower?:number,np?:number,ifactor?:number,tss?:number,kj?:number,avgHr?:number,maxHr?:number,avgCadence?:number,mmp?:number[],zoneSecs?:number[],decoupling?:number|null}}
 */
export function sessionMetrics(points, { ftp = 0, lthr = 0 } = {}) {
  const { power, hr, cadence } = resample1Hz(points);
  const durationSecs = power.length;
  if (durationSecs === 0) return { durationSecs: 0, movingSecs: 0 };
  const movingSecs = power.filter((w, i) => w > 0 || cadence[i] > 0).length;
  const hasPower = power.some((w) => w > 0);
  const hrVals = hr.filter((v) => v > 0);
  const cadVals = cadence.filter((v) => v > 0);
  const avgHr = hrVals.length ? Math.round(hrVals.reduce((a, b) => a + b, 0) / hrVals.length) : undefined;
  const out = {
    durationSecs,
    movingSecs,
    avgHr,
    maxHr: hrVals.length ? Math.max(...hrVals) : undefined,
    avgCadence: cadVals.length ? Math.round(cadVals.reduce((a, b) => a + b, 0) / cadVals.length) : undefined,
  };
  if (hasPower) {
    const np = normalizedPower(power);
    out.avgPower = Math.round(power.reduce((a, b) => a + b, 0) / durationSecs);
    out.maxPower = Math.max(...power);
    out.np = np;
    out.ifactor = intensityFactor(np, ftp);
    out.tss = tssFromNp(durationSecs, np, ftp);
    out.kj = Math.round(power.reduce((a, b) => a + b, 0) / 100) / 10;
    out.mmp = mmpCurve(power);
    out.zoneSecs = zoneSeconds(power, ftp);
    out.decoupling = decoupling(power, hr);
  } else if (avgHr && lthr) {
    out.tss = hrTss(durationSecs, avgHr, lthr);
  }
  return out;
}

function hrAnchor(entry, lthr, lthrRun) {
  if (entry?.sport === "run" || entry?.sport === "trail_run") return lthrRun || (lthr ? lthr + 5 : 0);
  return lthr;
}

/** TSS migliore disponibile per una voce di calendario. */
export function entryTss(entry, ftp, lthr, lthrRun = 0) {
  if (!entry) return 0;
  if (entry.entryType === "planned") return Number(entry.plannedTss ?? entry.tss ?? 0) || 0;
  if (Number.isFinite(entry.tss) && entry.tss > 0) return entry.tss;
  const dur = Number(entry.durationSecs ?? 0);
  const cycling = isCycling(entry.sport);
  const suffer = /relativo sforzo\s+(\d+)/.exec(String(entry.notes ?? ""));
  if (!entry.np && suffer) return Number(suffer[1]);
  if (cycling && entry.np && ftp) return tssFromNp(dur, entry.np, ftp);
  if (cycling && entry.avgPower && ftp) return tssFromNp(dur, Math.round(entry.avgPower * 1.05), ftp);
  const anchor = hrAnchor(entry, lthr, lthrRun);
  if (entry.avgHr && anchor) return hrTss(dur, entry.avgHr, anchor);
  if (entry.rpe) return rpeTss(dur, entry.rpe);
  if (dur >= 20 * 60) return rpeTss(dur, cycling ? 4 : 5);
  return 0;
}

const CTL_DAYS = 42;
const ATL_DAYS = 7;

/**
 * PMC giornaliero. Passato/oggi = sessioni svolte; futuro = sessioni pianificate (proiezione).
 * TSB del giorno = CTL − ATL del giorno precedente (forma con cui inizi la giornata).
 */
export function computePmc(entries, { ftp = 0, lthr = 0, lthrRun = 0, days = 120, futureDays = 0, today = todayLocal() } = {}) {
  const done = new Map();
  const planned = new Map();
  for (const e of entries ?? []) {
    const day = String(e.date ?? "").slice(0, 10);
    if (!day) continue;
    const tss = entryTss(e, ftp, lthr, lthrRun);
    if (!tss) continue;
    const map = e.entryType === "planned" ? planned : done;
    map.set(day, (map.get(day) ?? 0) + tss);
  }
  let ctl = 0;
  let atl = 0;
  const out = [];
  for (let i = -days; i <= futureDays; i++) {
    const date = addDaysIso(today, i);
    const projected = i > 0 || (i === 0 && !done.has(date) && planned.has(date));
    const tss = projected ? planned.get(date) ?? 0 : done.get(date) ?? 0;
    const tsb = ctl - atl;
    ctl += (tss - ctl) / CTL_DAYS;
    atl += (tss - atl) / ATL_DAYS;
    out.push({
      date,
      tss: Math.round(tss),
      ctl: Math.round(ctl * 10) / 10,
      atl: Math.round(atl * 10) / 10,
      tsb: Math.round(tsb * 10) / 10,
      projected,
    });
  }
  return out;
}

function stdev(values) {
  if (values.length === 0) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const v = values.reduce((s, x) => s + (x - mean) ** 2, 0) / values.length;
  return Math.sqrt(v);
}

/** Snapshot carico a oggi: CTL/ATL/TSB, ramp rate, monotonia/strain (Foster), ACWR. */
export function loadSnapshot(pmc, today = todayLocal()) {
  const idx = pmc.findIndex((p) => p.date === today);
  const i = idx >= 0 ? idx : pmc.length - 1;
  const cur = pmc[i] ?? { ctl: 0, atl: 0, tsb: 0 };
  const week = pmc.slice(Math.max(0, i - 6), i + 1).map((p) => p.tss);
  const prevWeek = pmc.slice(Math.max(0, i - 13), Math.max(0, i - 6)).map((p) => p.tss);
  const last28 = pmc.slice(Math.max(0, i - 27), i + 1).map((p) => p.tss);
  const weekTss = week.reduce((a, b) => a + b, 0);
  const prevWeekTss = prevWeek.reduce((a, b) => a + b, 0);
  const sd = stdev(week);
  const mean = weekTss / Math.max(1, week.length);
  const monotony = sd > 0 ? Math.round((mean / sd) * 100) / 100 : week.some((v) => v > 0) ? 2.5 : 0;
  const strain = Math.round(weekTss * monotony);
  const chronic = last28.reduce((a, b) => a + b, 0) / Math.max(1, last28.length);
  const acwr = chronic > 0 ? Math.round((mean / chronic) * 100) / 100 : 0;
  const ctl7 = pmc[Math.max(0, i - 7)]?.ctl ?? 0;
  const rampRate = Math.round((cur.ctl - ctl7) * 10) / 10;
  const tsbToday = Math.round((cur.ctl - cur.atl) * 10) / 10;

  let status = "bilanciato";
  if (tsbToday > 5) status = "fresco";
  if (tsbToday < -20 || acwr > 1.5 || rampRate > 8) status = "affaticato";

  const notes = [];
  if (rampRate > 8) notes.push(`Ramp rate CTL +${rampRate}/sett: troppo rapido, rischio overreaching.`);
  if (acwr > 1.5) notes.push(`ACWR ${acwr}: carico acuto molto sopra il cronico.`);
  if (monotony > 2) notes.push(`Monotonia ${monotony}: varia di più giorni duri e facili.`);
  const summary =
    status === "fresco"
      ? "TSB positivo: buona finestra per test o qualità."
      : status === "affaticato"
        ? "Fatica alta: priorità recupero, niente VO2 finché il TSB non risale."
        : "Carico produttivo: mantieni 1–2 qualità e volume Z2.";

  return {
    ctl: cur.ctl,
    atl: cur.atl,
    tsb: tsbToday,
    weekTss: Math.round(weekTss),
    prevWeekTss: Math.round(prevWeekTss),
    rampRate,
    monotony,
    strain,
    acwr,
    status,
    summary: [summary, ...notes].join(" "),
  };
}

/** Totali per settimana (lunedì → domenica). */
export function weeklySummary(entries, { ftp = 0, lthr = 0, lthrRun = 0 } = {}) {
  const weeks = new Map();
  for (const e of entries ?? []) {
    const day = String(e.date ?? "").slice(0, 10);
    if (!day) continue;
    const key = mondayOfIso(day);
    const row = weeks.get(key) ?? {
      weekStart: key,
      doneTss: 0,
      plannedTss: 0,
      doneSecs: 0,
      plannedSecs: 0,
      sessions: 0,
      plannedSessions: 0,
      kj: 0,
      zoneSecs: COGGAN_ZONES.map(() => 0),
      bySport: {},
    };
    if (e.entryType === "planned") {
      row.plannedTss += entryTss(e, ftp, lthr, lthrRun);
      row.plannedSecs += Number(e.durationSecs ?? 0);
      row.plannedSessions += 1;
    } else {
      row.doneTss += entryTss(e, ftp, lthr, lthrRun);
      row.doneSecs += Number(e.durationSecs ?? 0);
      row.sessions += 1;
      const sport = e.sport || "ride";
      const bucket = row.bySport[sport] ?? { secs: 0, tss: 0 };
      bucket.secs += Number(e.durationSecs ?? 0);
      bucket.tss += entryTss(e, ftp, lthr, lthrRun);
      row.bySport[sport] = bucket;
      row.kj += Number(e.kj ?? 0);
      (e.zoneSecs ?? []).forEach((s, i) => {
        if (i < row.zoneSecs.length) row.zoneSecs[i] += s;
      });
    }
    weeks.set(key, row);
  }
  return [...weeks.values()]
    .map((w) => ({ ...w, doneTss: Math.round(w.doneTss), plannedTss: Math.round(w.plannedTss) }))
    .sort((a, b) => a.weekStart.localeCompare(b.weekStart));
}

/** Compliance (%) svolto vs pianificato: media di rapporto TSS e durata, cap 150. */
export function complianceScore({ doneTss, plannedTss, doneSecs, plannedSecs }) {
  const parts = [];
  if (plannedTss > 0 && doneTss >= 0) parts.push(doneTss / plannedTss);
  if (plannedSecs > 0 && doneSecs >= 0) parts.push(doneSecs / plannedSecs);
  if (parts.length === 0) return null;
  const r = parts.reduce((a, b) => a + b, 0) / parts.length;
  return Math.round(Math.min(1.5, r) * 100);
}

export function daysBetween(a, b) {
  return diffDays(a, b);
}
