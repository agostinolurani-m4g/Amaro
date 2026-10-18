import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { buildCoachContext, chatWithCoach, fetchCoachAdjust, fetchCoachHealth, streamCoachChat } from "../hooks/useCoach";
import { getProfile, listCalendar, listWorkouts, saveWorkout, todayIso } from "../hooks/useStorage";
import {
  applyCoachPlan,
  applyCoachResponse,
  applyPlanPatch,
  briefingArtifacts,
  ensureWeeklyReview,
  modelFromContext,
  type AthleteModel,
} from "../lib/coachBriefing";
import { adjustPlanByRules, calendarToPlanSessions } from "../lib/coachPlanAdjust";
import { loadChatMessages, saveChatMessages, type ChatMessage } from "../lib/chatStore";
import { saveLifeBlock, upsertLifeBlockFromMessage } from "../lib/lifeBlockStore";
import { workoutFromCoachDraft } from "../lib/coachWorkouts";
import { detectDirectIntent } from "../lib/coachCharts";
import { loadSnapshotFromContext } from "../lib/sessionEvaluation";
import { focusLabel, loadAthleteProfile, loadBriefing, loadLastEval, saveCoachGoal } from "../lib/coachStore";
import {
  addSettingsConstraint,
  listCheckins,
  loadPlanPhases,
  loadPlanSettings,
  savePlanSettings,
  saveCheckin,
} from "../lib/athleteStore";
import { SESSION_TYPE_META } from "../lib/sessionTypes";
import { CoachArtifactCanvas } from "../components/CoachArtifactCanvas";
import { AthleteSettingsForm } from "../components/AthleteSettingsForm";
import { DailyCheckinCard } from "../components/DailyCheckinCard";
import { ZoneBars } from "../components/ZoneBars";
import { RichText } from "../components/RichText";
import { coachHealthLabel, toolsUsedLabel } from "../lib/coachLabels";
import { getStravaStatus, type StravaStatus } from "../hooks/useStrava";
import { adaptSession, readinessScore } from "../../shared/engine/planner.mjs";
import { mondayOfIso } from "../../shared/engine/dates.mjs";
import type {
  AthletePlanSettings,
  CoachArtifact,
  CoachBriefing,
  CoachHealth,
  CoachPlanSession,
  CoachWorkoutDraft,
  DailyCheckin,
  LoadSnapshot,
  PlanPhaseWeek,
  SessionEvaluation,
  SessionType,
  Workout,
} from "../types";

interface CoachPageProps {
  onStartWorkout?: (workout: Workout) => void;
  onOpenProfile?: () => void;
  compact?: boolean;
}

interface PendingPlan {
  mode: "replace" | "merge";
  workouts: CoachWorkoutDraft[];
  phases?: PlanPhaseWeek[];
}

type Adaptation = ReturnType<typeof adaptSession>;

const PHASE_COLORS: Record<PlanPhaseWeek["phase"], string> = {
  base: "#60a5fa",
  build: "#facc15",
  peak: "#fb923c",
  taper: "#4ade80",
  race: "#ff0a54",
  recovery: "#8a93a8",
};

const QUICK_PROMPTS = [
  "Com'è andata l'ultima sessione?",
  "Qual è il mio profilo fisiologico? Mostrami la curva del lattato",
  "Crea un allenamento VO2max da 60 minuti",
  "Quanti carboidrati per un lungo di 3 ore in Z2?",
  "Grafico del carico CTL/ATL/TSB",
  "Rigenera il piano delle prossime 4 settimane",
];

const QUICK_ADJUST = ["Oggi non posso allenarmi", "Sono stanco, alleggerisci oggi", "Ho solo 45 minuti oggi", "Sposta il lungo a domenica"];

