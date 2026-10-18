import { coachLlmTimeoutMs, llmChat, llmSettings, parseToolArgs, toolResultMessage } from "./llm.mjs";
import { TOOLS, athleteSnapshot, engineFor, runTool, toolsForMessage } from "./coachTools.mjs";
import { modelSummary } from "../shared/engine/physiology.mjs";

const SYSTEM = `Sei il coach di ciclismo di WattLab: preparatore esperto di allenamento con potenza, fisiologia (lattato, VO2max, VLamax, CP/W') e periodizzazione.
Rispondi SEMPRE in italiano, in modo chiaro, concreto e motivante (max ~180 parole salvo richiesta).

REGOLE:
- Tutti i numeri (watt, TSS, CTL/TSB, lattato, zone, CHO) arrivano dagli strumenti o dall'istantanea atleta. Non calcolarli né inventarli.
- Dopo aver chiamato uno strumento, rispondi usando e citando i numeri che ha restituito.
- Per creare allenamenti usa genera_allenamento (preferito) o crea_allenamento; per piani usa genera_piano; per modifiche puntuali sposta_sessione / aggiorna_piano_settimanale; per la giornata di oggi adatta_oggi; per impegni personali registra_impegno.
- Rispetta le preferenze dell'atleta (evita, infortuni, vincoli, disponibilità). Se l'atleta esprime un nuovo vincolo permanente, registralo con preferenze_atleta(vincolo).
- Per domande di teoria consulta_knowledge e cita la fonte; cerca_web solo per informazioni esterne, mai con dati personali.
- Indica l'incertezza quando la confidenza del modello è bassa e suggerisci un test (FTP/CP o lattato).
- Piani e workout vanno confermati dall'atleta nel pannello artefatti: dillo brevemente.
- Non dire di andare nelle impostazioni: il collegamento Strava è in Profilo → Strava.
- Il carico include tutti gli sport; CP/FTP/lattato solo dal ciclismo. Le uscite Strava già sincronizzate sono nel calendario: usale con cerca_attivita. strava_dettaglio solo se mancano dal calendario.`;

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

