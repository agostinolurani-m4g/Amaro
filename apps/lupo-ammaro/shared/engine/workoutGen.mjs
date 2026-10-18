import { predictWorkout } from "./predictor.mjs";

export const COACH_PREFIX = "Coach · ";

/** Metadati tipi di sessione. tssH = TSS/ora indicativo usato dal planner. */
export const SESSION_TYPES = {
  recovery: { label: "Recupero attivo", hard: false, tssH: 30, fallback: "z2" },
  z2: { label: "Endurance Z2", hard: false, tssH: 52, fallback: "recovery" },
  tempo: { label: "Tempo", hard: false, tssH: 65, fallback: "z2" },
  sst: { label: "Sweet spot", hard: true, tssH: 76, fallback: "tempo" },
  threshold: { label: "Soglia", hard: true, tssH: 82, fallback: "sst" },
  overunder: { label: "Over-under", hard: true, tssH: 84, fallback: "threshold" },
  vo2: { label: "VO2max", hard: true, tssH: 80, fallback: "vo2_30_30" },
  vo2_30_30: { label: "VO2 30/30", hard: true, tssH: 74, fallback: "vo2" },
  anaerobic: { label: "Capacità anaerobica", hard: true, tssH: 70, fallback: "vo2_30_30" },
  lowcadence: { label: "Forza (bassa cadenza)", hard: true, tssH: 70, fallback: "sst" },
  durability: { label: "Lungo + durabilità", hard: true, tssH: 62, fallback: "z2" },
  ftp_test: { label: "Test FTP 20'", hard: true, tssH: 85, fallback: "threshold" },
  openers: { label: "Attivazione pre-gara", hard: false, tssH: 50, fallback: "z2" },
};

const WP_TUNED = new Set(["threshold", "overunder", "vo2", "vo2_30_30", "anaerobic"]);

function step(kind, secs, pct, label) {
  return { type: "step", kind, durationSecs: Math.round(secs), targetPctFtp: Math.round(pct), label };
}

function rep(count, on, off) {
  return { type: "repeat", count, steps: [on, off] };
}

function on(secs, pct, label) {
  return { kind: "interval", durationSecs: Math.round(secs), targetPctFtp: Math.round(pct), label };
}

function off(secs, pct = 50, label = "Recupero") {
  return { kind: "recovery", durationSecs: Math.round(secs), targetPctFtp: Math.round(pct), label };
}

function pick(table, level) {
  return table[Math.max(0, Math.min(table.length - 1, level - 1))];
}

function fmtMin(secs) {
  return secs % 60 === 0 ? `${secs / 60}'` : `${secs}"`;
}