export function CoachPage({ onStartWorkout, onOpenProfile, compact }: CoachPageProps) {
  const today = todayIso();
  const [settings, setSettings] = useState<AthletePlanSettings | null>(null);
  const [editingSettings, setEditingSettings] = useState(false);
  const [briefing, setBriefing] = useState<CoachBriefing | null>(loadBriefing);
  const [lastEval] = useState<SessionEvaluation | null>(loadLastEval);
  const [phases, setPhases] = useState<PlanPhaseWeek[]>([]);
  const [checkin, setCheckin] = useState<DailyCheckin | null>(null);
  const [load, setLoad] = useState<LoadSnapshot | null>(null);
  const [model, setModel] = useState<AthleteModel | null>(null);
  const [todaySession, setTodaySession] = useState<CoachPlanSession | null>(null);
  const [adaptation, setAdaptation] = useState<Adaptation | null>(null);
  const [health, setHealth] = useState<CoachHealth | null>(null);
  const [strava, setStrava] = useState<StravaStatus | null>(null);
  const [artifacts, setArtifacts] = useState<CoachArtifact[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [chatBusy, setChatBusy] = useState(false);
  const [toolStatus, setToolStatus] = useState<string | null>(null);
  const chatAbort = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [profileFtp, setProfileFtp] = useState(200);
  const [savedWorkouts, setSavedWorkouts] = useState<Map<string, Workout>>(new Map());
  const pendingPlans = useRef(new WeakMap<CoachPlanSession[], PendingPlan>());
  const chatEnd = useRef<HTMLDivElement>(null);

  const savedWorkoutNames = useMemo(() => new Set([...savedWorkouts.keys()]), [savedWorkouts]);

  const refreshState = useCallback(async () => {
    const [s, checkins, ph, profile, calendar, workouts] = await Promise.all([
      loadPlanSettings(),
      listCheckins(),
      loadPlanPhases(),
      getProfile(),
      listCalendar().catch(() => []),
      listWorkouts().catch(() => []),
    ]);
    setSettings(s);
    setProfileFtp(profile.ftpWatts || 200);
    setPhases(ph);
    const ci = checkins.find((c) => c.date === today) ?? null;
    setCheckin(ci);
    const map = new Map<string, Workout>();
    for (const w of workouts) map.set(w.name.toLowerCase(), w);
    setSavedWorkouts(map);

    const context = await buildCoachContext(s.goal);
    const m = modelFromContext(context);
    const l = loadSnapshotFromContext(context);
    setModel(m);
    setLoad(l);
    const planned = calendar.find((e) => e.entryType === "planned" && e.date === today);
    const session: CoachPlanSession | null = planned
      ? {
          date: planned.date,
          name: planned.title,
          durationMin: Math.max(20, Math.round((planned.durationSecs ?? 3600) / 60)),
          description: planned.notes,
          plannedTss: planned.plannedTss,
          sessionType: planned.sessionType as SessionType | undefined,
          workoutId: planned.workoutId,
        }
      : null;
    setTodaySession(session);
    setAdaptation(session && ci ? adaptSession(session, { readiness: readinessScore(ci, l.tsb), model: m }) : null);
    return { context, settings: s };
  }, [today]);

  const hydrateBriefing = useCallback(async (next: CoachBriefing | null) => {
    if (!next) return;
    const context = await buildCoachContext(next.goal).catch(() => undefined);
    setArtifacts(briefingArtifacts(next, context));
  }, []);

  useEffect(() => {
    void fetchCoachHealth().then(setHealth);
    void getStravaStatus().then(setStrava).catch(() => setStrava(null));
    void (async () => {
      try {
        const { settings: s } = await refreshState();
        if (!s.onboarded && !s.goal) {
          setEditingSettings(true);
          return;
        }
        setBusy(true);
        const next = await ensureWeeklyReview();
        setBriefing(next);
        await hydrateBriefing(next);
        setPhases(await loadPlanPhases());
        await refreshState();
      } catch (e) {
        setError(String(e));
      } finally {
        setBusy(false);
      }
    })();
  }, [refreshState, hydrateBriefing]);

  useEffect(() => {
    void loadChatMessages().then((list) => {
      if (list.length) setMessages(list);
    });
  }, []);

  useEffect(() => {
    if (messages.length) void saveChatMessages(messages);
    chatEnd.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [messages]);

  async function applyLifeBlocks(blocks?: { id: string; label: string; date?: string; weekday?: string; slot: string; kind: string }[]) {
    if (!blocks?.length) return;
    for (const b of blocks) {
      await saveLifeBlock({
        id: b.id,
        label: b.label,
        date: b.date,
        weekday: b.weekday as import("../types").Weekday | undefined,
        slot: (b.slot as import("../types").LifeSlot) ?? "all",
        kind: (b.kind as import("../types").LifeBlockKind) ?? "busy",
        source: "chat",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }
  }

  async function regenerate(goal?: string) {
    setBusy(true);
    setError(null);
    try {
      const next = await ensureWeeklyReview({ force: true, goal });
      setBriefing(next);
      await hydrateBriefing(next);
      await refreshState();
      setNote("Piano rigenerato e scritto sul calendario.");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleSaveSettings(next: AthletePlanSettings) {
    const saved = await savePlanSettings(next);
    saveCoachGoal(saved.goal);
    setSettings(saved);
    setEditingSettings(false);
    await regenerate(saved.goal);
  }

  async function handleCheckin(c: DailyCheckin) {
    await saveCheckin(c);
    setCheckin(c);
    if (todaySession && model && load) {
      setAdaptation(adaptSession(todaySession, { readiness: readinessScore(c, load.tsb), model }));
    }
    setNote("Check-in salvato.");
  }

  async function applyAdaptation() {
    if (!adaptation?.changed || !adaptation.session) return;
    await applyPlanPatch([adaptation.session as CoachPlanSession], adaptation.draft ? [adaptation.draft as CoachWorkoutDraft] : []);
    setNote(`Oggi: ${adaptation.session.name}. Calendario aggiornato.`);
    await refreshState();
  }

  async function handleSaveWorkout(draft: CoachWorkoutDraft): Promise<Workout> {
    const existing = savedWorkouts.get(draft.name.toLowerCase());
    const workout = await saveWorkout({ ...workoutFromCoachDraft(draft), id: existing?.id ?? "", createdAt: existing?.createdAt ?? new Date().toISOString() });
    setSavedWorkouts((prev) => new Map(prev).set(draft.name.toLowerCase(), workout));
    return workout;
  }

  async function handleSavePlan(sessions: CoachPlanSession[]) {
    const pending = pendingPlans.current.get(sessions);
    if (pending) {
      await applyCoachResponse({ planUpdate: sessions, planMode: pending.mode, workouts: pending.workouts, phases: pending.phases });
      if (pending.phases?.length) setPhases(pending.phases);
    } else if (briefing && sessions === briefing.plan) {
      await applyCoachPlan(sessions, briefing.workouts);
    } else {
      await applyPlanPatch(sessions);
    }
    setNote(`Calendario aggiornato: ${sessions.length} sessioni.`);
    await refreshState();
  }

  async function rememberConstraint(constraint?: string) {
    if (!constraint) return;
    const next = await addSettingsConstraint(constraint);
    setSettings(next);
  }

  async function send(text: string) {
    const message = text.trim();
    if (!message || chatBusy) return;
    const history = messages.slice(-10).map((m) => ({ role: m.role, content: m.content }));
    setMessages((prev) => [...prev, { role: "user", content: message }, { role: "assistant", content: "" }]);
    setInput("");
    setChatBusy(true);
    setToolStatus(null);
    setError(null);
    const ctrl = new AbortController();
    chatAbort.current = ctrl;
    const apply = async (res: Awaited<ReturnType<typeof chatWithCoach>>) => {
      for (const a of res.artifacts ?? []) {
        if (a.type === "plan") {
          pendingPlans.current.set(a.sessions, { mode: res.planMode ?? "merge", workouts: res.workouts ?? [], phases: res.phases });
        }
      }
      if (res.artifacts?.length) setArtifacts((prev) => [...prev, ...res.artifacts!]);
      await rememberConstraint(res.persistentConstraint);
      await applyLifeBlocks(res.lifeBlocks);
      setMessages((prev) => {
        const next = [...prev];
        const last = next[next.length - 1];
        if (last?.role === "assistant") next[next.length - 1] = { role: "assistant", content: res.reply || last.content || "(nessuna risposta)", tools: res.toolsUsed };
        return next;
      });
    };
    try {
      await upsertLifeBlockFromMessage(message, { source: "chat" });
      const context = await buildCoachContext(settings?.goal);
      try {
        await streamCoachChat(
          message,
          history,
          context,
          detectDirectIntent(message),
          {
            onDelta: (text) =>
              setMessages((prev) => {
                const next = [...prev];
                const last = next[next.length - 1];
                if (last?.role === "assistant") next[next.length - 1] = { ...last, content: last.content + text };
                return next;
              }),
            onTool: setToolStatus,
            onDone: (res) => void apply(res),
          },
          ctrl.signal,
        );
      } catch (streamErr) {
        if (ctrl.signal.aborted) return;
        const res = await chatWithCoach(message, history, context, detectDirectIntent(message));
        await apply(res);
        void streamErr;
      }
    } catch (e) {
      setMessages((prev) => {
        const next = [...prev];
        const last = next[next.length - 1];
        const msg = `Coach non disponibile: ${String(e instanceof Error ? e.message : e)}`;
        if (last?.role === "assistant") next[next.length - 1] = { ...last, content: msg };
        else next.push({ role: "assistant", content: msg });
        return next;
      });
    } finally {
      setChatBusy(false);
      setToolStatus(null);
      chatAbort.current = null;
    }
  }

  async function quickAdjust(text: string) {
    if (chatBusy) return;
    setChatBusy(true);
    setMessages((prev) => [...prev, { role: "user", content: text }]);
    try {
      const context = await buildCoachContext(settings?.goal);
      let reply: string;
      try {
        const res = await fetchCoachAdjust({ message: text, context, constraints: settings?.constraints ?? [] });
        reply = res.reply;
        await rememberConstraint(res.persistentConstraint);
        await applyLifeBlocks(res.lifeBlocks);
        if (res.plan.length) await applyCoachResponse({ plan: res.plan, planMode: res.planMode ?? "merge", workouts: res.workouts });
      } catch {
        const calendar = await listCalendar().catch(() => []);
        const fallback = adjustPlanByRules(text, calendarToPlanSessions(calendar, today), today);
        reply = `${fallback.reply} (regole locali: coach AI non raggiungibile)`;
        await rememberConstraint(fallback.persistentConstraint);
        await upsertLifeBlockFromMessage(text, { source: "chat" });
        const changed = fallback.plan.filter((s) => s.date >= today);
        if (changed.length) await applyPlanPatch(changed);
      }
      setMessages((prev) => [...prev, { role: "assistant", content: reply }]);
      await refreshState();
    } finally {
      setChatBusy(false);
    }
  }

  const readiness = load ? readinessScore(checkin, load.tsb) : null;
  const athleteProfile = briefing?.athleteProfile ?? loadAthleteProfile();
  const currentWeek = mondayOfIso(today);
  const nextEvent = settings?.events.filter((e) => e.date >= today).sort((a, b) => a.date.localeCompare(b.date))[0];

  if (compact) {
    return (
      <section className="page coach-page coach-page--compact">
        <header className="mobile-page__header">
          <h1>Coach</h1>
          <p className="muted-copy">Scrivi come parleresti al preparatore.</p>
        </header>
        <div className="panel coach-chat-panel">
          <div className="quick-row">
            {QUICK_ADJUST.map((q) => (
              <button key={q} type="button" className="chip-toggle" disabled={chatBusy} onClick={() => void quickAdjust(q)}>
                {q}
              </button>
            ))}
          </div>
          <div className="chat-log chat-log--mobile">
            {messages.map((m, i) => (
              <div key={i} className={`chat-msg chat-msg--${m.role}`}>
                {m.role === "assistant" ? <RichText text={m.content} /> : <p className="rich-text__p">{m.content}</p>}
              </div>
            ))}
            {chatBusy && <div className="chat-msg chat-msg--assistant muted-copy">Il coach sta analizzando…</div>}
            <div ref={chatEnd} />
          </div>
          <form
            className="chat-input chat-input--mobile"
            onSubmit={(e) => {
              e.preventDefault();
              void send(input);
            }}
          >
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Es. giovedì sono fuori, sposta la soglia"
              maxLength={2000}
            />
            <button type="submit" className="btn btn--primary" disabled={chatBusy || !input.trim()}>
              Invia
            </button>
          </form>
        </div>
        {error && <p className="error-banner">{error}</p>}
      </section>
    );
  }

  if (editingSettings && settings) {
    return (
      <section className="page coach-page">
        <header className="hero hero--compact">
          <p className="eyebrow">Coach WattLab</p>
          <h1>{settings.onboarded ? "Preferenze e obiettivi" : "Configuriamo il tuo coach"}</h1>
          <p className="hero__copy">
            Il piano viene calcolato dal motore WattLab su obiettivo, eventi, disponibilità e preferenze; il coach AI lo spiega e
            lo adatta ogni giorno.
          </p>
        </header>
        <AthleteSettingsForm initial={settings} busy={busy} onSave={(s) => void handleSaveSettings(s)} onCancel={settings.onboarded ? () => setEditingSettings(false) : undefined} />
        {error && <p className="error-banner">{error}</p>}
      </section>
    );
  }

  return (
    <section className="page coach-page">
      <header className="hero hero--compact">
        <p className="eyebrow">Coach WattLab</p>
        <h1>Coach adattivo</h1>
        <p className="hero__copy">
          {settings?.goal ? `Obiettivo: ${settings.goal}` : "Imposta un obiettivo per generare il piano."}
          {nextEvent ? ` · ${nextEvent.name} il ${nextEvent.date}` : ""}
        </p>
        <div className="onboard-row">
          <button type="button" className="btn btn--ghost btn--small" onClick={() => setEditingSettings(true)}>
            Preferenze e obiettivi
          </button>
          <button type="button" className="btn btn--ghost btn--small" disabled={busy} onClick={() => void regenerate(settings?.goal)}>
            {busy ? "Calcolo piano…" : "Rigenera piano"}
          </button>
          {health && (
            <span className={`coach-health coach-health--${health.ok ? "ok" : "ko"}`}>
              {coachHealthLabel(health.activeModel, health.provider, health.ok)}
              {health.error ? ` · ${health.error}` : ""}
            </span>
          )}
        </div>
        {strava?.connected && !strava.canRead && (
          <p className="error-banner">
            Strava non è collegato in lettura. Vai su Profilo → Strava → Ricollega.{" "}
            {onOpenProfile && (
              <button type="button" className="btn btn--ghost btn--small" onClick={onOpenProfile}>
                Apri Profilo
              </button>
            )}
          </p>
        )}
        {strava?.canRead && (
          <p className="muted-copy">
            Strava: {strava.imported ?? 0} attività sincronizzate
            {strava.lastSyncAt ? ` · ultimo sync ${strava.lastSyncAt.slice(11, 16)}` : ""}
          </p>
        )}
      </header>

      {load && (
        <div className="eval-strip">
          <div>
            <span>Focus</span>
            <strong>{briefing ? focusLabel(briefing.focus) : "–"}</strong>
          </div>
          <div>
            <span>CTL / ATL / TSB</span>
            <strong>
              {load.ctl} / {load.atl} / {load.tsb}
            </strong>
          </div>
          <div>
            <span>Ramp · ACWR</span>
            <strong>
              {load.rampRate} · {load.acwr}
            </strong>
          </div>
          <div>
            <span>Stato</span>
            <strong>{load.status}</strong>
          </div>
          {model && (
            <div>
              <span>FTP · CP · LT1</span>
              <strong>
                {model.ftp} · {model.cp} · {model.lt1} W
              </strong>
            </div>
          )}
        </div>
      )}

      <div className="coach-layout">
        <div>
          <DailyCheckinCard date={today} initial={checkin} readiness={readiness} onSave={(c) => void handleCheckin(c)} />

          <div className="eval-card eval-card--today">
            <p className="eyebrow">Oggi</p>
            {todaySession ? (
              <>
                <h2>{todaySession.name}</h2>
                <p>
                  {todaySession.durationMin} min
                  {todaySession.plannedTss ? ` · ${Math.round(todaySession.plannedTss)} TSS previsti` : ""}
                  {todaySession.sessionType && todaySession.sessionType in SESSION_TYPE_META
                    ? ` · ${SESSION_TYPE_META[todaySession.sessionType as SessionType].label}`
                    : ""}
                </p>
                {todaySession.description && <p className="artifact__meta">{todaySession.description.replace(/^Coach WattLab · /, "")}</p>}
                {adaptation && <p className={adaptation.changed ? "success-banner" : "muted-copy"}>{adaptation.reason}</p>}
                <div className="onboard-row">
                  {adaptation?.changed && (
                    <button type="button" className="btn btn--primary btn--small" onClick={() => void applyAdaptation()}>
                      Applica: {adaptation.session?.name}
                    </button>
                  )}
                  {todaySession.workoutId && onStartWorkout && [...savedWorkouts.values()].find((w) => w.id === todaySession.workoutId) && (
                    <button
                      type="button"
                      className="btn btn--ghost btn--small"
                      onClick={() => {
                        const w = [...savedWorkouts.values()].find((x) => x.id === todaySession.workoutId);
                        if (w) onStartWorkout(w);
                      }}
                    >
                      Avvia
                    </button>
                  )}
                </div>
              </>
            ) : (
              <p className="muted-copy">Riposo o giornata libera. Fai il check-in per un consiglio personalizzato.</p>
            )}
          </div>
        </div>

        <div>
          <div className="panel">
            <h3>Macrociclo</h3>
            {phases.length ? (
              <div className="phase-strip">
                {phases.map((p) => (
                  <div
                    key={p.weekStart}
                    className={`phase-week${p.weekStart === currentWeek ? " phase-week--current" : ""}`}
                    style={{ ["--phase-color" as string]: PHASE_COLORS[p.phase] }}
                    title={p.focusNote}
                  >
                    <strong>{p.label}</strong>
                    {p.weekStart.slice(8)}/{p.weekStart.slice(5, 7)}
                    <br />
                    {p.plannedTss} / {p.targetTss} TSS
                  </div>
                ))}
              </div>
            ) : (
              <p className="muted-copy">Nessun piano ancora generato.</p>
            )}
            {briefing?.planSummary && <p className="muted-copy">{briefing.planSummary}</p>}
            {phases.find((p) => p.weekStart === currentWeek)?.focusNote && (
              <p className="muted-copy">Questa settimana: {phases.find((p) => p.weekStart === currentWeek)?.focusNote}</p>
            )}
          </div>

          {briefing && (
            <ul className="eval-recs">
              {briefing.recommendations.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          )}

          {briefing?.weekReview && (
            <div className="eval-card">
              <p className="eyebrow">Bilancio settimanale</p>
              <RichText text={briefing.weekReview} className="rich-text--prose" />
            </div>
          )}
        </div>
      </div>

      <div className="coach-layout">
        <div className="panel">
          <h3>Chiedi al coach</h3>
          <div className="quick-row">
            {QUICK_PROMPTS.map((q) => (
              <button key={q} type="button" className="btn btn--ghost btn--small" disabled={chatBusy} onClick={() => void send(q)}>
                {q}
              </button>
            ))}
          </div>
          <div className="quick-row">
            {QUICK_ADJUST.map((q) => (
              <button key={q} type="button" className="chip-toggle" disabled={chatBusy} onClick={() => void quickAdjust(q)}>
                {q}
              </button>
            ))}
          </div>
          <div className="chat-log">
            {messages.length === 0 && (
              <p className="muted-copy">
                Chiedi analisi, workout, piani, lattato, alimentazione. I numeri arrivano dal motore WattLab, il coach li spiega.
              </p>
            )}
            {messages.map((m, i) => (
              <div key={i} className={`chat-msg chat-msg--${m.role}`}>
                {m.role === "assistant" ? <RichText text={m.content} /> : <p className="rich-text__p">{m.content}</p>}
                {toolsUsedLabel(m.tools) ? (
                  <span className="chat-msg__tools">Dati usati: {toolsUsedLabel(m.tools)}</span>
                ) : null}
              </div>
            ))}
            {chatBusy && toolStatus && <div className="chat-tool-status">{toolStatus}…</div>}
            {chatBusy && !toolStatus && <div className="chat-msg chat-msg--assistant muted-copy">Il coach sta analizzando i tuoi dati…</div>}
            <div ref={chatEnd} />
          </div>
          <form
            className="chat-input"
            onSubmit={(e) => {
              e.preventDefault();
              void send(input);
            }}
          >
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send(input);
                }
              }}
              placeholder="Es. martedì non posso, sposta la soglia · quanto lattato a 280 W? · preparami per la Maratona delle Dolomiti"
              maxLength={2000}
            />
            <div className="onboard-form">
              <button type="submit" className="btn btn--primary" disabled={chatBusy || !input.trim()}>
                Invia
              </button>
              {chatBusy && (
                <button type="button" className="btn btn--ghost btn--small" onClick={() => chatAbort.current?.abort()}>
                  Stop
                </button>
              )}
              {messages.length > 0 && (
                <button type="button" className="btn btn--ghost btn--small" onClick={() => setMessages([])}>
                  Pulisci
                </button>
              )}
            </div>
          </form>
        </div>

        <div className="coach-workspace">
          <CoachArtifactCanvas
            artifacts={artifacts}
            profileFtp={profileFtp}
            savedWorkoutNames={savedWorkoutNames}
            savedWorkouts={savedWorkouts}
            applied={false}
            onSaveWorkout={handleSaveWorkout}
            onStartWorkout={onStartWorkout}
            onSavePlan={(sessions) => handleSavePlan(sessions)}
          />
        </div>
      </div>

      {lastEval && (
        <div className="eval-card">
          <p className="eyebrow">Ultima sessione</p>
          <h2>{lastEval.title}</h2>
          <p>
            IF {lastEval.intensityFactor.toFixed(2)} · TSS {lastEval.tss} · {lastEval.verdict}
          </p>
          <RichText text={lastEval.summary} className="rich-text--prose" />
          <div className="zone-grid">
            <ZoneBars title="Zone potenza (Coggan)" zones={lastEval.powerZones} />
            <ZoneBars title="Zone cardiache" zones={lastEval.hrZones} />
          </div>
        </div>
      )}

      {athleteProfile && (
        <div className="eval-card">
          <p className="eyebrow">Profilo atleta</p>
          {athleteProfile.strengths.length > 0 && (
            <p>
              <strong>Punti forti:</strong> {athleteProfile.strengths.join(", ")}
            </p>
          )}
          {athleteProfile.weaknesses.length > 0 && (
            <p>
              <strong>Da migliorare:</strong> {athleteProfile.weaknesses.join(", ")}
            </p>
          )}
          {athleteProfile.consistency && <p>{athleteProfile.consistency}</p>}
        </div>
      )}

      {briefing?.docs?.length ? (
        <details className="eval-docs">
          <summary>Knowledge: schede scientifiche per il tuo focus</summary>
          {briefing.docs.map((doc) => (
            <article key={doc.id} className="doc-card">
              <h3>{doc.title}</h3>
              <p className="artifact__meta">{doc.source}</p>
              <RichText text={doc.body} className="rich-text--prose" />
            </article>
          ))}
        </details>
      ) : null}

      {note && (
        <p className="success-banner" onClick={() => setNote(null)}>
          {note}
        </p>
      )}
      {error && (
        <p className="error-banner" onClick={() => setError(null)}>
          {error}
        </p>
      )}
    </section>
  );
}