/** Strumenti eseguiti prima del modello per intent espliciti dei tasti rapidi. */
function directCalls(intent, message, ctx) {
  switch (intent) {
    case "chart_pmc":
      return [["carico_allenamento", {}], ["crea_grafico", { kind: "pmc" }]];
    case "web_search":
      return [["cerca_web", { query: extractWebQuery(message) }]];
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

function contextMessages(ctx) {
  try {
    return athleteSnapshot(ctx);
  } catch {
    return "Dati atleta non disponibili.";
  }
}

/**
 * Loop LLM + tool. `toolset` limita gli strumenti offerti; `preface` sono risultati già calcolati.
 */
async function runAgent({ message, history = [], context, toolset, preface = "", system = SYSTEM, maxSteps = 6, state, llmTimeoutMs, emit }) {
  const ctx = context ?? {};
  const messages = [
    {
      role: "system",
      content: `${system}\n\nISTANTANEA ATLETA (dal motore WattLab):\n${contextMessages(ctx)}${preface ? `\n\nRISULTATI GIÀ CALCOLATI:\n${preface}` : ""}`,
    },
    ...history
      .filter((m) => m && (m.role === "user" || m.role === "assistant"))
      .slice(-10)
      .map((m) => ({ role: m.role, content: String(m.content ?? "").slice(0, 2000) })),
    { role: "user", content: String(message ?? "").slice(0, 4000) },
  ];

  let tools = toolset;
  for (let step = 0; step < maxSteps; step++) {
    let res;
    try {
      res = await llmChat({
        messages,
        tools,
        timeoutMs: llmTimeoutMs,
        onText: emit ? (text) => emit({ type: "delta", text }) : undefined,
      });
    } catch (error) {
      const noTools = tools?.length && /tool|function.?call|does not support/i.test(`${error.message} ${error.payload ?? ""}`);
      if (!noTools) throw error;
      tools = undefined;
      res = await llmChat({ messages, timeoutMs: llmTimeoutMs });
    }
    const calls = tools ? res.message.tool_calls : undefined;
    if (!calls?.length) return res.message.content;

    messages.push(res.raw);
    for (const call of calls) {
      const name = call.function?.name ?? "";
      emit?.({ type: "tool_start", name, label: name.replaceAll("_", " ") });
      const args = parseToolArgs(call.function?.arguments);
      const output = await execTool(name, args, ctx, state);
      emit?.({ type: "tool_end", name });
      messages.push(toolResultMessage(call, output.slice(0, 6000)));
    }
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

export async function chatWithCoach({ message, history = [], context, directIntent, memberId, emit }) {
  const ctx = context ?? {};
  if (memberId) Object.defineProperty(ctx, "__memberId", { value: memberId, enumerable: false });
  const state = newState();
  const settings = llmSettings();

  const pre = directCalls(directIntent, message, ctx);
  const prefaceLines = [];
  for (const [name, args] of pre) {
    prefaceLines.push(`[${name}] ${await execTool(name, args, ctx, state)}`);
  }
  const preface = prefaceLines.join("\n");

  if (directIntent === "chart_pmc" || directIntent === "web_search") {
    return buildResponse(state, deterministicReply(state, preface));
  }

  const toolset = toolsForMessage(message, {
    all: settings.provider !== "ollama" && process.env.LLM_TOOL_ROUTING !== "on",
  });
  const llmTimeoutMs = coachLlmTimeoutMs();
  const agentSteps = settings.provider === "ollama" ? 4 : 6;
  try {
    const reply = await runAgent({ message, history, context: ctx, toolset, preface, state, maxSteps: agentSteps, llmTimeoutMs, emit });
    return buildResponse(state, reply || deterministicReply(state, preface));
  } catch (error) {
    if (pre.length) {
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

async function completeJson({ system, user }) {
  const res = await llmChat({
    messages: [
      { role: "system", content: `${system}\nRispondi SOLO con un oggetto JSON valido, senza markdown.` },
      { role: "user", content: String(user ?? "").slice(0, 14000) },
    ],
    json: true,
    timeoutMs: coachLlmTimeoutMs(),
  });
  const parsed = extractJsonObject(res.message.content);
  if (!parsed || typeof parsed !== "object") {
    const err = new Error("Risposta JSON coach non valida.");
    err.status = 502;
    throw err;
  }
  return parsed;
}

export async function coachSessionComment({ context, session, planned, evaluation, athleteProfile }) {
  const ctx = context ?? {};
  const payload = {
    atleta: contextMessages(ctx),
    profiloQualitativo: athleteProfile ?? null,
    sessione: session,
    pianificato: planned ?? null,
    valutazione: evaluation ?? null,
  };
  const parsed = await completeJson({
    system: `Sei il coach WattLab. Scrivi un commento in italiano (3-5 frasi) sull'allenamento svolto.
Confronta pianificato vs svolto (TSS, durata, compliance), interpreta IF/NP/zone, FC e disaccoppiamento, RPE se presenti.
Chiudi con un consiglio pratico per le prossime 24-48 h. Usa solo i numeri forniti.
Output JSON: { "comment": "..." }`,
    user: JSON.stringify(payload),
  });
  const comment = String(parsed.comment ?? "").trim();
  if (!comment) {
    const err = new Error("Commento coach vuoto.");
    err.status = 502;
    throw err;
  }
  return { comment };
}

/** Revisione settimanale: solo narrativa (il piano è generato dal motore lato client). */
export async function coachWeeklyReview({ context, constraints = [] }) {
  const ctx = context ?? {};
  const e = engineFor(ctx);
  const from = new Date(Date.parse(`${e.today}T00:00:00Z`) - 28 * 86400000).toISOString().slice(0, 10);
  const sessions = (ctx.activities ?? [])
    .filter((a) => String(a.date) >= from)
    .map((a) => ({
      data: String(a.date).slice(0, 10),
      titolo: a.title,
      min: Math.round((a.durationSecs ?? 0) / 60),
      tss: a.tss != null ? Math.round(a.tss) : null,
      if: a.ifactor ?? null,
      rpe: a.rpe ?? null,
      compliance: a.compliance ?? null,
      tipo: a.sessionType ?? null,
    }));
  const parsed = await completeJson({
    system: `Sei il coach WattLab. Analizza le ultime 4 settimane e produci:
- athleteProfile: { strengths: string[], weaknesses: string[], consistency: string, preferredDays: string[], ftpTrend: string }
- weekReview: bilancio della settimana passata e indicazioni per la prossima (4-6 frasi, italiano, numeri reali).
Output JSON con sole queste chiavi.`,
    user: JSON.stringify({
      atleta: contextMessages(ctx),
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

export async function coachAdjustPlan({ message, context, constraints = [] }) {
  const ctx = context ?? {};
  const state = newState();
  const toolset = TOOLS.filter((t) => ADJUST_TOOLS.includes(t.function.name));
  const settings = llmSettings();
  const reply = await runAgent({
    message: [
      `Richiesta atleta: ${String(message ?? "").slice(0, 500)}`,
      constraints.length ? `Vincoli già noti: ${constraints.join("; ")}` : "",
      "Modifica il piano con gli strumenti (sposta o sostituisci, non eliminare senza alternativa). Se il vincolo è permanente registralo con preferenze_atleta(vincolo). Rispondi in 2-3 frasi.",
    ]
      .filter(Boolean)
      .join("\n"),
    context: ctx,
    toolset,
    state,
    maxSteps: settings.provider === "ollama" ? 3 : 5,
    llmTimeoutMs: coachLlmTimeoutMs(),
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

export async function coachBatchComments({ context, sessions, athleteProfile }) {
  const out = [];
  for (const session of (sessions ?? []).slice(0, 5)) {
    try {
      const { comment } = await coachSessionComment({ context, session, planned: null, evaluation: session.evaluation ?? null, athleteProfile });
      out.push({ id: session.id, comment });
    } catch {
      // salta le sessioni fallite
    }
  }
  return { comments: out };
}
