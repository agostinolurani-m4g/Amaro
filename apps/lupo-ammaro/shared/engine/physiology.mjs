import { addDaysIso, todayLocal } from "./dates.mjs";
import { isCycling } from "./sports.mjs";
import { MMP_WINDOWS, resample1Hz, meanMax } from "./load.mjs";

/*
 * Modello fisiologico WattLab.
 * Tutte le stime sono indirette (dati di potenza) salvo calibrazione con test del lattato reali.
 */

// Costanti modello Mader semplificato (stato stazionario)
const KS1 = 0.035 ** 2; // costante ADP per VO2
const KS2 = 0.15 ** 3; // costante ADP per glicolisi
const KEL = 2.0; // (mmol/l)^2, semisaturazione combustione lattato
const VOL_REL = 0.4; // volume distribuzione lattato (frazione massa)
const LA_O2_EQ = 0.01576; // mmol lattato ossidati per ml O2 /kg
const BASELINE_LA = 0.9; // lattato basale (mmol/l)
const VO2_REST = 7; // ml/kg/min (riposo + pedalata a vuoto, ACSM)
const VO2_PER_WKG = 10.8; // ml/kg/min per W/kg (ACSM)
const KCAL_PER_L_O2 = 4.9;

export function confidenceLabel(score) {
  if (score >= 0.7) return "alta";
  if (score >= 0.4) return "media";
  return "bassa";
}

/** Miglior MMP per finestra sulle voci svolte degli ultimi `days` giorni. */
/** @param {any[]} entries @param {{days?: number, today?: string, records?: any}} [opts] */
export function bestMmp(entries, { days = 90, today = todayLocal(), records = null } = {}) {
  const from = addDaysIso(today, -days);
  const best = MMP_WINDOWS.map(() => ({ watts: 0, date: null }));
  for (const e of entries ?? []) {
    if (e.entryType === "planned") continue;
    if (!isCycling(e.sport)) continue;
    const day = String(e.date ?? "").slice(0, 10);
    if (day < from || day > today) continue;
    let mmp = e.mmp;
    if ((!mmp || mmp.length === 0) && e.series?.length) {
      const { power } = resample1Hz(e.series);
      mmp = MMP_WINDOWS.map((w) => meanMax(power, w));
    }
    (mmp ?? []).forEach((w, i) => {
      if (i < best.length && w > best[i].watts) best[i] = { watts: w, date: day };
    });
  }
  if (records?.bests) {
    for (const [secs, b] of Object.entries(records.bests)) {
      const i = MMP_WINDOWS.indexOf(Number(secs));
      const day = String(b?.at ?? "").slice(0, 10);
      if (i >= 0 && b?.watts > best[i].watts && day >= from) best[i] = { watts: b.watts, date: day };
    }
  }
  return best;
}

function mmpAt(best, secs) {
  const i = MMP_WINDOWS.indexOf(secs);
  return i >= 0 ? best[i]?.watts ?? 0 : 0;
}

/** Fit CP/W' (modello lavoro-tempo lineare) su sforzi 2–20 min. */
export function fitCriticalPower(best) {
  const pts = [];
  for (const secs of [120, 180, 300, 420, 600, 900, 1200]) {
    const w = mmpAt(best, secs);
    if (w > 0) pts.push({ t: secs, work: w * secs });
  }
  if (pts.length < 2) return null;
  const n = pts.length;
  const mt = pts.reduce((s, p) => s + p.t, 0) / n;
  const mw = pts.reduce((s, p) => s + p.work, 0) / n;
  let num = 0;
  let den = 0;
  for (const p of pts) {
    num += (p.t - mt) * (p.work - mw);
    den += (p.t - mt) ** 2;
  }
  if (den <= 0) return null;
  const cp = num / den;
  const wPrime = mw - cp * mt;
  if (!(cp > 50) || !(wPrime > 2000) || wPrime > 60000) return null;
  let ssr = 0;
  let sst = 0;
  for (const p of pts) {
    const pred = cp * p.t + wPrime;
    ssr += (p.work - pred) ** 2;
    sst += (p.work - mw) ** 2;
  }
  const r2 = sst > 0 ? 1 - ssr / sst : 0;
  return { cp: Math.round(cp), wPrime: Math.round(wPrime), points: n, r2: Math.round(r2 * 1000) / 1000 };
}

export function vo2FromPower(watts, weightKg) {
  return VO2_REST + VO2_PER_WKG * (watts / weightKg);
}

