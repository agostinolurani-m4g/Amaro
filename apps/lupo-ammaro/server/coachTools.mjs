// Strumenti del coach: tutti i numeri vengono dal motore deterministico (shared/engine).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { searchWeb } from "./webSearch.mjs";
import { activityBundle, athleteProfile, listActivities, NOT_LINKED } from "./strava.mjs";
import { sportFromStrava } from "../shared/engine/sports.mjs";
import {
  COGGAN_ZONES,
  MMP_WINDOWS,
  computePmc,
  loadSnapshot,
  resample1Hz,
  sessionMetrics,
  weeklySummary,
} from "../shared/engine/load.mjs";
import {
  athleteModel,
  bestMmp,
  fuelingPlan,
  lactateAfter,
  modelSummary,
  steadyLactate,
  substrateAt,
  wPrimeBalance,
} from "../shared/engine/physiology.mjs";
import { predictWorkout } from "../shared/engine/predictor.mjs";
import { SESSION_TYPES, describeSteps, generateWorkout } from "../shared/engine/workoutGen.mjs";
import { adaptSession, generatePlan, readinessScore } from "../shared/engine/planner.mjs";
import { addDaysIso, todayLocal, WEEKDAYS } from "../shared/engine/dates.mjs";
import { parseCards, searchCards } from "../shared/knowledge/index.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KNOWLEDGE_DIR = path.join(__dirname, "..", "shared", "knowledge");

let cardsCache = null;
export function knowledgeCards() {
  if (cardsCache) return cardsCache;
  const files = {};
  try {
    for (const name of fs.readdirSync(KNOWLEDGE_DIR)) {
      if (name.endsWith(".md")) files[name] = fs.readFileSync(path.join(KNOWLEDGE_DIR, name), "utf8");
    }
  } catch {
    // knowledge opzionale
  }
  cardsCache = parseCards(files);
  return cardsCache;
}

const STEP_KINDS = ["warmup", "steady", "interval", "recovery", "cooldown"];
const TYPE_KEYS = Object.keys(SESSION_TYPES);

const MMP_LABELS = MMP_WINDOWS.map((s) => (s < 60 ? `${s}s` : `${Math.round(s / 60)}m`));

function fn(name, description, properties = {}, required = []) {
  return {
    type: "function",
    function: {
      name,
      description,
      parameters: { type: "object", properties, ...(required.length ? { required } : {}) },
    },
  };
}

const blockSchema = {
  type: "array",
  description: "Blocchi: step {kind,durationSecs,targetPctFtp}, ramp {durationSecs,targetPctFtp,targetEndPctFtp}, repeat {count, steps:[on, off]}",
  items: {
    type: "object",
    properties: {
      type: { type: "string", enum: ["step", "ramp", "repeat"] },
      kind: { type: "string", enum: STEP_KINDS },
      durationSecs: { type: "integer" },
      targetPctFtp: { type: "integer" },
      targetEndPctFtp: { type: "integer" },
      label: { type: "string" },
      count: { type: "integer" },
      steps: {
        type: "array",
        items: {
          type: "object",
          properties: {
            kind: { type: "string", enum: STEP_KINDS },
            durationSecs: { type: "integer" },
            targetPctFtp: { type: "integer" },
            label: { type: "string" },
          },
        },
      },
    },
  },
};

const sessionSchema = {
  type: "array",
  items: {
    type: "object",
    properties: {
      date: { type: "string", description: "YYYY-MM-DD" },
      name: { type: "string" },
      durationMin: { type: "number" },
      sessionType: { type: "string", enum: TYPE_KEYS },
      description: { type: "string" },
      workoutName: { type: "string" },
    },
    required: ["date", "name", "durationMin"],
  },
};

