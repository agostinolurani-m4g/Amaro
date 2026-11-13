import { amaroJson } from "../lib/amaroAuth";
import { coachLlm } from "../lib/coachLlm";
import { KNOWLEDGE_CARDS } from "../lib/trainingDocs";
import { workoutTotalDuration } from "../lib/workoutEngine";
import {
  chatWithCoach as runCoachChat,
  coachAdjustPlan,
  coachBatchComments,
  coachSessionComment,
  coachWeeklyReview,
} from "../../shared/coach/agent.mjs";
import { configureCoachServices } from "../../shared/coach/tools.mjs";
import {
  getPersonalRecords,
  getProfile,
  listCalendar,
  listWorkouts,
  todayIso,
} from "./useStorage";
import { listCheckins, loadPlanSettings } from "../lib/athleteStore";
import { listLifeBlocks } from "../lib/lifeBlockStore";
import { emptyPersonalRecords } from "../lib/sessionStats";
import type {
  CoachActivity,
  CoachAthleteProfile,
  CoachChatResponse,
  CoachContext,
  CoachHealth,
  CoachPlanSession,
  CoachWorkoutDraft,
  CalendarEntry,
  SessionEvaluation,
  SessionSeriesPoint,
} from "../types";
import type { CoachDirectIntent } from "../lib/coachCharts";

export type { CoachDirectIntent };

// L'agente gira nell'app; il sito fa solo da tramite verso il modello.
configureCoachServices({ cards: KNOWLEDGE_CARDS });

function downsampleSeriesPoints(
  points: SessionSeriesPoint[],
  maxPoints = 200,
): SessionSeriesPoint[] {
  if (points.length <= maxPoints) return points;
  const step = Math.ceil(points.length / maxPoints);
  const out: SessionSeriesPoint[] = [];
  for (let i = 0; i < points.length; i += step) {
    out.push(points[i]);
  }
  return out;
}

function toActivity(entry: CalendarEntry): CoachActivity {
  let maxPower: number | undefined;
  if (entry.series?.length) {
    const peaks = entry.series
      .map((p) => p.power ?? 0)
      .filter((w) => w > 0);
    if (peaks.length > 0) maxPower = Math.max(...peaks);
  }

  return {
    id: entry.id,
    date: entry.date,
    title: entry.title,
    entryType: entry.entryType,
    durationSecs: entry.durationSecs,
    avgPower: entry.avgPower,
    maxPower: entry.maxPower ?? maxPower,
    hasSeries: !!(entry.series && entry.series.length > 0),
    np: entry.np,
    tss: entry.tss,
    ifactor: entry.ifactor,
    kj: entry.kj,
    avgHr: entry.avgHr,
    maxHr: entry.maxHr,
    decoupling: entry.decoupling,
    mmp: entry.mmp,
    zoneSecs: entry.zoneSecs,
    rpe: entry.rpe,
    feel: entry.feel,
    plannedTss: entry.plannedTss,
    compliance: entry.compliance,
    sessionType: entry.sessionType,
    sport: entry.sport,
    workoutId: entry.workoutId,
    notes: entry.notes?.slice(0, 200),
    coachComment: entry.coachComment?.slice(0, 300),
  };
}

export async function buildCoachContext(goal?: string): Promise<CoachContext> {
  const [profile, calendar, workouts, records, settings, checkins, lifeBlocks] = await Promise.all([
    getProfile(),
    listCalendar().catch(() => []),
    listWorkouts().catch(() => []),
    getPersonalRecords().catch(() => emptyPersonalRecords()),
    loadPlanSettings(),
    listCheckins(),
    listLifeBlocks(),
  ]);

  const activities = calendar
    .filter((e) => e.entryType === "completed" || e.entryType === "imported")
    .map(toActivity);

  const sessionSeries: Record<string, SessionSeriesPoint[]> = {};
  calendar
    .filter((e) => e.entryType !== "planned" && e.series && e.series.length > 0)
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 8)
    .forEach((entry) => {
      sessionSeries[entry.id] = downsampleSeriesPoints(entry.series!);
    });

  return {
    profile,
    goal: goal?.trim() || settings.goal || undefined,
    settings,
    checkins: checkins.slice(-14),
    lifeBlocks,
    today: todayIso(),
    activities,
    planned: calendar.filter((e) => e.entryType === "planned").map(toActivity),
    workouts: workouts.map((w) => ({
      id: w.id,
      name: w.name,
      durationSecs: workoutTotalDuration(w),
      category: w.category,
    })),
    records,
    sessionSeries:
      Object.keys(sessionSeries).length > 0 ? sessionSeries : undefined,
  };
}

type ChatHistory = { role: "user" | "assistant"; content: string }[];

export async function chatWithCoach(
  message: string,
  history: ChatHistory,
  context: CoachContext,
  directIntent?: CoachDirectIntent,
): Promise<CoachChatResponse> {
  return (await runCoachChat({ llm: coachLlm, message, history, context, directIntent })) as CoachChatResponse;
}

export async function streamCoachChat(
  message: string,
  history: ChatHistory,
  context: CoachContext,
  directIntent: CoachDirectIntent | undefined,
  handlers: {
    onDelta: (text: string) => void;
    onTool: (label: string | null) => void;
    onDone: (res: CoachChatResponse) => void;
  },
  signal?: AbortSignal,
): Promise<void> {
  const res = await runCoachChat({
    llm: coachLlm,
    message,
    history,
    context,
    directIntent,
    signal,
    emit: (ev: { type: string; text?: string; label?: string }) => {
      if (ev.type === "delta" && ev.text) handlers.onDelta(ev.text);
      if (ev.type === "tool_start") handlers.onTool(ev.label ?? "strumento");
      if (ev.type === "tool_end") handlers.onTool(null);
    },
  });
  handlers.onDone(res as CoachChatResponse);
}

export async function fetchCoachComment(input: {
  context: CoachContext;
  session: Record<string, unknown>;
  planned?: CoachActivity | null;
  evaluation?: SessionEvaluation | null;
  athleteProfile?: CoachAthleteProfile | null;
}): Promise<{ comment: string }> {
  return coachSessionComment({ llm: coachLlm, ...input });
}

export async function fetchCoachBatchComments(input: {
  context: CoachContext;
  athleteProfile?: CoachAthleteProfile | null;
  sessions: Record<string, unknown>[];
}): Promise<{ comments: { id: string; comment: string }[] }> {
  return coachBatchComments({ llm: coachLlm, ...input });
}

export async function fetchCoachWeekly(input: {
  context: CoachContext;
  constraints?: string[];
}): Promise<{
  athleteProfile: CoachAthleteProfile;
  weekReview: string;
  plan: CoachPlanSession[];
  workouts?: CoachWorkoutDraft[];
  reply?: string;
}> {
  return coachWeeklyReview({ llm: coachLlm, ...input });
}

export async function fetchCoachAdjust(input: {
  message: string;
  context: CoachContext;
  constraints?: string[];
}): Promise<{
  reply: string;
  plan: CoachPlanSession[];
  planMode?: "replace" | "merge";
  workouts?: CoachWorkoutDraft[];
  persistentConstraint?: string;
  lifeBlocks?: { id: string; label: string; date?: string; weekday?: string; slot: string; kind: string }[];
}> {
  return coachAdjustPlan({ llm: coachLlm, ...input });
}

export async function fetchCoachHealth(): Promise<CoachHealth | null> {
  try {
    return await amaroJson<CoachHealth>("/api/wattlab/coach/health", { method: "GET" });
  } catch {
    return null;
  }
}