export function powerFromVo2(vo2, weightKg) {
  return ((vo2 - VO2_REST) / VO2_PER_WKG) * weightKg;
}

function adpFromVo2(vo2ss, vo2max) {
  const r = Math.min(0.999, Math.max(0.001, vo2ss / vo2max));
  return Math.sqrt((KS1 * r) / (1 - r));
}

/** Stato metabolico a una potenza costante (mmol/l/min). */
export function metabolicState(watts, { vo2max, vlamax, weightKg }) {
  const vo2 = Math.min(vo2FromPower(watts, weightKg), vo2max * 0.999);
  const adp = adpFromVo2(vo2, vo2max);
  const vLass = (vlamax * 60) / (1 + KS2 / adp ** 3);
  const vLaoxMax = (vo2 * LA_O2_EQ) / VOL_REL;
  return { vo2, vLass, vLaoxMax };
}

/** Lattato stimato in stato stazionario; null se sopra MLSS (accumulo). */
export function steadyLactate(watts, params) {
  const { vLass, vLaoxMax } = metabolicState(watts, params);
  if (vLass >= vLaoxMax * 0.995) return null;
  const la2 = (KEL * vLass) / (vLaoxMax - vLass);
  return BASELINE_LA * (params.baselineScale ?? 1) + Math.sqrt(la2);
}

const mlssLactateCache = new WeakMap();

const MLSS_LA_CAP = 6.5;

/** Lattato di ancoraggio a MLSS (lo stato stazionario del modello diverge vicino a MLSS). */
function lactateAtMlss(params) {
  let v = mlssLactateCache.get(params);
  if (v == null) {
    const mlss = findMlss(params, powerFromVo2(params.vo2max, params.weightKg));
    v = Math.min(MLSS_LA_CAP, steadyLactate(mlss - 1, params) ?? steadyLactate(mlss - 3, params) ?? 4);
    mlssLactateCache.set(params, v);
  }
  return v;
}

/**
 * Lattato dopo `secs` a potenza costante. Sopra MLSS parte dal lattato di MLSS e accumula
 * in proporzione all'eccesso glicolitico, con saturazione (~12 mmol/l sopra MLSS).
 */
export function lactateAfter(watts, secs, params) {
  const anchor = lactateAtMlss(params);
  const ss = steadyLactate(watts, params);
  if (ss != null) return Math.min(ss, anchor);
  const { vLass, vLaoxMax } = metabolicState(watts, params);
  const net = Math.max(0, vLass - vLaoxMax);
  const span = 12;
  return anchor + span * (1 - Math.exp((-net * 0.2 * (secs / 60)) / span));
}

export function findMlss(params, maxWatts) {
  let lo = 30;
  let hi = maxWatts;
  if (steadyLactate(lo, params) == null) return lo;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (steadyLactate(mid, params) == null) hi = mid;
    else lo = mid;
  }
  return Math.round(lo);
}

function powerAtLactate(target, params, maxWatts) {
  let prev = null;
  for (let w = 40; w <= maxWatts; w += 2) {
    const la = steadyLactate(w, params);
    if (la == null) return prev;
    if (la >= target) return w;
    prev = w;
  }
  return prev;
}

/** Carboidrati/grassi ossidati (g/h) a una potenza. */
export function substrateAt(watts, params) {
  const { vo2, vLass } = metabolicState(watts, params);
  const kcalH = ((vo2 * params.weightKg) / 1000) * KCAL_PER_L_O2 * 60;
  const choGh = vLass * VOL_REL * params.weightKg * 0.09 * 60;
  const choKcal = Math.min(kcalH, choGh * 4.1);
  const fatGh = Math.max(0, (kcalH - choKcal) / 9.4);
  return {
    kcalH: Math.round(kcalH),
    choGh: Math.round(Math.min(choGh, kcalH / 4.1)),
    fatGh: Math.round(fatGh * 10) / 10,
  };
}

/** VLamax tale che MLSS del modello coincida con la potenza di soglia osservata. */
function solveVlamaxForMlss(targetMlss, vo2max, weightKg) {
  let lo = 0.1;
  let hi = 1.5;
  const maxW = powerFromVo2(vo2max, weightKg);
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    const mlss = findMlss({ vo2max, vlamax: mid, weightKg }, maxW);
    if (mlss > targetMlss) lo = mid;
    else hi = mid;
  }
  return Math.round(((lo + hi) / 2) * 100) / 100;
}

