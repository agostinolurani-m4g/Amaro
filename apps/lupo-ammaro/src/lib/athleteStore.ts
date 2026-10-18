import { getDoc, saveDoc, todayIso } from "../hooks/useStorage";
import type { AthletePlanSettings, DailyCheckin, PlanPhaseWeek, Weekday } from "../types";
import { loadCoachGoal, loadConstraints } from "./coachStore";
import { detectFocus } from "./trainingDocs";

const SETTINGS_DOC = "athlete_settings";
const CHECKINS_DOC = "checkins";
const PHASES_DOC = "plan_phases";

export const WEEKDAY_ORDER: Weekday[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
export const WEEKDAY_NAMES: Record<Weekday, string> = {
  mon: "Lunedì",
  tue: "Martedì",
  wed: "Mercoledì",
  thu: "Giovedì",
  fri: "Venerdì",
  sat: "Sabato",
  sun: "Domenica",
};

export function defaultSettings(): AthletePlanSettings {
  const goal = loadCoachGoal();
  return {
    goal,
    focus: goal ? detectFocus(goal) : undefined,
    events: [],
    availability: { mon: 0, tue: 60, wed: 60, thu: 60, fri: 0, sat: 120, sun: 90 },
    outdoorDays: [],
    maxHoursWeek: 8,
    experience: "intermedio",
    preferredLongDay: "sat",
    likes: [],
    avoid: [],
    constraints: loadConstraints(),
    onboarded: false,
  };
}

export async function loadPlanSettings(): Promise<AthletePlanSettings> {
  const stored = await getDoc<AthletePlanSettings>(SETTINGS_DOC).catch(() => null);
  const base = defaultSettings();
  if (!stored) return base;
  return {
    ...base,
    ...stored,
    availability: { ...base.availability, ...(stored.availability ?? {}) },
    events: stored.events ?? [],
    constraints: stored.constraints ?? base.constraints,
  };
}

export async function savePlanSettings(settings: AthletePlanSettings): Promise<AthletePlanSettings> {
  const next = {
    ...settings,
    focus: settings.goal ? detectFocus(settings.goal) : settings.focus,
    updatedAt: new Date().toISOString(),
  };
  await saveDoc(SETTINGS_DOC, next);
  return next;
}

export async function addSettingsConstraint(constraint: string): Promise<AthletePlanSettings> {
  const current = await loadPlanSettings();
  const trimmed = constraint.trim();
  if (!trimmed) return current;
  return savePlanSettings({
    ...current,
    constraints: [...current.constraints.filter((c) => c !== trimmed), trimmed].slice(-12),
  });
}

export async function listCheckins(): Promise<DailyCheckin[]> {
  const list = await getDoc<DailyCheckin[]>(CHECKINS_DOC).catch(() => null);
  return Array.isArray(list) ? list : [];
}

export async function saveCheckin(checkin: DailyCheckin): Promise<DailyCheckin[]> {
  const list = await listCheckins();
  const next = [...list.filter((c) => c.date !== checkin.date), checkin]
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-90);
  await saveDoc(CHECKINS_DOC, next);
  return next;
}

export async function todayCheckin(): Promise<DailyCheckin | null> {
  const today = todayIso();
  return (await listCheckins()).find((c) => c.date === today) ?? null;
}

export async function loadPlanPhases(): Promise<PlanPhaseWeek[]> {
  const list = await getDoc<PlanPhaseWeek[]>(PHASES_DOC).catch(() => null);
  return Array.isArray(list) ? list : [];
}

export async function savePlanPhases(phases: PlanPhaseWeek[]): Promise<void> {
  await saveDoc(PHASES_DOC, phases);
}
