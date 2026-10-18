import type {
  CoachAthleteProfile,
  CoachBriefing,
  CoachPlanSession,
  SessionEvaluation,
  TrainingFocus,
} from "../types";

const GOAL_KEY = "wattlab.coach.goal";
const BRIEFING_KEY = "wattlab.coach.briefing.v2";
const EVAL_KEY = "wattlab.coach.lastEval";
const ATHLETE_KEY = "wattlab.coach.athleteProfile";
const WEEKLY_KEY = "wattlab.coach.lastWeeklyReviewAt";
const CONSTRAINTS_KEY = "wattlab.coach.constraints";

export function loadCoachGoal(): string {
  try {
    return localStorage.getItem(GOAL_KEY) ?? "";
  } catch {
    return "";
  }
}

export function saveCoachGoal(goal: string): void {
  localStorage.setItem(GOAL_KEY, goal.trim());
}

export function loadBriefing(): CoachBriefing | null {
  try {
    const raw = localStorage.getItem(BRIEFING_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as CoachBriefing;
  } catch {
    return null;
  }
}

export function saveBriefing(briefing: CoachBriefing): void {
  localStorage.setItem(BRIEFING_KEY, JSON.stringify(briefing));
}

export function loadLastEval(): SessionEvaluation | null {
  try {
    const raw = localStorage.getItem(EVAL_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as SessionEvaluation;
  } catch {
    return null;
  }
}

export function saveLastEval(evaluation: SessionEvaluation): void {
  localStorage.setItem(EVAL_KEY, JSON.stringify(evaluation));
}

export function briefingIsFresh(briefing: CoachBriefing | null, goal: string): boolean {
  if (!briefing) return false;
  if (briefing.goal.trim() !== goal.trim()) return false;
  const day = briefing.generatedAt.slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);
  return day === today;
}

export function isoWeekKey(d: Date): string {
  return isoDate(mondayOf(d));
}

export function loadLastWeeklyReviewAt(): string | null {
  try {
    return localStorage.getItem(WEEKLY_KEY);
  } catch {
    return null;
  }
}

export function saveLastWeeklyReviewAt(iso: string): void {
  localStorage.setItem(WEEKLY_KEY, iso);
}

export function weeklyReviewIsFresh(goal: string): boolean {
  const last = loadLastWeeklyReviewAt();
  if (!last) return false;
  const briefing = loadBriefing();
  if (briefing && briefing.goal.trim() !== goal.trim()) return false;
  return isoWeekKey(new Date(last)) === isoWeekKey(new Date());
}

export function loadAthleteProfile(): CoachAthleteProfile | null {
  try {
    const raw = localStorage.getItem(ATHLETE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as CoachAthleteProfile;
  } catch {
    return null;
  }
}

export function saveAthleteProfile(profile: CoachAthleteProfile): void {
  localStorage.setItem(ATHLETE_KEY, JSON.stringify(profile));
}

export function loadConstraints(): string[] {
  try {
    const raw = localStorage.getItem(CONSTRAINTS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export function saveConstraints(constraints: string[]): void {
  localStorage.setItem(CONSTRAINTS_KEY, JSON.stringify(constraints.slice(0, 12)));
}

export function addConstraint(constraint: string): string[] {
  const trimmed = constraint.trim();
  if (!trimmed) return loadConstraints();
  const next = [...loadConstraints().filter((c) => c !== trimmed), trimmed].slice(-12);
  saveConstraints(next);
  return next;
}

export function focusLabel(focus: TrainingFocus): string {
  const labels: Record<TrainingFocus, string> = {
    ftp: "FTP / soglia",
    vo2: "VO2max",
    endurance: "Endurance Z2",
    granfondo: "Granfondo",
    climb: "Salita / forza",
    recovery: "Recupero",
    mixed: "Misto indoor",
  };
  return labels[focus];
}

export function isoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function addDays(d: Date, n: number): Date {
  const next = new Date(d);
  next.setDate(next.getDate() + n);
  return next;
}

export function mondayOf(d: Date): Date {
  const copy = new Date(d);
  const dow = (copy.getDay() + 6) % 7;
  copy.setHours(0, 0, 0, 0);
  copy.setDate(copy.getDate() - dow);
  return copy;
}

export function sessionsForWeek(
  sessions: CoachPlanSession[],
  weekStart: Date,
): CoachPlanSession[] {
  const start = isoDate(weekStart);
  const end = isoDate(addDays(weekStart, 6));
  return sessions.filter((s) => s.date >= start && s.date <= end);
}