function vlamaxFromSprint(best, cp, weightKg) {
  const p15 = mmpAt(best, 15) || mmpAt(best, 10) || mmpAt(best, 30);
  if (!p15 || !cp) return null;
  const ratio = p15 / cp;
  const wkg = p15 / weightKg;
  const v = 0.12 + 0.13 * (ratio - 2) + 0.02 * (wkg - 10);
  return Math.round(Math.min(1.2, Math.max(0.15, v)) * 100) / 100;
}

/** Calibra VO2max/VLamax/basale sui test del lattato reali (grid search). */
function calibrateOnTests(tests, base) {
  const pts = (tests ?? []).filter((t) => t.watts > 0 && t.mmol > 0);
  if (pts.length < 2) return null;
  let best = null;
  for (let fv = 0.85; fv <= 1.15001; fv += 0.015) {
    const vo2max = base.vo2max * fv;
    for (let vl = 0.12; vl <= 1.3; vl += 0.02) {
      for (let bs = 0.6; bs <= 1.8; bs += 0.1) {
        const params = { vo2max, vlamax: vl, weightKg: base.weightKg, baselineScale: bs };
        let err = 0;
        for (const p of pts) {
          const la = lactateAfter(p.watts, 240, params);
          err += (la - p.mmol) ** 2;
        }
        if (!best || err < best.err) best = { err, vo2max, vlamax: vl, baselineScale: bs };
      }
    }
  }
  const rmse = Math.sqrt(best.err / pts.length);
  return {
    vo2max: Math.round(best.vo2max * 10) / 10,
    vlamax: Math.round(best.vlamax * 100) / 100,
    baselineScale: Math.round(best.baselineScale * 10) / 10,
    rmse: Math.round(rmse * 100) / 100,
    points: pts.length,
  };
}

export function cogganZones(ftp) {
  const z = [
    ["Z1 Recupero", 0, 55],
    ["Z2 Endurance", 56, 75],
    ["Z3 Tempo", 76, 90],
    ["Z4 Soglia", 91, 105],
    ["Z5 VO2max", 106, 120],
    ["Z6 Anaerobica", 121, 150],
    ["Z7 Neuromuscolare", 151, null],
  ];
  return z.map(([label, a, b]) => ({
    label,
    fromW: Math.round((ftp * a) / 100),
    toW: b == null ? null : Math.round((ftp * b) / 100),
    pct: b == null ? `>${a - 1}%` : `${a}–${b}%`,
  }));
}

export function threeZones(lt1, lt2) {
  return [
    { label: "Zona 1 (sotto LT1)", fromW: 0, toW: lt1, note: "Volume aerobico, ossidazione grassi" },
    { label: "Zona 2 (LT1–LT2)", fromW: lt1, toW: lt2, note: "Tempo / sweet spot, costo glicogeno alto" },
    { label: "Zona 3 (sopra LT2)", fromW: lt2, toW: null, note: "Soglia e VO2max, accumulo lattato" },
  ];
}

/** Zone FC Friel su LTHR. */
export function hrZonesFromLthr(lthr) {
  if (!lthr) return [];
  const z = [
    ["FC1 Recupero", 0, 81],
    ["FC2 Aerobica", 81, 89],
    ["FC3 Tempo", 90, 93],
    ["FC4 Sub-soglia", 94, 99],
    ["FC5a Soglia", 100, 102],
    ["FC5b VO2", 103, 106],
    ["FC5c Anaerobica", 107, null],
  ];
  return z.map(([label, a, b]) => ({
    label,
    fromBpm: Math.round((lthr * a) / 100),
    toBpm: b == null ? null : Math.round((lthr * b) / 100),
  }));
}

/** W' balance (Skiba, forma differenziale) su potenza 1 Hz. */
export function wPrimeBalance(power1Hz, cp, wPrime) {
  const out = new Array(power1Hz.length);
  let w = wPrime;
  let min = wPrime;
  for (let i = 0; i < power1Hz.length; i++) {
    const p = power1Hz[i];
    if (p > cp) w -= p - cp;
    else w += ((cp - p) * (wPrime - w)) / wPrime;
    if (w > wPrime) w = wPrime;
    out[i] = w;
    if (w < min) min = w;
  }
  return { series: out, min: Math.round(min), minPct: Math.round((min / wPrime) * 100) };
}

