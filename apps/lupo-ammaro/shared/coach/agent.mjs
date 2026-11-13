// Agente coach: loop modello + strumenti nel formato dell'API Messages di Anthropic.
// Il trasporto verso il modello è iniettato (`llm`), così lo stesso codice gira nell'app
// (tramite /api/wattlab/coach/llm del sito) e in un eventuale server.
//
// @typedef {{ type: string, [k: string]: any }} Block
// @typedef {{ role: "user" | "assistant", content: string | Block[] }} Message
// @typedef {{ content: Block[], stop_reason: string | null }} LlmResult
// @typedef {{ call: (req: { system: string, messages: Message[], tools?: any[], mode?: "chat" | "json", onText?: (t: string) => void, signal?: AbortSignal }) => Promise<LlmResult> }} Llm

import { anthropicTools, availableTools, athleteSnapshot, engineFor, runTool, toolsForMessage } from "./tools.mjs";
import { modelSummary } from "../engine/physiology.mjs";

export const COACH_SYSTEM = `Sei il coach di ciclismo di Lupo Ammaro: un preparatore esperto di allenamento con la potenza, fisiologia (lattato, VO2max, VLamax, CP/W') e periodizzazione. Segui davvero l'atleta, come un allenatore personale.

COME LAVORI
- Prima di rispondere su dati, carico, forma o piano, consulta gli strumenti: non rispondere a memoria.
- Tutti i numeri (watt, TSS, CTL/ATL/TSB, lattato, zone, carboidrati) arrivano dagli strumenti o dall'istantanea atleta. Non calcolarli e non inventarli; citali nella risposta.
- Ragiona come un coach: obiettivo e data dell'evento → fase (base, costruzione, specifico, scarico, gara) → carico sostenibile (ramp CTL 3-6/sett., TSB non sotto -30) → sessione giusta oggi.
- Distribuzione polarizzata o piramidale: la maggior parte del volume sotto LT1, 2-3 sedute di qualità a settimana al massimo, mai due giorni duri di fila salvo blocchi pianificati.
- Leggi i segnali: check-in (sonno, fatica, dolori, stress), RPE alto rispetto all'IF, disaccoppiamento > 5%, compliance bassa → alleggerisci o sposta. Con TSB molto negativo o malessere proponi recupero.
- Se manca un'informazione decisiva (obiettivo, data evento, giorni disponibili), chiedila con una domanda breve invece di indovinare.

STRUMENTI
- Allenamenti: genera_allenamento (preferito) o crea_allenamento a blocchi; piani: genera_piano; modifiche puntuali: sposta_sessione / aggiorna_piano_settimanale; oggi: adatta_oggi; impegni personali: registra_impegno.
- Rispetta preferenze, cose da evitare, infortuni, vincoli e disponibilità. Un nuovo vincolo permanente va registrato con preferenze_atleta(vincolo).
- Teoria: consulta_knowledge e cita la fonte.
- Piani e allenamenti vanno confermati dall'atleta nel pannello artefatti: dillo in una riga.
- Il carico include tutti gli sport; CP/FTP/lattato solo dal ciclismo. Le uscite Strava sincronizzate sono già nel calendario: usale con cerca_attivita. Il collegamento Strava è in Profilo → Strava.
- Se la confidenza del modello fisiologico è bassa dillo e proponi un test (FTP/CP o lattato).

STILE
- Italiano, diretto, concreto e motivante. Massimo ~180 parole salvo richiesta esplicita.
- Chiudi con l'indicazione pratica: cosa fare oggi o nei prossimi giorni, con watt o zone.`;

function newState() {
  return {
    planUpdate: undefined,
    planMode: undefined,
    phases: undefined,
    workouts: [],
    artifacts: [],
    toolsUsed: [],
    persistentConstraint: undefined,
    lifeBlockUpdates: [],
  };
}

function buildResponse(state, reply) {
  const artifacts = [...state.artifacts];
  for (const w of state.workouts) {
    if (!artifacts.some((a) => a.type === "workout" && a.draft?.name === w.name)) artifacts.push({ type: "workout", draft: w });
  }
  return {
    reply: String(reply ?? "").trim(),
    artifacts: artifacts.length ? artifacts : undefined,
    planUpdate: state.planUpdate,
    planMode: state.planMode,
    phases: state.phases,
    workouts: state.workouts.length ? state.workouts : undefined,
    persistentConstraint: state.persistentConstraint,
    lifeBlocks: state.lifeBlockUpdates?.length ? state.lifeBlockUpdates : undefined,
    toolsUsed: state.toolsUsed,
  };
}

