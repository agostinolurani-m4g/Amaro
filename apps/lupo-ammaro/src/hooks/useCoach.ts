import { amaroFetch, amaroJson, API_URL } from "../lib/amaroAuth";
import { workoutTotalDuration } from "../lib/workoutEngine";
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

export async function chatWithCoach(
  message: string,
  history: { role: "user" | "assistant"; content: string }[],
  context: CoachContext,
  directIntent?: CoachDirectIntent,
): Promise<CoachChatResponse> {
  return amaroJson<CoachChatResponse>("/api/wattlab/coach/chat", {
    method: "POST",
    body: JSON.stringify({ message, history, context, directIntent }),
  });
}

export async function streamCoachChat(
  message: string,
  history: { role: "user" | "assistant"; content: string }[],
  context: CoachContext,
  directIntent: CoachDirectIntent | undefined,
  handlers: {
    onDelta: (text: string) => void;
    onTool: (label: string | null) => void;
    onDone: (res: CoachChatResponse) => void;
  },
  signal?: AbortSignal,
): Promise<void> {
  const { getAuth } = await import("./useStorage");
  const stored = await getAuth();
  const res = await amaroFetch(`${API_URL}/api/wattlab/coach/chat/stream`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${stored?.token ?? ""}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ message, history, context, directIntent }),
    signal,
  });
  if (!res.ok || !res.body) throw new Error("stream");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const chunks = buf.split("\n\n");
    buf = chunks.pop() ?? "";
    for (const chunk of chunks) {
      const dataLine = chunk.split("\n").find((l) => l.startsWith("data:"));
      if (!dataLine) continue;
      const ev = JSON.parse(dataLine.slice(5).trim()) as {
        type: string;
        text?: string;
        label?: string;
        response?: CoachChatResponse;
        message?: string;
      };
      if (ev.type === "delta" && ev.text) handlers.onDelta(ev.text);
      if (ev.type === "tool_start") handlers.onTool(ev.label ?? "strumento");
      if (ev.type === "tool_end") handlers.onTool(null);
      if (ev.type === "done" && ev.response) handlers.onDone(ev.response);
      if (ev.type === "error") throw new Error(ev.message ?? "Coach non disponibile.");
    }
  }
}

export async function fetchCoachComment(input: {
  context: CoachContext;
  session: Record<string, unknown>;
  planned?: CoachActivity | null;
  evaluation?: SessionEvaluation | null;
  athleteProfile?: CoachAthleteProfile | null;
}): Promise<{ comment: string }> {
  return amaroJson<{ comment: string }>("/api/wattlab/coach/comment", {
    method: "POST",
    body: JSON.stringify(input),
  });
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
  return amaroJson("/api/wattlab/coach/weekly", {
    method: "POST",
    body: JSON.stringify(input),
  });
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
}> {
  return amaroJson("/api/wattlab/coach/adjust", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function fetchCoachHealth(): Promise<CoachHealth | null> {
  try {
    return await amaroJson<CoachHealth>("/api/wattlab/coach/health", { method: "GET" });
  } catch {
    return null;
  }
}