/** Durabilità: miglior 5' e 20' dopo `kjThreshold` di lavoro rispetto ai valori freschi. */
export function durability(entries, best, { kjThreshold = 1500, days = 120, today = todayLocal() } = {}) {
  const from = addDaysIso(today, -days);
  let p5 = 0;
  let p20 = 0;
  let sessions = 0;
  for (const e of entries ?? []) {
    if (e.entryType === "planned" || !e.series?.length) continue;
    if (!isCycling(e.sport)) continue;
    const day = String(e.date ?? "").slice(0, 10);
    if (day < from) continue;
    const { power } = resample1Hz(e.series);
    let acc = 0;
    let startIdx = -1;
    for (let i = 0; i < power.length; i++) {
      acc += power[i];
      if (acc / 1000 >= kjThreshold) {
        startIdx = i;
        break;
      }
    }
    if (startIdx < 0) continue;
    sessions++;
    const tail = power.slice(startIdx);
    p5 = Math.max(p5, meanMax(tail, 300));
    p20 = Math.max(p20, meanMax(tail, 1200));
  }
  const fresh5 = mmpAt(best, 300);
  const fresh20 = mmpAt(best, 1200);
  if (sessions === 0 || !fresh5) return { kjThreshold, sessions: 0 };
  return {
    kjThreshold,
    sessions,
    p5Fatigued: p5 || null,
    p20Fatigued: p20 || null,
    p5Pct: p5 && fresh5 ? Math.round((p5 / fresh5) * 100) : null,
    p20Pct: p20 && fresh20 ? Math.round((p20 / fresh20) * 100) : null,
  };
}

/**
 * Profilo fisiologico completo dell'atleta.
 * @param {any} profile UserProfile
 * @param {any[]} entries CalendarEntry (svolte)
 * @param {{records?: any, today?: string}} [opts]
 */