export const TOOLS = [
  fn("cerca_attivita", "Sessioni svolte recenti con NP, TSS, IF, FC, RPE, compliance.", {
    giorni: { type: "integer", description: "Giorni indietro (default 28)" },
  }),
  fn("analisi_sessione", "Analisi completa di una sessione (id o data YYYY-MM-DD; vuoto = ultima): NP, IF, TSS, zone, W'bal minimo, disaccoppiamento, lattato stimato, confronto col pianificato.", {
    id: { type: "string" },
    data: { type: "string" },
  }),
  fn("carico_allenamento", "CTL/ATL/TSB oggi, ramp rate, monotonia, ACWR e proiezione 14 giorni dal piano.", {}),
  fn("trend", "Andamento settimanale: TSS svolto vs pianificato, ore, distribuzione zone, compliance.", {
    settimane: { type: "integer", description: "Settimane (default 8)" },
  }),
  fn("profilo_fisiologico", "Profilo stimato: FTP, CP, W', VO2max, VLamax, LT1, LT2, MLSS, FatMax, zone, durabilità, confidenza.", {}),
  fn("stima_lattato", "Lattato (mmol/l), carboidrati e grassi g/h stimati a una o più potenze.", {
    watt: { type: "array", items: { type: "number" }, description: "Potenze in W" },
    durataMin: { type: "number", description: "Durata a potenza costante (default 10)" },
  }, ["watt"]),
  fn("curva_lattato", "Grafico curva lattato e consumo carboidrati vs potenza.", {}),
  fn("curva_potenza", "Curva potenza-durata ultimi N giorni vs record, con CP/W'.", {
    giorni: { type: "integer", description: "Default 90" },
  }),
  fn("record_personali", "Record di potenza, durata, distanza e lavoro.", {}),
  fn("crea_grafico", "Grafico dai dati reali.", {
    kind: { type: "string", enum: ["pmc", "weekly_tss", "power_curve", "session", "lactate", "trend"] },
    sessionId: { type: "string" },
    data: { type: "string" },
    titolo: { type: "string" },
  }, ["kind"]),
  fn("genera_allenamento", "Genera un workout ERG calibrato sull'atleta (W'bal, zone) e ne predice TSS/IF/kJ/CHO/fattibilità.", {
    tipo: { type: "string", enum: TYPE_KEYS },
    durataMin: { type: "number" },
    livello: { type: "integer", description: "1 facile … 5 molto duro (default 2)" },
  }, ["tipo", "durataMin"]),
  fn("crea_allenamento", "Crea un workout ERG personalizzato a blocchi (%FTP). Viene validato con il predittore.", {
    name: { type: "string" },
    description: { type: "string" },
    blocks: blockSchema,
  }, ["name", "blocks"]),
  fn("predici_allenamento", "Predice TSS, IF, kJ, CHO, W'bal minimo e lattato di un workout a blocchi senza salvarlo.", {
    blocks: blockSchema,
  }, ["blocks"]),
  fn("lista_allenamenti", "Allenamenti salvati in WattLab.", {}),
  fn("genera_piano", "Genera il piano periodizzato (eventi, disponibilità, preferenze atleta) per le prossime settimane, con workout e TSS previsti.", {
    settimane: { type: "integer", description: "1-8 (default 4)" },
  }),
  fn("adatta_oggi", "Adatta la sessione di oggi alla prontezza (check-in + TSB).", {}),
  fn("sposta_sessione", "Sposta una sessione pianificata a un'altra data.", {
    da: { type: "string", description: "Data attuale YYYY-MM-DD" },
    a: { type: "string", description: "Nuova data YYYY-MM-DD (vuoto = primo giorno libero)" },
  }, ["da"]),
  fn("aggiorna_piano_settimanale", "Sostituisce sessioni pianificate in date specifiche (modifiche puntuali).", {
    sessioni: sessionSchema,
  }, ["sessioni"]),
  fn("preferenze_atleta", "Legge preferenze, disponibilità, eventi, vincoli. Con 'vincolo' registra un nuovo vincolo permanente.", {
    vincolo: { type: "string" },
  }),
  fn("registra_impegno", "Registra un impegno personale (lavoro, viaggio, cena) o una fascia in cui l'atleta può allenarsi.", {
    etichetta: { type: "string" },
    data: { type: "string", description: "YYYY-MM-DD (impegno puntuale)" },
    giornoSettimana: { type: "string", enum: WEEKDAYS, description: "Per impegni ricorrenti" },
    fascia: { type: "string", enum: ["morning", "afternoon", "evening", "all"] },
    tipo: { type: "string", enum: ["busy", "window"], description: "busy = occupato; window = solo in questa fascia" },
  }, ["etichetta"]),
  fn("carburante", "Piano alimentazione: carboidrati g/h, liquidi, sodio per durata e potenza.", {
    durataMin: { type: "number" },
    wattMedi: { type: "number" },
    tipo: { type: "string", enum: TYPE_KEYS },
  }, ["durataMin"]),
  fn("consulta_knowledge", "Schede scientifiche WattLab (allenamento, fisiologia, nutrizione).", {
    query: { type: "string" },
  }, ["query"]),
  fn("cerca_web", "Cerca sul web (studi, metodi, eventi). Query generica, senza dati personali.", {
    query: { type: "string" },
  }, ["query"]),
  fn("strava_attivita", "Attività Strava (strada, MTB, corsa, indoor) non necessariamente già nel calendario.", {
    giorni: { type: "integer" },
    sport: { type: "string" },
  }),
  fn("strava_dettaglio", "Dettaglio attività Strava per id: watt, FC, lap.", {
    id: { type: "string" },
  }, ["id"]),
  fn("strava_confronta", "Volume Strava per sport.", { giorni: { type: "integer" } }),
  fn("strava_profilo", "Peso, FTP, zone e totali dell'account Strava.", {}),
];

const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.function.name, t]));

