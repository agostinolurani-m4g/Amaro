import { normalizedPower, tssFromNp, zoneSeconds } from "./load.mjs";
import { lactateAfter, substrateAt, wPrimeBalance } from "./physiology.mjs";

/**
 * Espande blocchi workout (step / ramp / repeat, anche bozze coach) in segmenti.
 * @returns {{label:string, pct:number, endPct?:number, secs:number, kind?:string}[]}
 */
export function expandBlocks(blocks) {
  const out = [];
  for (const b of blocks ?? []) {
    if (!b) continue;
    if (b.type === "repeat" || (Array.isArray(b.steps) && b.count)) {
      const count = Math.max(1, Math.round(Number(b.count) || 1));
      for (let n = 0; n < count; n++) {
        for (const s of b.steps ?? []) {
          if (s.durationSecs > 0) {
            out.push({ label: s.label ?? s.kind ?? "", pct: s.targetPctFtp, secs: s.durationSecs, kind: s.kind });
          }
        }
      }
      continue;
    }
    if (b.type === "ramp") {
      out.push({
        label: b.label ?? "Rampa",
        pct: b.targetPctFtp,
        endPct: b.targetEndPctFtp,
        secs: b.durationSecs,
        kind: "ramp",
      });
      continue;
    }
    if (b.durationSecs > 0) {
      out.push({ label: b.label ?? b.kind ?? "", pct: b.targetPctFtp, secs: b.durationSecs, kind: b.kind });
    }
  }
  return out;
}

function segmentsToPower(segments, ftp) {
  const power = [];
  for (const s of segments) {
    for (let i = 0; i < s.secs; i++) {
      const pct = s.endPct != null ? s.pct + ((s.endPct - s.pct) * i) / Math.max(1, s.secs - 1) : s.pct;
      power.push(Math.round((ftp * pct) / 100));
    }
  }
  return power;
}

/**
 * Previsione di un workout per un atleta.
 * @param {any[]} blocks
 * @param {any} model risultato di athleteModel
 */
export function predictWorkout(blocks, model) {
  const ftp = model.ftp;
  const segments = expandBlocks(blocks);
  const power = segmentsToPower(segments, ftp);
  const durationSecs = power.length;
  if (durationSecs === 0) {
    return {
      durationSecs: 0,
      np: 0,
      ifactor: 0,
      tss: 0,
      kj: 0,
      choG: 0,
      zoneSecs: [],
      wbalMinPct: 100,
      feasibility: "ok",
      steps: [],
    };
  }
  const np = normalizedPower(power);
  const tss = tssFromNp(durationSecs, np, ftp);
  const kj = Math.round(power.reduce((a, b) => a + b, 0) / 1000);
  let cho = 0;
  const choCache = new Map();
  for (const w of power) {
    const key = Math.round(w / 5) * 5;
    let gh = choCache.get(key);
    if (gh == null) {
      gh = substrateAt(Math.max(30, key), model.params).choGh;
      choCache.set(key, gh);
    }
    cho += gh / 3600;
  }
  const wbal = wPrimeBalance(power, model.cp, model.wPrime);
  const feasibility = wbal.minPct < 0 ? "non_fattibile" : wbal.minPct < 15 ? "duro" : "ok";

  const steps = [];
  const seen = new Set();
  for (const s of segments) {
    const watts = Math.round((ftp * (s.endPct ?? s.pct)) / 100);
    const key = `${s.label}|${watts}|${s.secs}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const la = lactateAfter(watts, s.secs, model.params);
    steps.push({ label: s.label, watts, secs: s.secs, lactate: Math.round(la * 10) / 10 });
    if (steps.length >= 12) break;
  }

  return {
    durationSecs,
    np,
    ifactor: Math.round((np / ftp) * 100) / 100,
    tss: Math.round(tss),
    kj,
    choG: Math.round(cho),
    zoneSecs: zoneSeconds(power, ftp),
    wbalMinPct: wbal.minPct,
    feasibility,
    steps,
  };
}