export function athleteModel(profile, entries, { records = null, today = todayLocal() } = {}) {
  const weightKg = Number(profile?.weightKg) || 70;
  const profileFtp = Number(profile?.ftpWatts) || 0;
  const best = bestMmp(entries, { days: 90, today, records });
  const best42 = bestMmp(entries, { days: 42, today });
  const cpFit = fitCriticalPower(best);
  const p5 = mmpAt(best, 300);
  const p20 = mmpAt(best, 1200);
  const p60 = mmpAt(best, 3600);
  const pmax = mmpAt(best, 1) || mmpAt(best, 5);

  const ftpCandidates = [];
  if (p60) ftpCandidates.push(p60);
  if (p20) ftpCandidates.push(0.95 * p20);
  if (cpFit) ftpCandidates.push(0.96 * cpFit.cp);
  const ftpEstimated = ftpCandidates.length ? Math.round(Math.max(...ftpCandidates)) : null;
  const ftp = profileFtp || ftpEstimated || 200;
  const submaximal = ftpEstimated != null && profileFtp > 0 && ftpEstimated < profileFtp * 0.9;

  const cp = cpFit?.cp ?? Math.round(ftp / 0.96);
  const wPrime = cpFit?.wPrime ?? Math.round(Math.min(25000, Math.max(9000, weightKg * 230)));

  const mapWatts = p5 && !submaximal ? p5 : Math.round(ftp / 0.8);
  let vo2max = Math.round(vo2FromPower(mapWatts, weightKg) * 10) / 10;

  const mlssTarget = Math.round(Math.min(cp * 0.97, ftp * 1.0));
  let vlamax = solveVlamaxForMlss(mlssTarget, vo2max, weightKg);
  const vlaSprint = vlamaxFromSprint(best, cp, weightKg);
  if (vlaSprint != null && !submaximal) {
    vlamax = Math.round((vlamax * 0.75 + vlaSprint * 0.25) * 100) / 100;
  }

  let baselineScale = 1;
  const calibration = calibrateOnTests(profile?.lactateTests, { vo2max, weightKg });
  if (calibration) {
    vo2max = calibration.vo2max;
    vlamax = calibration.vlamax;
    baselineScale = calibration.baselineScale;
  }

  const params = { vo2max, vlamax, weightKg, baselineScale };
  const maxW = Math.round(powerFromVo2(vo2max, weightKg));
  const mlss = findMlss(params, maxW);
  const lt1 = powerAtLactate(2.0, params, maxW) ?? Math.round(mlss * 0.72);
  const lt2 = Math.min(mlss, powerAtLactate(4.0, params, maxW) ?? mlss);

  const curve = [];
  let fatMax = { watts: 0, fatGh: 0 };
  for (let w = 60; w <= Math.round(maxW * 1.05); w += 10) {
    const sub = substrateAt(w, params);
    const la = lactateAfter(w, 240, params);
    curve.push({ watts: w, lactate: Math.round(la * 100) / 100, choGh: sub.choGh, fatGh: sub.fatGh, kcalH: sub.kcalH });
    if (sub.fatGh > fatMax.fatGh) fatMax = { watts: w, fatGh: sub.fatGh };
  }

  const effortCount = [120, 180, 300, 600, 1200].filter((s) => mmpAt(best42, s) > 0).length;
  let cpScore = cpFit ? Math.min(1, 0.3 + cpFit.points * 0.1 + (cpFit.r2 - 0.9) * 2) : 0.15;
  if (submaximal) cpScore *= 0.5;
  cpScore = Math.max(0.05, Math.min(1, cpScore * (0.6 + effortCount * 0.08)));
  const lactateScore = calibration
    ? Math.max(0.5, Math.min(1, 1 - calibration.rmse / 3))
    : Math.min(0.55, cpScore * 0.7);

  const warnings = [];
  if (submaximal) {
    warnings.push(
      `I migliori sforzi recenti (FTP stimata ${ftpEstimated} W) sono sotto l'FTP del profilo (${profileFtp} W): dati sub-massimali, inserisci un test.`,
    );
  }
  if (!cpFit) warnings.push("Mancano sforzi massimali 3–20 min negli ultimi 90 giorni: CP/W' stimati dall'FTP.");
  if (!calibration) warnings.push("Curva lattato modellata (Mader), non misurata: inserisci un test lattato per calibrarla.");

  return {
    weightKg,
    ftp,
    ftpProfile: profileFtp || null,
    ftpEstimated,
    cp,
    wPrime,
    cpFit,
    pmax: pmax || null,
    mapWatts,
    vo2max,
    vlamax,
    mlss,
    lt1,
    lt2,
    fatMax,
    best: MMP_WINDOWS.map((secs, i) => ({ secs, watts: best[i].watts, date: best[i].date })),
    curve,
    params,
    zones: {
      coggan: cogganZones(ftp),
      three: threeZones(lt1, lt2),
      hr: hrZonesFromLthr(profile?.lthr),
    },
    durability: durability(entries, best, { today }),
    calibration,
    confidence: {
      cp: confidenceLabel(cpScore),
      lactate: confidenceLabel(lactateScore),
      vo2max: confidenceLabel(p5 && !submaximal ? cpScore : cpScore * 0.6),
      vlamax: confidenceLabel(calibration ? lactateScore : cpScore * 0.6),
    },
    warnings,
  };
}

/** Riepilogo compatto per LLM / UI. */
export function modelSummary(m) {
  return {
    ftp: m.ftp,
    ftpStimata: m.ftpEstimated,
    cp: m.cp,
    wPrimeKj: Math.round(m.wPrime / 100) / 10,
    pmax: m.pmax,
    vo2max: m.vo2max,
    vlamax: m.vlamax,
    lt1: m.lt1,
    lt2: m.lt2,
    mlss: m.mlss,
    fatMax: m.fatMax,
    wkgFtp: Math.round((m.ftp / m.weightKg) * 100) / 100,
    confidenza: m.confidence,
    avvisi: m.warnings,
  };
}

/** Fabbisogno carboidrati (g/h) consigliato per durata e potenza media. */
export function fuelingPlan(model, { durationMin, avgWatts }) {
  const sub = substrateAt(avgWatts, model.params);
  const hours = durationMin / 60;
  let intakeGh = 0;
  if (durationMin > 75) intakeGh = Math.min(120, Math.max(30, Math.round(sub.choGh * 0.6)));
  if (durationMin > 150) intakeGh = Math.max(intakeGh, 80);
  const totalCho = Math.round(sub.choGh * hours);
  return {
    choBurnGh: sub.choGh,
    fatBurnGh: sub.fatGh,
    kcalH: sub.kcalH,
    totalChoBurn: totalCho,
    intakeGh,
    totalIntake: Math.round(intakeGh * hours),
    fluidsMlH: durationMin > 45 ? 500 + (avgWatts > model.lt2 ? 250 : 0) : 0,
    sodiumMgH: durationMin > 90 ? 500 : 0,
  };
}