async function execTool(name, args, ctx, state) {
  if (!state.toolsUsed.includes(name)) state.toolsUsed.push(name);
  try {
    const out = await runTool(name, args ?? {}, ctx, state);
    return typeof out === "string" ? out : JSON.stringify(out);
  } catch (error) {
    return `Errore strumento ${name}: ${String(error?.message ?? error).slice(0, 200)}`;
  }
}

function latestSessionWithSeries(ctx) {
  return (ctx.activities ?? [])
    .filter((a) => ctx.sessionSeries?.[a.id]?.length)
    .sort((a, b) => String(b.date).localeCompare(String(a.date)))[0];
}

function extractWebQuery(message) {
  const cleaned = String(message ?? "")
    .replace(/cerca in rete|cerca sul web|ricerca web|internet/gi, "")
    .replace(/^(cerca|trova)\s+/i, "")
    .trim();
  return cleaned.slice(0, 120) || "allenamento ciclismo potenza";
}

function hasTool(name) {
  return availableTools().some((t) => t.function.name === name);
}

/** Strumenti eseguiti prima del modello per gli intent espliciti dei tasti rapidi. */
function directCalls(intent, message, ctx) {
  switch (intent) {
    case "chart_pmc":
      return [["carico_allenamento", {}], ["crea_grafico", { kind: "pmc" }]];
    case "web_search":
      return hasTool("cerca_web") ? [["cerca_web", { query: extractWebQuery(message) }]] : [];
    case "last_session": {
      const latest = latestSessionWithSeries(ctx);
      return latest ? [["analisi_sessione", { id: latest.id }]] : [["analisi_sessione", {}]];
    }
    case "plan_week":
      return [["carico_allenamento", {}], ["genera_piano", { settimane: 4 }]];
    default:
      return [];
  }
}

function snapshot(ctx) {
  try {
    return athleteSnapshot(ctx);
  } catch {
    return "Dati atleta non disponibili.";
  }
}

/** Storia testuale valida per l'API: niente vuoti, ruoli alternati, si parte dall'atleta. */
function cleanHistory(history) {
  const out = [];
  for (const m of (history ?? []).slice(-10)) {
    if (!m || (m.role !== "user" && m.role !== "assistant")) continue;
    const text = String(m.content ?? "").trim().slice(0, 2000);
    if (!text) continue;
    if (!out.length && m.role !== "user") continue;
    const prev = out[out.length - 1];
    if (prev?.role === m.role) prev.content = `${prev.content}\n\n${text}`;
    else out.push({ role: m.role, content: text });
  }
  if (out.length && out[out.length - 1].role === "user") out.pop();
  return out;
}

