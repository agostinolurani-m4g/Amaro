import type {
  CalendarEntry,
  CoachArtifact,
  CoachBriefing,
  CoachContext,
  CoachPlanSession,
  CoachWebSource,
  CoachWorkoutDraft,
  LoadSnapshot,
  PlanPhaseWeek,
  TrainingFocus,
} from "../types";
import { buildCoachContext, fetchCoachWeekly } from "../hooks/useCoach";
import {
  deleteCalendarEntry,
  listCalendar,
  listWorkouts,
  saveCalendarEntry,
  saveWorkout,
  todayIso,
} from "../hooks/useStorage";
import { buildPmcChartArtifact } from "./coachCharts";
import { detectFocus, docsForFocus, webQueryForFocus } from "./trainingDocs";
import { loadSnapshotFromContext } from "./sessionEvaluation";
import { workoutFromCoachDraft } from "./coachWorkouts";
import { amaroJson } from "./amaroAuth";
import {
  loadAthleteProfile,
  loadBriefing,
  saveAthleteProfile,
  saveBriefing,
  saveLastWeeklyReviewAt,
  weeklyReviewIsFresh,
} from "./coachStore";
import { loadPlanSettings, savePlanPhases } from "./athleteStore";
import { athleteModel } from "../../shared/engine/physiology.mjs";
import { generatePlan } from "../../shared/engine/planner.mjs";
import { addDaysIso } from "../../shared/engine/dates.mjs";

export const COACH_PLAN_NOTE = "Coach WattLab";

export type AthleteModel = ReturnType<typeof athleteModel>;

export function modelFromContext(context: CoachContext): AthleteModel {
  return athleteModel(context.profile, context.activities, { records: context.records });
}

function recentCompliance(context: CoachContext): number | null {
  const from = addDaysIso(todayIso(), -14);
  const values = context.activities
    .filter((a) => a.date >= from && a.compliance != null)
    .map((a) => a.compliance as number);
  if (values.length === 0) return null;
  return Math.round(values.reduce((s, v) => s + v, 0) / values.length);
}

function recommendations(
  focus: TrainingFocus,
  load: LoadSnapshot,
  model: AthleteModel,
  planSummary: string,
): string[] {
  const recs = [load.summary, planSummary];
  if (load.status === "affaticato") {
    recs.push("Questa settimana niente Z5–Z6: il piano parte con un deload.");
  } else if (focus === "ftp") {
    recs.push(`Lavora tra ${Math.round(model.ftp * 0.88)} e ${Math.round(model.ftp * 1.0)} W. Test 20' solo con TSB > +5.`);
  } else if (focus === "vo2") {
    recs.push(`Ripetute VO2 a ${Math.round(model.ftp * 1.1)}–${Math.round(model.ftp * 1.2)} W, una ogni 72 h.`);
  } else if (focus === "granfondo") {
    recs.push(`Lungo sotto LT1 (${model.lt1} W) e 60–90 g/h di carboidrati sopra i 90'.`);
  } else if (focus === "climb") {
    recs.push("Forza a 55–65 rpm in Z3–Z4, mai in VO2. Lavora sul W/kg.");
  } else {
    recs.push(`80% del tempo sotto LT1 (${model.lt1} W), 20% sopra LT2 (${model.lt2} W).`);
  }
  for (const w of model.warnings.slice(0, 2)) recs.push(w);
  return recs.filter(Boolean);
}

async function fetchDocs(goal: string, focus: TrainingFocus): Promise<{ query: string; results: CoachWebSource[] }> {
  const query = webQueryForFocus(focus, goal);
  try {
    const data = await amaroJson<{ query: string; results: CoachWebSource[]; error?: string }>(
      "/api/wattlab/coach/docs",
      { method: "POST", body: JSON.stringify({ goal, query }) },
    );
    return { query: data.query || query, results: data.results ?? [] };
  } catch {
    return { query, results: [] };
  }
}

function isCoachPlanned(entry: CalendarEntry): boolean {
  return entry.entryType === "planned" && (entry.coachPlan === true || (entry.notes ?? "").includes(COACH_PLAN_NOTE));
}