/** Costruisce il "core" di ogni tipo. Restituisce blocchi core + metadati. */
function buildCore(type, level, pct, z2Pct) {
  switch (type) {
    case "recovery":
      return { core: [], title: "Recupero Z1", desc: "Pedalata sciolta sotto il 55% FTP, cadenza libera 85–95 rpm.", fillPct: 50, fillLabel: "Z1 sciolto" };
    case "z2":
      return {
        core: [],
        title: "Endurance Z2",
        desc: `Z2 stabile al ${z2Pct}% FTP (sotto LT1). Respirazione nasale, cadenza 85–95 rpm.`,
        fillPct: z2Pct,
        fillLabel: "Z2 · 85–95 rpm",
      };
    case "tempo": {
      const [n, m] = pick([[2, 12], [2, 15], [3, 12], [2, 20], [3, 20]], level);
      return {
        core: [rep(n, on(m * 60, pct, "Tempo"), off(300, 55))],
        title: `Tempo ${n}×${m}'`,
        desc: `${n}×${m}' al ${pct}% FTP, recupero 5'. Lavoro aerobico alto sotto LT2.`,
      };
    }
    case "sst": {
      const [n, m] = pick([[3, 10], [3, 12], [3, 15], [2, 20], [3, 20]], level);
      return {
        core: [rep(n, on(m * 60, pct, "Sweet spot · 85–95 rpm"), off(300, 50))],
        title: `Sweet spot ${n}×${m}'`,
        desc: `${n}×${m}' al ${pct}% FTP, recupero 5' Z1. Alza FTP con fatica contenuta.`,
      };
    }
    case "threshold": {
      const [n, m] = pick([[3, 8], [4, 8], [3, 12], [2, 15], [2, 20]], level);
      return {
        core: [rep(n, on(m * 60, pct, "Soglia"), off(Math.max(240, (m * 60) / 2), 50))],
        title: `Soglia ${n}×${m}'`,
        desc: `${n}×${m}' al ${pct}% FTP (attorno a MLSS), recuperi brevi. Ritmo costante, niente partenze forti.`,
      };
    }
    case "overunder": {
      const sets = pick([2, 3, 3, 4, 4], level);
      const reps = level >= 3 ? 4 : 3;
      const blocks = [];
      for (let s = 0; s < sets; s++) {
        blocks.push(rep(reps, on(120, Math.round(pct * 0.9), "Under"), { kind: "interval", durationSecs: 60, targetPctFtp: pct, label: "Over" }));
        if (s < sets - 1) blocks.push(step("recovery", 300, 50, "Recupero"));
      }
      return {
        core: blocks,
        title: `Over-under ${sets}×${reps}`,
        desc: `${sets} serie × ${reps} (2' al ${Math.round(pct * 0.9)}% / 1' al ${pct}%). Insegna a smaltire lattato sopra soglia.`,
      };
    }
    case "vo2": {
      const [n, m] = pick([[4, 3], [5, 3], [5, 4], [6, 4], [5, 5]], level);
      return {
        core: [rep(n, on(m * 60, pct, "VO2 · 95–105 rpm"), off(m * 60, 50))],
        title: `VO2max ${n}×${m}'`,
        desc: `${n}×${m}' al ${pct}% FTP, recupero pari. Calibrato sul tuo W' per finire l'ultima ripetuta al limite.`,
      };
    }
    case "vo2_30_30": {
      const [sets, reps] = pick([[2, 8], [2, 10], [3, 8], [3, 10], [3, 12]], level);
      const blocks = [];
      for (let s = 0; s < sets; s++) {
        blocks.push(rep(reps, on(30, pct, "30\" ON"), off(30, 50, "30\" OFF")));
        if (s < sets - 1) blocks.push(step("recovery", 300, 50, "Recupero serie"));
      }
      return {
        core: blocks,
        title: `30/30 ${sets}×${reps}`,
        desc: `${sets} serie da ${reps}× 30" al ${pct}% / 30" al 50%. Tempo vicino a VO2max con recupero incompleto (Rønnestad).`,
      };
    }
    case "anaerobic": {
      const [n, secs] = pick([[6, 20], [8, 20], [6, 30], [8, 30], [10, 30]], level);
      return {
        core: [rep(n, on(secs, pct, "Sprint seduto/in piedi"), off(secs <= 20 ? 220 : 270, 50))],
        title: `Anaerobica ${n}×${secs}"`,
        desc: `${n}× ${secs}" al ${pct}% FTP con recupero completo. Potenza e capacità glicolitica.`,
      };
    }
    case "lowcadence": {
      const [n, m] = pick([[4, 6], [5, 6], [4, 8], [5, 8], [6, 8]], level);
      return {
        core: [rep(n, on(m * 60, pct, "55–65 rpm seduto"), off(180, 55, "90+ rpm"))],
        title: `Forza ${n}×${m}' bassa cadenza`,
        desc: `${n}×${m}' al ${pct}% FTP a 55–65 rpm seduto, busto fermo. Recupero 3' agile.`,
      };
    }
    case "durability": {
      const [n, m] = pick([[1, 15], [1, 20], [2, 15], [1, 30], [2, 20]], level);
      return {
        core: n > 1 ? [rep(n, on(m * 60, pct, "Finale a fatica"), off(300, 60))] : [step("interval", m * 60, pct, "Finale a fatica")],
        coreAtEnd: true,
        title: `Lungo + finale ${n}×${m}'`,
        desc: `Z2 al ${z2Pct}% poi ${n}×${m}' al ${pct}% nell'ultimo terzo: resistenza alla fatica. Alimentazione 60–90 g/h.`,
        fillPct: z2Pct,
        fillLabel: "Z2 volume",
      };
    }
    case "ftp_test":
      return {
        core: [
          step("interval", 300, 105, "Pre-attivazione 5'"),
          step("recovery", 600, 50, "Recupero"),
          step("interval", 1200, 100, "TEST 20' massimale (ERG off)"),
        ],
        title: "Test FTP 20'",
        desc: "Protocollo Coggan: FTP ≈ 95% della media 20'. In modalità resistenza/SIM, gestisci il ritmo e chiudi in crescendo.",
        noFill: true,
      };
    case "openers":
      return {
        core: [
          rep(3, on(60, 115, "1' brillante"), off(120, 50)),
          rep(3, on(15, 160, "Sprint 15\""), off(165, 50)),
        ],
        title: "Attivazione pre-gara",
        desc: "Breve e brillante: 3×1' al 115% e 3 sprint 15\". Gambe sveglie senza fatica.",
        fillPct: z2Pct,
        fillLabel: "Z2",
      };
    default:
      return { core: [], title: "Endurance", desc: "Z2", fillPct: z2Pct, fillLabel: "Z2" };
  }
}

const BASE_PCT = {
  tempo: 82,
  sst: 90,
  threshold: 98,
  overunder: 106,
  vo2: 115,
  vo2_30_30: 128,
  anaerobic: 165,
  lowcadence: 86,
  durability: 87,
};

const PCT_RANGE = {
  threshold: [94, 102],
  overunder: [103, 112],
  vo2: [106, 125],
  vo2_30_30: [115, 145],
  anaerobic: [140, 200],
};

function blocksSecs(blocks) {
  return blocks.reduce((s, b) => {
    if (b.type === "repeat") return s + b.count * b.steps.reduce((x, st) => x + st.durationSecs, 0);
    return s + b.durationSecs;
  }, 0);
}