function textOf(blocks) {
  return (blocks ?? [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}

const REFUSAL_REPLY = "Su questo non posso aiutarti: chiedimi di allenamento, recupero o alimentazione per lo sport.";

/** Loop modello + strumenti. `preface` sono risultati già calcolati dai tasti rapidi. */
async function runAgent({ llm, message, history = [], ctx, toolset, preface = "", system = COACH_SYSTEM, maxSteps = 6, state, emit, signal }) {
  const fullSystem = `${system}\n\nISTANTANEA ATLETA (dal motore Lupo Ammaro):\n${snapshot(ctx)}${preface ? `\n\nRISULTATI GIÀ CALCOLATI:\n${preface}` : ""}`;
  /** @type {any[]} */
  const messages = [...cleanHistory(history), { role: "user", content: String(message ?? "").slice(0, 4000) }];
  const tools = toolset?.length ? anthropicTools(toolset) : undefined;

  for (let step = 0; step < maxSteps; step++) {
    const res = await llm.call({
      system: fullSystem,
      messages,
      tools,
      mode: "chat",
      onText: emit ? (text) => emit({ type: "delta", text }) : undefined,
      signal,
    });
    if (res.stop_reason === "refusal") return REFUSAL_REPLY;
    const calls = (res.content ?? []).filter((b) => b.type === "tool_use");
    if (!calls.length) return textOf(res.content);

    // Il blocco assistente torna intatto (anche i blocchi di ragionamento), poi i risultati.
    messages.push({ role: "assistant", content: res.content });
    const results = [];
    for (const call of calls) {
      emit?.({ type: "tool_start", name: call.name, label: String(call.name).replaceAll("_", " ") });
      const output = await execTool(call.name, call.input ?? {}, ctx, state);
      emit?.({ type: "tool_end", name: call.name });
      results.push({ type: "tool_result", tool_use_id: call.id, content: output.slice(0, 6000) });
    }
    messages.push({ role: "user", content: results });
  }
  return "Ho raccolto i dati ma il ragionamento si è interrotto: riprova con una domanda più specifica.";
}

function deterministicReply(state, preface) {
  const hasPlan = state.planUpdate?.length;
  const hasChart = state.artifacts.some((a) => a.type === "chart");
  const hasSources = state.artifacts.some((a) => a.type === "sources");
  const lines = [];
  if (hasPlan) lines.push("Piano pronto nel pannello artefatti: confermalo per scriverlo nel calendario.");
  if (hasChart) lines.push("Grafico pronto nel pannello artefatti.");
  if (hasSources) lines.push("Fonti web nel pannello artefatti.");
  if (preface) lines.push(preface.split("\n").map((l) => l.replace(/^\[[a-z_]+\]\s*/, "")).join("\n").slice(0, 900));
  return lines.join("\n");
}

/**
 * Chat con il coach.
 * @param {{ llm: Llm, message: string, history?: any[], context: any, directIntent?: string, memberId?: number, emit?: (e: any) => void, signal?: AbortSignal }} input
 */
export async function chatWithCoach({ llm, message, history = [], context, directIntent, memberId, emit, signal }) {
  const ctx = context ?? {};
  if (memberId) Object.defineProperty(ctx, "__memberId", { value: memberId, enumerable: false });
  const state = newState();

  const pre = directCalls(directIntent, message, ctx);
  const prefaceLines = [];
  for (const [name, args] of pre) {
    prefaceLines.push(`[${name}] ${await execTool(name, args, ctx, state)}`);
  }
  const preface = prefaceLines.join("\n");

  if (directIntent === "chart_pmc" || (directIntent === "web_search" && pre.length)) {
    return buildResponse(state, deterministicReply(state, preface));
  }

  const toolset = toolsForMessage(message, { all: true });
  try {
    const reply = await runAgent({ llm, message, history, ctx, toolset, preface, state, emit, signal });
    return buildResponse(state, reply || deterministicReply(state, preface));
  } catch (error) {
    if (pre.length && !signal?.aborted) {
      return buildResponse(state, `${deterministicReply(state, preface)}\n\n(Coach AI non disponibile: ${error.message})`);
    }
    throw error;
  }
}

function extractJsonObject(text) {
  const raw = String(text ?? "").trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(raw.slice(start, end + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

async function completeJson(llm, { system, user }) {
  const res = await llm.call({
    system: `${system}\nRispondi SOLO con un oggetto JSON valido, senza markdown.`,
    messages: [{ role: "user", content: String(user ?? "").slice(0, 14000) }],
    mode: "json",
  });
  const parsed = extractJsonObject(textOf(res.content));
  if (!parsed || typeof parsed !== "object") throw new Error("Risposta del coach non valida.");
  return parsed;
}

export async function coachSessionComment({ llm, context, session, planned, evaluation, athleteProfile }) {
  const ctx = context ?? {};
  const parsed = await completeJson(llm, {
    system: `Sei il coach di Lupo Ammaro. Scrivi un commento in italiano (3-5 frasi) sull'allenamento svolto.
Confronta pianificato e svolto (TSS, durata, compliance), interpreta IF/NP/zone, FC e disaccoppiamento, RPE se presenti.
Chiudi con un consiglio pratico per le prossime 24-48 h. Usa solo i numeri forniti.
Output JSON: { "comment": "..." }`,
    user: JSON.stringify({
      atleta: snapshot(ctx),
      profiloQualitativo: athleteProfile ?? null,
      sessione: session,
      pianificato: planned ?? null,
      valutazione: evaluation ?? null,
    }),
  });
  const comment = String(parsed.comment ?? "").trim();
  if (!comment) throw new Error("Commento coach vuoto.");
  return { comment };
}

/** Revisione settimanale: solo narrativa (il piano lo genera il motore). */
export async function coachWeeklyReview({ llm, context, constraints = [] }) {
  const ctx = context ?? {};
  const e = engineFor(ctx);
  const from = new Date(Date.parse(`${e.today}T00:00:00Z`) - 28 * 86400000).toISOString().slice(0, 10);
  const sessions = (ctx.activities ?? [])
    .filter((a) => String(a.date) >= from)
    .map((a) => ({
      data: String(a.date).slice(0, 10),
      titolo: a.title,
      sport: a.sport ?? null,
      min: Math.round((a.durationSecs ?? 0) / 60),
      tss: a.tss != null ? Math.round(a.tss) : null,
      if: a.ifactor ?? null,
      rpe: a.rpe ?? null,
      compliance: a.compliance ?? null,
      tipo: a.sessionType ?? null,
    }));
  const parsed = await completeJson(llm, {
    system: `Sei il coach di Lupo Ammaro. Analizza le ultime 4 settimane e produci:
- athleteProfile: { strengths: string[], weaknesses: string[], consistency: string, preferredDays: string[], ftpTrend: string }
- weekReview: bilancio della settimana passata e indicazioni per la prossima (4-6 frasi, italiano, numeri reali).
Output JSON con sole queste chiavi.`,
    user: JSON.stringify({
      atleta: snapshot(ctx),
      modello: modelSummary(e.model),
      carico: e.load,
      vincoli: constraints,
      sessioni: sessions,
      checkin: (ctx.checkins ?? []).slice(-7),
    }),
  });
  const list = (v, n) => (Array.isArray(v) ? v.map(String).slice(0, n) : []);
  return {
    athleteProfile: {
      strengths: list(parsed.athleteProfile?.strengths, 8),
      weaknesses: list(parsed.athleteProfile?.weaknesses, 8),
      consistency: String(parsed.athleteProfile?.consistency ?? "").slice(0, 400),
      preferredDays: list(parsed.athleteProfile?.preferredDays, 7),
      ftpTrend: String(parsed.athleteProfile?.ftpTrend ?? "").slice(0, 400),
    },
    weekReview: String(parsed.weekReview ?? "").trim(),
    plan: [],
  };
}

const ADJUST_TOOLS = [
  "adatta_oggi",
  "sposta_sessione",
  "aggiorna_piano_settimanale",
  "preferenze_atleta",
  "registra_impegno",
  "genera_allenamento",
  "carico_allenamento",
];

export async function coachAdjustPlan({ llm, message, context, constraints = [] }) {
  const ctx = context ?? {};
  const state = newState();
  const toolset = availableTools().filter((t) => ADJUST_TOOLS.includes(t.function.name));
  const reply = await runAgent({
    llm,
    message: [
      `Richiesta atleta: ${String(message ?? "").slice(0, 500)}`,
      constraints.length ? `Vincoli già noti: ${constraints.join("; ")}` : "",
      "Modifica il piano con gli strumenti (sposta o sostituisci, non eliminare senza alternativa). Se il vincolo è permanente registralo con preferenze_atleta(vincolo). Rispondi in 2-3 frasi.",
    ]
      .filter(Boolean)
      .join("\n"),
    ctx,
    toolset,
    state,
    maxSteps: 5,
  });
  return {
    reply,
    plan: state.planUpdate ?? [],
    planMode: state.planMode ?? "merge",
    workouts: state.workouts,
    persistentConstraint: state.persistentConstraint,
    lifeBlocks: state.lifeBlockUpdates?.length ? state.lifeBlockUpdates : undefined,
  };
}

export async function coachBatchComments({ llm, context, sessions, athleteProfile }) {
  const out = [];
  for (const session of (sessions ?? []).slice(0, 5)) {
    try {
      const { comment } = await coachSessionComment({ llm, context, session, planned: null, evaluation: session.evaluation ?? null, athleteProfile });
      out.push({ id: session.id, comment });
    } catch {
      // salta le sessioni fallite
    }
  }
  return { comments: out };
}