/** Salva i workout del piano e riscrive le sessioni coach future sul calendario. */
async function applyPlanAndWorkouts(sessions: CoachPlanSession[], drafts: CoachWorkoutDraft[]): Promise<void> {
  const ids = await saveDrafts(drafts);

  const calendar = await listCalendar().catch(() => []);
  const today = todayIso();
  const doneToday = new Set(
    calendar.filter((e) => e.entryType !== "planned" && e.date === today).map((e) => e.plannedEntryId),
  );
  for (const entry of calendar) {
    if (isCoachPlanned(entry) && entry.date >= today && !doneToday.has(entry.id)) {
      await deleteCalendarEntry(entry.id).catch(() => undefined);
    }
  }

  for (const s of sessions) {
    if (s.date < today) continue;
    await saveCalendarEntry({
      id: "",
      date: s.date,
      entryType: "planned",
      title: s.name,
      workoutId: s.workoutName ? ids.get(s.workoutName.toLowerCase()) : undefined,
      durationSecs: Math.round(s.durationMin * 60),
      notes: `${COACH_PLAN_NOTE} · ${s.description ?? ""}`.trim(),
      plannedTss: s.plannedTss,
      sessionType: s.sessionType,
      coachPlan: true,
    });
  }
}

export async function applyCoachPlan(sessions: CoachPlanSession[], drafts: CoachWorkoutDraft[] = []): Promise<void> {
  await applyPlanAndWorkouts(sessions, drafts);
}

async function saveDrafts(drafts: CoachWorkoutDraft[]): Promise<Map<string, string>> {
  const existing = await listWorkouts().catch(() => []);
  const ids = new Map<string, string>();
  for (const w of existing) ids.set(w.name.toLowerCase(), w.id);
  for (const draft of drafts) {
    const key = draft.name.toLowerCase();
    const found = existing.find((w) => w.name.toLowerCase() === key);
    const saved = await saveWorkout({ ...workoutFromCoachDraft(draft), id: found?.id ?? "", createdAt: found?.createdAt ?? new Date().toISOString() });
    ids.set(key, saved.id);
  }
  return ids;
}

/**
 * Modifica puntuale: per ogni sessione rimuove i pianificati nella data (e in `fromDate` se spostata)
 * e salva la nuova voce. Le altre giornate restano invariate.
 */
export async function applyPlanPatch(updates: CoachPlanSession[], drafts: CoachWorkoutDraft[] = []): Promise<void> {
  const ids = await saveDrafts(drafts);
  const calendar = await listCalendar().catch(() => []);
  const today = todayIso();
  for (const s of updates) {
    if (s.date < today) continue;
    const clear = new Set([s.date, s.fromDate].filter(Boolean) as string[]);
    const previous = calendar.find((e) => e.entryType === "planned" && e.date === (s.fromDate ?? s.date));
    for (const entry of calendar) {
      if (entry.entryType === "planned" && clear.has(entry.date)) {
        await deleteCalendarEntry(entry.id).catch(() => undefined);
      }
    }
    await saveCalendarEntry({
      id: "",
      date: s.date,
      entryType: "planned",
      title: s.name,
      workoutId: (s.workoutName ? ids.get(s.workoutName.toLowerCase()) : undefined) ?? s.workoutId ?? previous?.workoutId,
      durationSecs: Math.round(s.durationMin * 60),
      notes: `${COACH_PLAN_NOTE} · ${s.description ?? ""}`.trim(),
      plannedTss: s.plannedTss ?? previous?.plannedTss,
      sessionType: s.sessionType ?? previous?.sessionType,
      coachPlan: true,
    });
  }
}

/** Applica la risposta del coach (chat o adjust) al calendario. */
export async function applyCoachResponse(res: {
  planUpdate?: CoachPlanSession[];
  plan?: CoachPlanSession[];
  planMode?: "replace" | "merge";
  workouts?: CoachWorkoutDraft[];
  phases?: PlanPhaseWeek[];
}): Promise<boolean> {
  const sessions = res.planUpdate ?? res.plan ?? [];
  if (!sessions.length) return false;
  if (res.planMode === "replace") {
    await applyPlanAndWorkouts(sessions, res.workouts ?? []);
    if (res.phases?.length) await savePlanPhases(res.phases);
  } else {
    await applyPlanPatch(sessions, res.workouts ?? []);
  }
  return true;
}

let inflightWeekly: Promise<CoachBriefing | null> | null = null;

export async function ensureWeeklyReview(opts?: { force?: boolean; goal?: string }): Promise<CoachBriefing | null> {
  if (inflightWeekly) return inflightWeekly;
  inflightWeekly = runWeeklyReview(opts).finally(() => {
    inflightWeekly = null;
  });
  return inflightWeekly;
}