function assemble(type, level, pct, durationMin, z2Pct) {
  const c = buildCore(type, level, pct, z2Pct);
  const target = Math.round(durationMin * 60);
  const easy = type === "recovery" || type === "z2";
  const warmSecs = easy ? 300 : type === "ftp_test" || type === "openers" ? 900 : 600;
  const coolSecs = easy ? 300 : 480;
  const warm = easy
    ? step("warmup", warmSecs, 50, "Avvio")
    : { type: "ramp", durationSecs: warmSecs, targetPctFtp: 50, targetEndPctFtp: 75, label: "Riscaldamento progressivo" };
  const cool = step("cooldown", coolSecs, 45, "Defaticamento");
  const coreSecs = blocksSecs(c.core);
  const fill = target - warmSecs - coolSecs - coreSecs;
  const fillBlock =
    !c.noFill && fill >= 120 ? step("steady", fill, c.fillPct ?? z2Pct, c.fillLabel ?? "Z2 volume") : null;

  let blocks;
  if (c.coreAtEnd) blocks = [warm, ...(fillBlock ? [fillBlock] : []), ...c.core, cool];
  else blocks = [warm, ...c.core, ...(fillBlock ? [fillBlock] : []), cool];
  return { blocks, overflow: fill < -300, title: c.title, desc: c.desc };
}

/**
 * Genera un workout ERG personalizzato e validato (W' balance / TSS).
 * @param {{type:string, durationMin:number, level?:number, model:any, nameSuffix?:string}} opts
 */
export function generateWorkout({ type, durationMin, level = 2, model, nameSuffix = "" }) {
  const t = SESSION_TYPES[type] ? type : "z2";
  const lt1Pct = model.lt1 && model.ftp ? (model.lt1 / model.ftp) * 100 : 70;
  const z2Pct = Math.round(Math.min(72, Math.max(60, lt1Pct * 0.9)));
  let lvl = Math.max(1, Math.min(5, Math.round(level)));
  let pct = BASE_PCT[t] ?? z2Pct;

  let built = assemble(t, lvl, pct, durationMin, z2Pct);
  while (built.overflow && lvl > 1) {
    lvl -= 1;
    built = assemble(t, lvl, pct, durationMin, z2Pct);
  }

  let prediction = predictWorkout(built.blocks, model);
  if (WP_TUNED.has(t)) {
    const [lo, hi] = PCT_RANGE[t];
    for (let i = 0; i < 10 && prediction.wbalMinPct < 10 && pct > lo; i++) {
      pct -= 2;
      built = assemble(t, lvl, pct, durationMin, z2Pct);
      prediction = predictWorkout(built.blocks, model);
    }
    if (prediction.wbalMinPct < 0 && lvl > 1) {
      lvl -= 1;
      built = assemble(t, lvl, pct, durationMin, z2Pct);
      prediction = predictWorkout(built.blocks, model);
    }
    if (t.startsWith("vo2") || t === "anaerobic") {
      for (let i = 0; i < 8 && prediction.wbalMinPct > 40 && pct < hi; i++) {
        const nextPct = pct + 2;
        const candidate = assemble(t, lvl, nextPct, durationMin, z2Pct);
        const p = predictWorkout(candidate.blocks, model);
        if (p.wbalMinPct < 15) break;
        pct = nextPct;
        built = candidate;
        prediction = p;
      }
    }
  }

  const watts = Math.round((model.ftp * pct) / 100);
  const name = `${COACH_PREFIX}${built.title}${nameSuffix ? ` ${nameSuffix}` : ""}`.slice(0, 80);
  const desc = `${built.desc} Target ≈ ${BASE_PCT[t] ? `${watts} W` : `${Math.round((model.ftp * z2Pct) / 100)} W`}. Previsto: TSS ${prediction.tss}, IF ${prediction.ifactor}, ${prediction.kj} kJ, CHO ~${prediction.choG} g.`;
  return {
    name,
    description: desc.slice(0, 400),
    blocks: built.blocks,
    sessionType: t,
    level: lvl,
    prediction,
  };
}

export function substituteType(type, avoid = []) {
  let t = type;
  const seen = new Set();
  while (avoid.includes(t) && !seen.has(t)) {
    seen.add(t);
    t = SESSION_TYPES[t]?.fallback ?? "z2";
  }
  return t;
}

export function describeSteps(blocks) {
  return (blocks ?? [])
    .map((b) => {
      if (b.type === "repeat") {
        const inner = b.steps.map((s) => `${fmtMin(s.durationSecs)}@${s.targetPctFtp}%`).join("/");
        return `${b.count}×(${inner})`;
      }
      if (b.type === "ramp") return `${fmtMin(b.durationSecs)} ${b.targetPctFtp}→${b.targetEndPctFtp}%`;
      return `${fmtMin(b.durationSecs)}@${b.targetPctFtp}%`;
    })
    .join(" + ");
}