const CORE = ["cerca_attivita", "carico_allenamento", "profilo_fisiologico", "consulta_knowledge"];
const GROUPS = [
  { re: /session|uscit|ieri|analizz|com'?\s?è andat|com'?e andat|ultima/, tools: ["analisi_sessione", "crea_grafico"] },
  { re: /lattat|soglia|vo2|vlamax|fatmax|zon[ae]|lt1|lt2|mlss|\bcp\b|w'|w prime|profilo|fisiolog/, tools: ["stima_lattato", "curva_lattato", "curva_potenza", "record_personali"] },
  { re: /pian|settiman|programm|periodizz|gara|evento|granfondo|mese|macrocicl|blocco/, tools: ["genera_piano", "preferenze_atleta", "trend", "aggiorna_piano_settimanale", "sposta_sessione"] },
  { re: /allenament|workout|ripetut|intervall|crea|genera|sweet|sst|30\/30|over|test ftp/, tools: ["genera_allenamento", "crea_allenamento", "predici_allenamento", "lista_allenamenti"] },
  { re: /oggi|stanc|dormit|fatic|dolor|adatt|riposo|tempo libero|poco tempo|malat|influenz/, tools: ["adatta_oggi", "sposta_sessione", "preferenze_atleta"] },
  { re: /spost|anticip|posticip|non posso|impegn|salt|cambia|fuori|viagg|cena|lavoro/, tools: ["sposta_sessione", "aggiorna_piano_settimanale", "preferenze_atleta", "registra_impegno"] },
  { re: /mangi|carbo|gel|aliment|idrat|carburant|fuel|bere|borracc|nutriz/, tools: ["carburante", "stima_lattato"] },
  { re: /grafic|chart|curva|trend|andament|storic|progress|record/, tools: ["crea_grafico", "trend", "curva_potenza", "record_personali"] },
  { re: /web|internet|online|studi|ricerca|cerca/, tools: ["cerca_web"] },
  { re: /preferisc|non mi piace|odio|amo|mi piace|vincol|disponib/, tools: ["preferenze_atleta", "genera_piano"] },
  { re: /strava|corsa|corso|mtb|gravel|strada|outdoor|run|uscita fuori/, tools: ["strava_attivita", "strava_dettaglio", "strava_confronta", "strava_profilo"] },
];

/** Subset di tool per il messaggio (meno token per modelli locali). */
export function toolsForMessage(message, { all = false } = {}) {
  if (all) return TOOLS;
  const m = String(message ?? "").toLowerCase();
  const names = new Set(CORE);
  let matched = false;
  for (const g of GROUPS) {
    if (g.re.test(m)) {
      matched = true;
      g.tools.forEach((t) => names.add(t));
    }
  }
  if (!matched) {
    ["analisi_sessione", "genera_allenamento", "genera_piano", "adatta_oggi", "crea_grafico", "carburante"].forEach((t) =>
      names.add(t),
    );
  }
  return [...names].map((n) => TOOL_BY_NAME.get(n)).filter(Boolean);
}

// ---------- contesto motore ----------

function isoDay(value) {
  return String(value ?? "").slice(0, 10);
}

function dayFullyBusy(lifeBlocks, iso) {
  const d = new Date(`${iso}T12:00:00`);
  const wd = WEEKDAYS[(d.getDay() + 6) % 7];
  return (lifeBlocks ?? []).some(
    (b) =>
      b.kind === "busy" &&
      b.slot === "all" &&
      (b.date === iso || (!b.date && b.weekday === wd)),
  );
}

/** Modello atleta + carico calcolati una volta per richiesta. */
export function engineFor(ctx) {
  if (ctx.__engine) return ctx.__engine;
  const today = ctx.today || todayLocal();
  const profile = ctx.profile ?? {};
  const activities = ctx.activities ?? [];
  const planned = ctx.planned ?? [];
  const model = athleteModel(profile, activities, { records: ctx.records ?? null, today });
  const ftp = Number(profile.ftpWatts) || model.ftp;
  const lthr = Number(profile.lthr) || 0;
  const pmc = computePmc([...activities, ...planned], { ftp, lthr, days: 120, futureDays: 28, today });
  const load = loadSnapshot(pmc, today);
  const engine = { today, profile, activities, planned, model, ftp, lthr, pmc, load };
  Object.defineProperty(ctx, "__engine", { value: engine, enumerable: false });
  return engine;
}

function findActivity(ctx, { id, data }) {
  const activities = ctx.activities ?? [];
  if (id) {
    const match = activities.find((a) => a.id === id);
    if (match) return match;
  }
  if (data) {
    const day = isoDay(data);
    const sameDay = activities.filter((a) => isoDay(a.date) === day);
    if (sameDay.length) return sameDay.sort((a, b) => (b.durationSecs ?? 0) - (a.durationSecs ?? 0))[0];
  }
  if (!id && !data) {
    return [...activities].sort((a, b) => isoDay(b.date).localeCompare(isoDay(a.date)))[0] ?? null;
  }
  return null;
}

/** Numeri da array, numero o stringa ("[250, 280]", "250 W"): i modelli locali sono poco rigorosi. */
function numberList(value) {
  if (value == null) return [];
  const raw = Array.isArray(value) ? value : [value];
  const out = [];
  for (const v of raw) {
    if (typeof v === "number") out.push(v);
    else for (const m of String(v).matchAll(/\d+(?:[.,]\d+)?/g)) out.push(Number(m[0].replace(",", ".")));
  }
  return out.filter((n) => Number.isFinite(n));
}

function num(value, fallback) {
  const n = numberList(value)[0];
  return n == null ? fallback : n;
}

function round1(v) {
  return Math.round(v * 10) / 10;
}

function minutes(secs) {
  return Math.round((secs ?? 0) / 60);
}

// ---------- grafici ----------

function pmcChart(e, title) {
  const from = addDaysIso(e.today, -56);
  const rows = e.pmc.filter((p) => p.date >= from);
  const past = (key) => rows.map((p) => (p.projected ? null : p[key]));
  const future = (key) => rows.map((p) => (p.projected || p.date === e.today ? p[key] : null));
  return {
    kind: "pmc",
    title: title || "Carico (CTL / ATL / TSB) con proiezione piano",
    x: rows.map((p) => p.date),
    yLabel: "TSS / fitness",
    series: [
      { label: "CTL", data: past("ctl"), color: "#4ade80" },
      { label: "ATL", data: past("atl"), color: "#ff0a54" },
      { label: "TSB", data: past("tsb"), color: "#60a5fa" },
      { label: "CTL previsto", data: future("ctl"), color: "#86efac" },
      { label: "TSB previsto", data: future("tsb"), color: "#93c5fd" },
    ],
  };
}

function weeklyRows(e, weeks) {
  const from = addDaysIso(e.today, -7 * weeks);
  const all = [...e.activities, ...e.planned].filter((a) => isoDay(a.date) >= from);
  return weeklySummary(all, { ftp: e.ftp, lthr: e.lthr }).slice(-weeks - 1);
}

function weeklyChart(e, title) {
  const rows = weeklyRows(e, 12);
  return {
    kind: "weekly_tss",
    title: title || "TSS settimanale (svolto vs pianificato)",
    x: rows.map((r) => r.weekStart),
    yLabel: "TSS",
    series: [
      { label: "Svolto", data: rows.map((r) => r.doneTss), color: "#ff0a54" },
      { label: "Pianificato", data: rows.map((r) => r.plannedTss), color: "#8a93a8" },
    ],
  };
}

function trendChart(e, title) {
  const rows = weeklyRows(e, 12).filter((r) => r.weekStart <= e.today);
  return {
    kind: "trend",
    title: title || "Distribuzione zone per settimana (ore)",
    x: rows.map((r) => r.weekStart),
    yLabel: "ore",
    series: COGGAN_ZONES.slice(0, 6).map((z, i) => ({
      label: z.label,
      data: rows.map((r) => round1((r.zoneSecs[i] ?? 0) / 3600)),
      color: z.color,
    })),
  };
}

function powerCurveChart(e, days, title) {
  const recent = bestMmp(e.activities, { days, today: e.today }).map((b) => b.watts);
  const allTime = bestMmp(e.activities, { days: 3650, today: e.today }).map((b) => b.watts);
  const idx = MMP_WINDOWS.map((_, i) => i).filter((i) => allTime[i] > 0 || recent[i] > 0);
  if (!idx.length) return null;
  const m = e.model;
  return {
    kind: "power_curve",
    title: title || `Curva potenza: ultimi ${days} giorni vs storico`,
    x: idx.map((i) => MMP_LABELS[i]),
    yLabel: "W",
    series: [
      { label: `Ultimi ${days} g`, data: idx.map((i) => recent[i] || null), color: "#ff0a54" },
      { label: "Storico", data: idx.map((i) => allTime[i] || null), color: "#8a93a8" },
      {
        label: "Modello CP",
        data: idx.map((i) => {
          const t = MMP_WINDOWS[i];
          return t >= 120 && t <= 3600 ? Math.round(m.cp + m.wPrime / t) : null;
        }),
        color: "#60a5fa",
      },
    ],
  };
}

function lactateChart(e, title) {
  const curve = e.model.curve ?? [];
  if (!curve.length) return null;
  return {
    kind: "lactate",
    title: title || `Curva lattato stimata (LT1 ${e.model.lt1} W · LT2 ${e.model.lt2} W)`,
    x: curve.map((p) => p.watts),
    yLabel: "mmol/l · g/h ÷ 10",
    series: [
      { label: "Lattato mmol/l", data: curve.map((p) => p.lactate), color: "#ff0a54" },
      { label: "CHO g/h ÷10", data: curve.map((p) => round1(p.choGh / 10)), color: "#facc15" },
      { label: "Grassi g/h ÷10", data: curve.map((p) => round1(p.fatGh / 10)), color: "#4ade80" },
    ],
  };
}

function sessionChart(activity, series, title) {
  if (!series?.length) return null;
  return {
    kind: "session",
    title: title || activity.title || "Sessione",
    x: series.map((p) => p.t),
    yLabel: "W",
    sessionSeries: series,
    series: [{ label: "Potenza", data: series.map((p) => p.power ?? null), color: "#ff0a54" }],
  };
}

function pushChart(state, chart) {
  if (!chart) return false;
  if (state.artifacts.some((a) => a.type === "chart" && a.chart?.kind === chart.kind && a.chart?.title === chart.title)) return true;
  state.artifacts.push({ type: "chart", chart });
  return true;
}

// ---------- workout / piano ----------

function cleanBlocks(rawBlocks) {
  const out = [];
  for (const b of Array.isArray(rawBlocks) ? rawBlocks : []) {
    if (!b) continue;
    if (b.type === "repeat" || (b.count && Array.isArray(b.steps))) {
      const steps = (b.steps ?? [])
        .filter((s) => Number(s.durationSecs) > 0 && Number(s.targetPctFtp) > 0)
        .map((s) => ({
          kind: STEP_KINDS.includes(s.kind) ? s.kind : "interval",
          durationSecs: Math.round(Number(s.durationSecs)),
          targetPctFtp: Math.min(250, Math.round(Number(s.targetPctFtp))),
          label: s.label ? String(s.label).slice(0, 60) : undefined,
        }));
      if (steps.length) out.push({ type: "repeat", count: Math.min(40, Math.max(1, Math.round(Number(b.count ?? 1)))), steps });
      continue;
    }
    if (b.type === "ramp" && Number(b.durationSecs) > 0) {
      out.push({
        type: "ramp",
        durationSecs: Math.round(Number(b.durationSecs)),
        targetPctFtp: Math.round(Number(b.targetPctFtp ?? 50)),
        targetEndPctFtp: Math.round(Number(b.targetEndPctFtp ?? b.targetPctFtp ?? 75)),
        label: b.label ? String(b.label).slice(0, 60) : undefined,
      });
      continue;
    }
    if (Number(b.durationSecs) > 0 && Number(b.targetPctFtp) > 0) {
      out.push({
        type: "step",
        kind: STEP_KINDS.includes(b.kind) ? b.kind : "steady",
        durationSecs: Math.round(Number(b.durationSecs)),
        targetPctFtp: Math.min(250, Math.round(Number(b.targetPctFtp))),
        label: b.label ? String(b.label).slice(0, 60) : undefined,
      });
    }
  }
  return out;
}

function predictionText(p) {
  return `${minutes(p.durationSecs)} min · TSS ${p.tss} · IF ${p.ifactor} · NP ${p.np} W · ${p.kj} kJ · CHO ~${p.choG} g · W'bal min ${p.wbalMinPct}% · ${p.feasibility}`;
}

function addWorkout(state, draft) {
  if (state.workouts.some((w) => w.name === draft.name)) return;
  state.workouts.push(draft);
  state.artifacts.push({ type: "workout", draft });
}

function plannedToSession(p) {
  return {
    date: isoDay(p.date),
    name: p.title,
    durationMin: minutes(p.durationSecs ?? 3600),
    description: p.notes,
    plannedTss: p.plannedTss,
    sessionType: p.sessionType,
    workoutId: p.workoutId,
  };
}

function setPlan(state, sessions, mode, weeks) {
  state.planUpdate = sessions;
  state.planMode = mode;
  state.artifacts = state.artifacts.filter((a) => a.type !== "plan");
  state.artifacts.push({ type: "plan", sessions, weeks });
}

function cleanPlanSessions(list, e) {
  return (Array.isArray(list) ? list : [])
    .filter((s) => s && s.date && s.name)
    .map((s) => {
      const type = TYPE_KEYS.includes(s.sessionType) ? s.sessionType : undefined;
      const durationMin = Math.max(0, Math.round(Number(s.durationMin ?? 0)));
      const out = {
        date: isoDay(s.date),
        name: String(s.name).slice(0, 80),
        durationMin,
        description: s.description ? String(s.description).slice(0, 240) : undefined,
        workoutName: s.workoutName ? String(s.workoutName) : undefined,
        sessionType: type,
        plannedTss: type ? Math.round((durationMin / 60) * SESSION_TYPES[type].tssH) : undefined,
      };
      if (type && !out.workoutName && e) {
        const draft = generateWorkout({ type, durationMin: Math.max(20, durationMin), level: 2, model: e.model });
        out.workoutName = draft.name;
        out.plannedTss = draft.prediction.tss;
        out.__draft = draft;
      }
      return out;
    })
    .filter((s) => s.date >= (e?.today ?? "0000"));
}

// ---------- esecuzione ----------

/** Esegue un tool. Ritorna stringa (o Promise<string>) per il modello. */
export function runTool(name, args, ctx, state) {
  const e = engineFor(ctx);
  const m = e.model;

  switch (name) {
    case "cerca_attivita": {
      const giorni = Math.min(365, Math.max(1, Number(args.giorni ?? 28)));
      const from = addDaysIso(e.today, -giorni);
      const rows = e.activities
        .filter((a) => isoDay(a.date) >= from)
        .sort((a, b) => isoDay(a.date).localeCompare(isoDay(b.date)))
        .slice(-40)
        .map((a) => ({
          id: a.id,
          data: isoDay(a.date),
          titolo: a.title,
          min: minutes(a.durationSecs),
          np: a.np ?? null,
          tss: a.tss != null ? Math.round(a.tss) : null,
          if: a.ifactor ?? null,
          fc: a.avgHr ?? null,
          rpe: a.rpe ?? null,
          compliance: a.compliance ?? null,
          tipo: a.sessionType ?? null,
          sport: a.sport ?? null,
        }));
      return rows.length ? JSON.stringify(rows) : `Nessuna sessione negli ultimi ${giorni} giorni.`;
    }

    case "dettaglio_sessione":
    case "analisi_sessione": {
      const activity = findActivity(ctx, { id: args.id ? String(args.id) : undefined, data: args.data ? String(args.data) : undefined });
      if (!activity) return "Sessione non trovata. Usa cerca_attivita per id o data.";
      const series = ctx.sessionSeries?.[activity.id];
      const out = {
        id: activity.id,
        data: isoDay(activity.date),
        titolo: activity.title,
        min: minutes(activity.durationSecs),
        wMedi: activity.avgPower ?? null,
        np: activity.np ?? null,
        if: activity.ifactor ?? null,
        tss: activity.tss != null ? Math.round(activity.tss) : null,
        kj: activity.kj ?? null,
        fcMedia: activity.avgHr ?? null,
        disaccoppiamento: activity.decoupling ?? null,
        rpe: activity.rpe ?? null,
        sensazioni: activity.feel ?? null,
        tssPianificato: activity.plannedTss ?? null,
        compliance: activity.compliance ?? null,
      };
      if (activity.zoneSecs?.length) {
        const tot = activity.zoneSecs.reduce((a, b) => a + b, 0) || 1;
        out.zone = Object.fromEntries(COGGAN_ZONES.map((z, i) => [z.id, `${Math.round(((activity.zoneSecs[i] ?? 0) / tot) * 100)}%`]));
      }
      if (series?.length) {
        const sm = sessionMetrics(series, { ftp: e.ftp, lthr: e.lthr });
        const { power } = resample1Hz(series);
        const wb = wPrimeBalance(power, m.cp, m.wPrime);
        out.wbalMinPct = wb.minPct;
        out.np = out.np ?? sm.np ?? null;
        out.disaccoppiamento = out.disaccoppiamento ?? sm.decoupling ?? null;
        const best5 = sm.mmp?.[MMP_WINDOWS.indexOf(300)] ?? 0;
        const best20 = sm.mmp?.[MMP_WINDOWS.indexOf(1200)] ?? 0;
        out.migliori = { "5m": best5 || null, "20m": best20 || null };
        if (best5) out.lattatoPicco5m = round1(lactateAfter(best5, 300, m.params));
        pushChart(state, sessionChart(activity, series, activity.title));
      } else if (activity.np) {
        out.lattatoStimatoNp = round1(lactateAfter(activity.np, 600, m.params));
      }
      if (activity.coachComment) out.commentoPrecedente = activity.coachComment;
      return JSON.stringify(out);
    }

    case "carico_allenamento": {
      const l = e.load;
      const proj = e.pmc.filter((p) => p.projected).slice(0, 14);
      const end = proj[proj.length - 1];
      return JSON.stringify({
        ctl: l.ctl,
        atl: l.atl,
        tsb: l.tsb,
        stato: l.status,
        tss7g: l.weekTss,
        tss7gPrecedenti: l.prevWeekTss,
        rampRate: l.rampRate,
        monotonia: l.monotony,
        strain: l.strain,
        acwr: l.acwr,
        nota: l.summary,
        proiezione14g: end ? { data: end.date, ctl: end.ctl, tsb: end.tsb } : null,
        ftpUsato: e.ftp,
      });
    }

    case "trend": {
      const weeks = Math.min(26, Math.max(2, Number(args.settimane ?? 8)));
      const rows = weeklyRows(e, weeks).map((r) => {
        const tot = r.zoneSecs.reduce((a, b) => a + b, 0);
        const share = (ids) => (tot > 0 ? `${Math.round((ids.reduce((s, i) => s + r.zoneSecs[i], 0) / tot) * 100)}%` : null);
        return {
          settimana: r.weekStart,
          tssSvolto: r.doneTss,
          tssPianificato: r.plannedTss,
          ore: round1(r.doneSecs / 3600),
          sessioni: r.sessions,
          z1z2: share([0, 1]),
          z5plus: share([4, 5, 6]),
        };
      });
      pushChart(state, weeklyChart(e));
      return JSON.stringify(rows);
    }

    case "profilo_fisiologico": {
      return JSON.stringify({
        ...modelSummary(m),
        zone: m.zones.coggan.map((z) => `${z.label}: ${z.fromW}-${z.toW ?? "max"} W`),
        zoneFc: m.zones.hr?.length ? m.zones.hr.map((z) => `${z.label}: ${z.fromBpm}-${z.toBpm ?? "max"}`) : null,
        durabilita: m.durability,
        calibrazioneLattato: m.calibration,
      });
    }

    case "stima_lattato": {
      const list = numberList(args.watt ?? args.watts ?? args.potenza).filter((w) => w > 20 && w < 2500).slice(0, 8);
      if (!list.length) return "Indica almeno una potenza in watt, es. {\"watt\": [250]}.";
      const secs = Math.max(1, numberList(args.durataMin)[0] ?? 10) * 60;
      return JSON.stringify(
        list.map((w) => {
          const ss = steadyLactate(w, m.params);
          const sub = substrateAt(w, m.params);
          return {
            watt: w,
            pctFtp: Math.round((w / e.ftp) * 100),
            lattato: round1(lactateAfter(w, secs, m.params)),
            statoStazionario: ss != null,
            choGh: sub.choGh,
            grassiGh: sub.fatGh,
            kcalH: sub.kcalH,
          };
        }),
      );
    }

    case "curva_lattato": {
      const ok = pushChart(state, lactateChart(e));
      return ok
        ? `Curva lattato creata. LT1 ${m.lt1} W, LT2 ${m.lt2} W, MLSS ${m.mlss} W, FatMax ${m.fatMax?.watts} W (${m.fatMax?.fatGh} g/h di grassi; confidenza ${m.confidence.lactate}).`
        : "Dati insufficienti per la curva lattato.";
    }

    case "curva_potenza": {
      const days = Math.min(365, Math.max(14, Number(args.giorni ?? 90)));
      const chart = powerCurveChart(e, days);
      if (!chart) return "Nessuna curva di potenza disponibile (servono sessioni con potenza).";
      pushChart(state, chart);
      return `Curva creata. CP ${m.cp} W, W' ${round1(m.wPrime / 1000)} kJ, Pmax ${m.pmax} W (confidenza ${m.confidence.cp}).`;
    }

    case "record_personali": {
      const records = ctx.records ?? {};
      return JSON.stringify({
        bestEffort: Object.entries(records.bests ?? {}).map(([secs, b]) => ({ finestra: `${secs}s`, watt: b.watts, data: b.at?.slice(0, 10) })),
        durataMaxMin: minutes(records.maxDurationSecs),
        distanzaMaxKm: round1((records.maxDistanceM ?? 0) / 1000),
        lavoroMaxKj: Math.round(records.maxWorkKj ?? 0),
        potenzaPicco: records.maxPower ?? null,
      });
    }

    case "crea_grafico": {
      const kind = String(args.kind ?? "");
      const titolo = args.titolo ? String(args.titolo) : undefined;
      if (kind === "pmc") return pushChart(state, pmcChart(e, titolo)) ? "Grafico PMC con proiezione creato." : "PMC non disponibile.";
      if (kind === "weekly_tss") return pushChart(state, weeklyChart(e, titolo)) ? "Grafico TSS settimanale creato." : "Nessun dato.";
      if (kind === "trend") return pushChart(state, trendChart(e, titolo)) ? "Grafico zone settimanali creato." : "Nessun dato.";
      if (kind === "power_curve") return pushChart(state, powerCurveChart(e, 90, titolo)) ? "Curva di potenza creata." : "Nessun dato di potenza.";
      if (kind === "lactate") return pushChart(state, lactateChart(e, titolo)) ? "Curva lattato creata." : "Dati insufficienti.";
      if (kind === "session") {
        const activity = findActivity(ctx, { id: args.sessionId ? String(args.sessionId) : undefined, data: args.data ? String(args.data) : undefined });
        if (!activity) return "Sessione non trovata.";
        const series = ctx.sessionSeries?.[activity.id];
        if (!series?.length) return "Questa sessione non ha serie potenza salvate.";
        pushChart(state, sessionChart(activity, series, titolo || activity.title));
        return `Grafico sessione creato (${series.length} punti).`;
      }
      return `Tipo grafico sconosciuto: ${kind}`;
    }

    case "genera_allenamento": {
      const type = TYPE_KEYS.includes(args.tipo) ? args.tipo : "z2";
      const avoid = ctx.settings?.avoid ?? [];
      const warn = avoid.includes(type) ? ` Nota: l'atleta preferisce evitare ${SESSION_TYPES[type].label}.` : "";
      const durationMin = Math.min(360, Math.max(20, num(args.durataMin, 60)));
      const level = Math.min(5, Math.max(1, Math.round(num(args.livello, 2))));
      const draft = generateWorkout({ type, durationMin, level, model: m });
      addWorkout(state, draft);
      return `Creato "${draft.name}": ${draft.description}. Previsione: ${predictionText(draft.prediction)}.${warn}`;
    }

    case "crea_allenamento": {
      const blocks = cleanBlocks(args.blocks);
      if (!blocks.length) return "Allenamento senza blocchi validi.";
      const prediction = predictWorkout(blocks, m);
      const draft = {
        name: String(args.name ?? "Allenamento coach").slice(0, 80),
        description: args.description ? String(args.description).slice(0, 240) : describeSteps(blocks),
        blocks,
        prediction,
      };
      if (prediction.feasibility === "non_fattibile" && !state.retriedWorkout) {
        state.retriedWorkout = true;
        return `NON FATTIBILE: W' balance scende a ${prediction.wbalMinPct}% (CP ${m.cp} W, W' ${round1(m.wPrime / 1000)} kJ). Riduci intensità o durata delle ripetute, o allunga i recuperi, poi richiama crea_allenamento.`;
      }
      addWorkout(state, draft);
      return `Creato "${draft.name}". Previsione: ${predictionText(prediction)}. Conferma dall'artefatto per salvarlo.`;
    }

    case "predici_allenamento": {
      const blocks = cleanBlocks(args.blocks);
      if (!blocks.length) return "Nessun blocco valido.";
      const p = predictWorkout(blocks, m);
      return JSON.stringify({ sintesi: predictionText(p), passi: p.steps });
    }

    case "lista_allenamenti": {
      const workouts = ctx.workouts ?? [];
      if (!workouts.length) return "Nessun allenamento salvato.";
      return JSON.stringify(workouts.slice(0, 40).map((w) => ({ nome: w.name, min: minutes(w.durationSecs), categoria: w.category ?? "custom" })));
    }

    case "genera_piano": {
      const weeks = Math.min(8, Math.max(1, Math.round(num(args.settimane, 4))));
      const settings = ctx.settings ?? {};
      const compl = e.activities
        .filter((a) => isoDay(a.date) >= addDaysIso(e.today, -14) && a.compliance != null)
        .map((a) => a.compliance);
      const plan = generatePlan({
        settings: { ...settings, goal: ctx.goal ?? settings.goal },
        model: m,
        load: e.load,
        startDate: e.today,
        weeks,
        compliance: compl.length ? compl.reduce((a, b) => a + b, 0) / compl.length : null,
      });
      setPlan(state, plan.sessions, "replace", weeks);
      for (const w of plan.workouts) state.workouts.push(w);
      state.phases = plan.phases;
      const perWeek = plan.phases.map((p) => `${p.weekStart} ${p.label}: ${p.plannedTss} TSS`).join("; ");
      return `${plan.summary} Settimane: ${perWeek}. ${plan.sessions.length} sessioni, ${plan.workouts.length} workout. L'atleta deve confermare dall'artefatto Piano.`;
    }

    case "adatta_oggi": {
      const checkin = (ctx.checkins ?? []).find((c) => c.date === e.today) ?? null;
      const readiness = readinessScore(checkin, e.load.tsb);
      const todayPlanned = e.planned.find((p) => isoDay(p.date) === e.today);
      if (!todayPlanned) {
        return `Prontezza ${readiness}/100${checkin ? "" : " (nessun check-in oggi, stima dal solo TSB)"}. Nessuna sessione pianificata oggi.`;
      }
      const session = plannedToSession(todayPlanned);
      const res = adaptSession(session, { readiness, model: m });
      if (!res.changed) return `${res.reason} Oggi: ${session.name} (${session.durationMin} min).`;
      addWorkout(state, res.draft);
      setPlan(state, [{ ...res.session, workoutId: undefined, fromDate: session.date }], "merge");
      return `${res.reason} Proposta: ${res.session.name}, ${res.session.durationMin} min, TSS ${res.session.plannedTss}. Conferma dall'artefatto.`;
    }

    case "sposta_sessione": {
      const da = isoDay(args.da);
      const p = e.planned.find((x) => isoDay(x.date) === da);
      if (!p) return `Nessuna sessione pianificata il ${da}.`;
      const occupied = new Set(e.planned.map((x) => isoDay(x.date)));
      const availability = ctx.settings?.availability ?? {};
      const life = ctx.lifeBlocks ?? [];
      let a = isoDay(args.a);
      if (!a) {
        for (let i = 1; i <= 10; i++) {
          const d = addDaysIso(da, i);
          const wd = WEEKDAYS[(new Date(`${d}T12:00:00`).getDay() + 6) % 7];
          if (!occupied.has(d) && (availability[wd] ?? 60) > 0 && !dayFullyBusy(life, d)) {
            a = d;
            break;
          }
        }
      }
      if (!a || a < e.today) return "Data di destinazione non valida.";
      const moved = { ...plannedToSession(p), date: a, fromDate: da };
      const warn = occupied.has(a) ? ` Attenzione: il ${a} c'era già una sessione, verrà sostituita.` : "";
      setPlan(state, [moved], "merge");
      return `"${moved.name}" spostata dal ${da} al ${a}.${warn} Conferma dall'artefatto.`;
    }

    case "aggiorna_piano_settimanale":
    case "programma_periodo": {
      const cleaned = cleanPlanSessions(args.sessioni, e);
      for (const s of cleaned) {
        if (s.__draft) addWorkout(state, s.__draft);
        delete s.__draft;
      }
      setPlan(state, cleaned, "merge");
      return `Modifiche a ${cleaned.length} sessioni: ${cleaned.slice(0, 6).map((s) => `${s.date} ${s.name}`).join(", ")}.`;
    }

    case "registra_impegno": {
      const label = String(args.etichetta ?? "").trim().slice(0, 120);
      if (!label) return "Serve una descrizione dell'impegno.";
      const block = {
        id: crypto.randomUUID(),
        label,
        date: args.data ? isoDay(args.data) : undefined,
        weekday: args.giornoSettimana && WEEKDAYS.includes(args.giornoSettimana) ? args.giornoSettimana : undefined,
        slot: args.fascia && ["morning", "afternoon", "evening", "all"].includes(args.fascia) ? args.fascia : "all",
        kind: args.tipo === "window" ? "window" : "busy",
        source: "chat",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      if (!state.lifeBlockUpdates) state.lifeBlockUpdates = [];
      state.lifeBlockUpdates.push(block);
      return `Impegno registrato: ${label}${block.date ? ` il ${block.date}` : block.weekday ? ` (${block.weekday})` : ""}.`;
    }

    case "preferenze_atleta": {
      const s = ctx.settings ?? {};
      if (args.vincolo) {
        state.persistentConstraint = String(args.vincolo).slice(0, 240);
      }
      return JSON.stringify({
        obiettivo: ctx.goal ?? s.goal ?? null,
        esperienza: s.experience ?? null,
        disponibilitaMin: s.availability ?? null,
        oreMaxSettimana: s.maxHoursWeek ?? null,
        giornoLungo: s.preferredLongDay ?? null,
        outdoor: s.outdoorDays ?? [],
        piace: s.likes ?? [],
        evita: s.avoid ?? [],
        infortuni: s.injuries ?? null,
        vincoli: [...(s.constraints ?? []), ...(state.persistentConstraint ? [state.persistentConstraint] : [])],
        eventi: (s.events ?? []).map((ev) => `${ev.date} ${ev.name} (${ev.type}, priorità ${ev.priority})`),
        nuovoVincoloRegistrato: state.persistentConstraint ?? null,
      });
    }

    case "carburante": {
      const durationMin = Math.max(10, num(args.durataMin, 60));
      let watts = num(args.wattMedi, 0);
      if (!watts) {
        const pct = { recovery: 0.5, z2: 0.65, tempo: 0.8, sst: 0.82, threshold: 0.85, durability: 0.7 }[args.tipo] ?? 0.68;
        watts = Math.round(e.ftp * pct);
      }
      const plan = fuelingPlan(m, { durationMin, avgWatts: watts });
      return JSON.stringify({ wattMedi: watts, ...plan, nota: plan.intakeGh >= 90 ? "Oltre 90 g/h serve intestino allenato e mix glucosio:fruttosio." : undefined });
    }

    case "consulta_knowledge": {
      const cards = searchCards(knowledgeCards(), String(args.query ?? ""), { limit: 3 });
      if (!cards.length) return "Nessuna scheda pertinente.";
      return cards.map((c) => `## ${c.title} (${c.source})\n${c.body}`).join("\n\n");
    }

    case "cerca_web": {
      return searchWeb(String(args.query ?? "")).then((result) => {
        if (!result.ok) return result.error;
        state.artifacts.push({ type: "sources", query: result.query, results: result.results });
        return `Trovati ${result.results.length} risultati: ${result.results.map((r) => `${r.title}: ${r.snippet}`).join(" | ").slice(0, 1500)}`;
      });
    }

    case "strava_attivita":
    case "strava_dettaglio":
    case "strava_confronta":
    case "strava_profilo":
      return runStravaTool(name, args, ctx);

    default:
      return `Strumento sconosciuto: ${name}`;
  }
}

async function runStravaTool(name, args, ctx) {
  const memberId = ctx.__memberId;
  if (!memberId) return NOT_LINKED;
  const giorni = Math.min(365, Math.max(1, Number(args.giorni ?? 28)));
  const after = Math.floor(Date.now() / 1000) - giorni * 86400;
  try {
    if (name === "strava_profilo") {
      const data = await athleteProfile(memberId);
      const a = data.athlete ?? {};
      return JSON.stringify({
        pesoKg: a.weight ?? null,
        ftp: a.ftp ?? null,
        citta: a.city ?? null,
        cached: data.cached ?? false,
      });
    }
    const listed = await listActivities(memberId, { after, perPage: 40 });
    let rows = listed.activities ?? [];
    if (args.sport && args.sport !== "all") {
      rows = rows.filter((a) => sportFromStrava(a.sport_type || a.type) === args.sport);
    }
    if (name === "strava_confronta") {
      const by = {};
      for (const a of rows) {
        const sport = sportFromStrava(a.sport_type || a.type);
        const b = by[sport] ?? { n: 0, min: 0, km: 0 };
        b.n += 1;
        b.min += Math.round((a.moving_time ?? 0) / 60);
        b.km += Math.round((a.distance ?? 0) / 100) / 10;
        by[sport] = b;
      }
      return JSON.stringify({ giorni, sport: by, cached: listed.cached, nota: listed.note });
    }
    if (name === "strava_dettaglio") {
      const bundle = await activityBundle(memberId, String(args.id));
      const a = bundle.activity ?? {};
      return JSON.stringify({
        id: a.id,
        nome: a.name,
        sport: sportFromStrava(a.sport_type || a.type),
        data: String(a.start_date_local ?? "").slice(0, 10),
        min: Math.round((a.moving_time ?? 0) / 60),
        km: Math.round((a.distance ?? 0) / 100) / 10,
        dislivello: a.total_elevation_gain ?? null,
        wattMedi: a.average_watts ?? null,
        np: a.weighted_average_watts ?? null,
        fc: a.average_heartrate ?? null,
        lap: bundle.laps,
        segmenti: bundle.segments,
        puntiSerie: bundle.series?.length ?? 0,
        cached: bundle.cached,
      });
    }
    return JSON.stringify({
      cached: listed.cached,
      nota: listed.note,
      attivita: rows.slice(0, 25).map((a) => ({
        id: a.id,
        data: String(a.start_date_local ?? "").slice(0, 10),
        sport: sportFromStrava(a.sport_type || a.type),
        nome: a.name,
        min: Math.round((a.moving_time ?? 0) / 60),
        km: Math.round((a.distance ?? 0) / 100) / 10,
        dislivello: a.total_elevation_gain ?? null,
        watt: a.average_watts ?? null,
        fc: a.average_heartrate ?? null,
      })),
    });
  } catch (error) {
    return error.message || NOT_LINKED;
  }
}

/** Istantanea compatta dell'atleta per il prompt di sistema. */
export function athleteSnapshot(ctx) {
  const e = engineFor(ctx);
  const m = e.model;
  const s = ctx.settings ?? {};
  const checkin = (ctx.checkins ?? []).find((c) => c.date === e.today);
  const todayPlanned = e.planned.filter((p) => isoDay(p.date) === e.today).map((p) => `${p.title} (${minutes(p.durationSecs)} min)`);
  const next = e.planned
    .filter((p) => isoDay(p.date) > e.today)
    .sort((a, b) => isoDay(a.date).localeCompare(isoDay(b.date)))
    .slice(0, 5)
    .map((p) => `${isoDay(p.date)} ${p.title}`);
  const recent = [...e.activities]
    .sort((a, b) => isoDay(b.date).localeCompare(isoDay(a.date)))
    .slice(0, 12);
  const last = recent[0];
  const nextEvent = (s.events ?? []).filter((ev) => ev.date >= e.today).sort((a, b) => a.date.localeCompare(b.date))[0];
  return [
    `Oggi: ${e.today}.`,
    `Atleta: ${ctx.profile?.name || "atleta"}, ${m.weightKg} kg, FTP ${e.ftp} W${m.ftpEstimated && Math.abs(m.ftpEstimated - e.ftp) >= 5 ? ` (dai dati recenti ~${m.ftpEstimated} W)` : ""} = ${round1(e.ftp / m.weightKg)} W/kg, CP ${m.cp} W, W' ${round1(m.wPrime / 1000)} kJ, VO2max ~${m.vo2max}, VLamax ~${m.vlamax}, LT1 ${m.lt1} W, LT2 ${m.lt2} W, FatMax ${m.fatMax?.watts} W.`,
    `Carico: CTL ${e.load.ctl}, ATL ${e.load.atl}, TSB ${e.load.tsb} (${e.load.status}), ramp ${e.load.rampRate}/sett.`,
    ctx.goal || s.goal ? `Obiettivo: ${ctx.goal || s.goal}.` : "",
    nextEvent ? `Prossimo evento: ${nextEvent.name} il ${nextEvent.date} (${nextEvent.type}, ${nextEvent.priority}).` : "",
    s.experience ? `Esperienza: ${s.experience}. Ore max/sett: ${s.maxHoursWeek ?? "?"}.` : "",
    s.likes?.length ? `Preferisce: ${s.likes.join(", ")}.` : "",
    s.avoid?.length ? `Evita: ${s.avoid.join(", ")}.` : "",
    s.injuries ? `Infortuni/limiti: ${s.injuries}.` : "",
    s.constraints?.length ? `Vincoli: ${s.constraints.slice(0, 6).join("; ")}.` : "",
    checkin
      ? `Check-in oggi: sonno ${checkin.sleep}/5, fatica ${checkin.fatigue}/5, dolori ${checkin.soreness}/5, stress ${checkin.stress}/5, prontezza ${readinessScore(checkin, e.load.tsb)}/100.${checkin.note ? ` Nota: ${checkin.note}` : ""}`
      : "Nessun check-in oggi.",
    todayPlanned.length ? `Pianificato oggi: ${todayPlanned.join(", ")}.` : "Niente pianificato oggi.",
    next.length ? `Prossime: ${next.join("; ")}.` : "",
    last ? `Ultima sessione: ${isoDay(last.date)} ${last.title}${last.sport ? ` (${last.sport})` : ""}, ${minutes(last.durationSecs)} min, TSS ${last.tss != null ? Math.round(last.tss) : "?"}, IF ${last.ifactor ?? "?"}${last.rpe ? `, RPE ${last.rpe}` : ""}.` : "",
    recent.length
      ? `Ultime uscite già nel calendario (anche Strava): ${recent.map((a) => `${isoDay(a.date)} ${a.sport || "bici"} ${a.title} ${minutes(a.durationSecs)} min`).join("; ")}.`
      : "",
    "Il carico include tutti gli sport; CP, FTP e lattato solo dal ciclismo. Il collegamento Strava è in Profilo → Strava, non nelle impostazioni.",
    m.warnings?.length ? `Avvisi modello: ${m.warnings.slice(0, 2).join(" ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