async function backfillCoachComments(context: CoachContext, athleteProfile: CoachBriefing["athleteProfile"]): Promise<void> {
  const calendar = await listCalendar().catch(() => []);
  const missing = calendar
    .filter((e) => (e.entryType === "completed" || e.entryType === "imported") && !e.coachComment)
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 5);
  if (missing.length === 0) return;
  try {
    const data = await amaroJson<{ comments: { id: string; comment: string }[] }>(
      "/api/wattlab/coach/batch-comments",
      {
        method: "POST",
        body: JSON.stringify({
          context,
          athleteProfile: athleteProfile ?? loadAthleteProfile(),
          sessions: missing.map((e) => ({
            id: e.id,
            date: e.date,
            title: e.title,
            durationSecs: e.durationSecs,
            avgPower: e.avgPower,
            np: e.np,
            tss: e.tss,
            ifactor: e.ifactor,
            avgHr: e.avgHr,
            decoupling: e.decoupling,
            rpe: e.rpe,
            compliance: e.compliance,
          })),
        }),
      },
    );
    for (const row of data.comments ?? []) {
      const entry = missing.find((m) => m.id === row.id);
      if (!entry || !row.comment) continue;
      await saveCalendarEntry({ ...entry, coachComment: row.comment });
    }
  } catch {
    // non bloccante
  }
}

async function runWeeklyReview(opts?: { force?: boolean; goal?: string }): Promise<CoachBriefing | null> {
  const settings = await loadPlanSettings();
  const goal = (opts?.goal ?? settings.goal ?? "").trim();
  if (!goal && !settings.onboarded) return loadBriefing();

  const cached = loadBriefing();
  if (!opts?.force && weeklyReviewIsFresh(goal) && cached) return cached;

  const context = await buildCoachContext(goal);
  const focus = detectFocus(goal);
  const load = loadSnapshotFromContext(context);
  const model = modelFromContext(context);
  const plan = generatePlan({
    settings: { ...settings, goal, focus },
    model,
    load,
    weeks: 4,
    compliance: recentCompliance(context),
  });

  const sessions = plan.sessions as CoachPlanSession[];
  const workouts = plan.workouts as CoachWorkoutDraft[];
  const phases = plan.phases as PlanPhaseWeek[];

  await applyPlanAndWorkouts(sessions, workouts);
  await savePlanPhases(phases);
  saveLastWeeklyReviewAt(new Date().toISOString());

  let athleteProfile = loadAthleteProfile() ?? undefined;
  let weekReview = "";
  try {
    const refreshed = await buildCoachContext(goal);
    const weekly = await fetchCoachWeekly({ context: refreshed, constraints: settings.constraints });
    if (weekly.athleteProfile) {
      athleteProfile = weekly.athleteProfile;
      saveAthleteProfile(weekly.athleteProfile);
    }
    weekReview = weekly.weekReview ?? "";
  } catch {
    weekReview = `Settimana scorsa: ${load.prevWeekTss} TSS, ultimi 7 giorni ${load.weekTss} TSS. CTL ${load.ctl}, TSB ${load.tsb}.`;
  }

  const web = await fetchDocs(goal, focus);
  const briefing: CoachBriefing = {
    generatedAt: new Date().toISOString(),
    goal,
    focus,
    load,
    verdict: weekReview || `Focus ${focus} · CTL ${load.ctl} · TSB ${load.tsb}`,
    recommendations: recommendations(focus, load, model, plan.summary),
    plan: sessions,
    workouts,
    docs: docsForFocus(focus),
    sources: web.results.length ? web.results : undefined,
    sourcesQuery: web.query,
    applied: true,
    athleteProfile,
    weekReview,
    phases,
    planSummary: plan.summary,
  };
  saveBriefing(briefing);
  void backfillCoachComments(context, athleteProfile);
  return briefing;
}

export function briefingArtifacts(briefing: CoachBriefing, context?: CoachContext): CoachArtifact[] {
  const artifacts: CoachArtifact[] = [];
  artifacts.push({ type: "plan", sessions: briefing.plan, weeks: 4 });
  for (const draft of briefing.workouts.slice(0, 8)) {
    artifacts.push({ type: "workout", draft });
  }
  if (context) {
    const chart = buildPmcChartArtifact(context);
    if (chart) artifacts.push({ type: "chart", chart });
  }
  if (briefing.sources?.length) {
    artifacts.push({ type: "sources", results: briefing.sources, query: briefing.sourcesQuery ?? "" });
  }
  return artifacts;
}
