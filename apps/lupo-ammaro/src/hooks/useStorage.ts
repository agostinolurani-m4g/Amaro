import { invoke } from "@tauri-apps/api/core";
import type {
  AuthSession,
  CalendarEntry,
  ImportedActivity,
  PersonalRecords,
  UserProfile,
  Workout,
} from "../types";
import { normalizeWorkout } from "../lib/workoutEngine";
import { PRESET_WORKOUTS } from "../lib/presetWorkouts";
import { fixWorkoutText } from "../lib/textFix";
import { isTauri } from "../lib/runtime";
import * as browser from "../lib/browserStorage";
import { schedulePushMemberSync, touchCalendarEntry } from "../lib/syncClient";

export async function getAuth(): Promise<AuthSession | null> {
  if (!isTauri()) return browser.browserGetAuth();
  return invoke("get_auth");
}

export async function saveAuth(session: AuthSession): Promise<void> {
  if (!isTauri()) return browser.browserSaveAuth(session);
  return invoke("save_auth_cmd", { session });
}

export async function clearAuth(): Promise<void> {
  if (!isTauri()) return browser.browserClearAuth();
  return invoke("clear_auth_cmd");
}

export async function getProfile(): Promise<UserProfile> {
  if (!isTauri()) return browser.browserGetProfile();
  return invoke("get_profile");
}

export async function saveProfile(profile: UserProfile): Promise<void> {
  if (!isTauri()) {
    await browser.browserSaveProfile(profile);
    schedulePushMemberSync();
    return;
  }
  await invoke("save_profile_cmd", { profile });
  schedulePushMemberSync();
}

export async function listWorkouts(): Promise<Workout[]> {
  if (!isTauri()) return browser.browserListWorkouts();
  const workouts = await invoke<Workout[]>("list_workouts");
  const out: Workout[] = [];
  for (const raw of workouts) {
    const w = normalizeWorkout(raw);
    const fixed = fixWorkoutText(w);
    if (fixed.name !== w.name || fixed.description !== w.description) {
      const saved = await invoke<Workout>("save_workout", { workout: { ...w, ...fixed } });
      out.push(normalizeWorkout(saved));
    } else {
      out.push(w);
    }
  }
  return out;
}

export async function ensurePresetWorkouts(): Promise<Workout[]> {
  if (!isTauri()) return listWorkouts();
  const catalogIds = new Set(
    PRESET_WORKOUTS.map((p) => p.presetId).filter((id): id is string => Boolean(id)),
  );
  let workouts = await listWorkouts();

  for (const preset of PRESET_WORKOUTS) {
    if (!preset.presetId) continue;
    const matches = workouts.filter((w) => w.presetId === preset.presetId);
    const keep = matches[0];
    if (!keep) {
      await saveWorkout({ ...preset, id: "" });
      workouts = await listWorkouts();
      continue;
    }
    await saveWorkout({
      ...keep,
      name: preset.name,
      description: preset.description,
      category: preset.category,
      executionMode: preset.executionMode,
      climbProfileId: preset.climbProfileId,
      blocks: preset.blocks,
    });
    for (const extra of matches.slice(1)) {
      await deleteWorkout(extra.id);
    }
    workouts = await listWorkouts();
  }

  const keptClimb = new Set<string>();
  const keptName = new Set<string>();
  for (const w of workouts) {
    if (w.presetId && !catalogIds.has(w.presetId)) {
      await deleteWorkout(w.id);
      continue;
    }
    if (w.presetId && w.category === "climb") {
      const climbKey = w.climbProfileId || w.name;
      if (keptClimb.has(climbKey) || keptName.has(w.name)) {
        await deleteWorkout(w.id);
        continue;
      }
      keptClimb.add(climbKey);
      keptName.add(w.name);
    }
  }

  return listWorkouts();
}

export async function saveWorkout(workout: Workout): Promise<Workout> {
  if (!isTauri()) {
    const list = await browser.browserListWorkouts();
    const now = new Date().toISOString();
    const saved = {
      ...workout,
      id: workout.id || crypto.randomUUID(),
      createdAt: workout.createdAt || now,
      updatedAt: now,
    };
    const idx = list.findIndex((w) => w.id === saved.id);
    const next = [...list];
    if (idx >= 0) next[idx] = saved;
    else next.push(saved);
    await browser.browserSaveWorkouts(next);
    schedulePushMemberSync();
    return saved;
  }
  const saved = await invoke<Workout>("save_workout", { workout });
  schedulePushMemberSync();
  return saved;
}

export async function deleteWorkout(id: string): Promise<void> {
  if (!isTauri()) {
    const next = (await browser.browserListWorkouts()).filter((w) => w.id !== id);
    await browser.browserSaveWorkouts(next);
    schedulePushMemberSync();
    return;
  }
  await invoke("delete_workout", { id });
  schedulePushMemberSync();
}

export async function getPersonalRecords(): Promise<PersonalRecords> {
  if (!isTauri()) return browser.browserGetPersonalRecords();
  return invoke("get_personal_records");
}

export async function savePersonalRecords(records: PersonalRecords): Promise<void> {
  if (!isTauri()) {
    await browser.browserSavePersonalRecords(records);
    return;
  }
  return invoke("save_personal_records_cmd", { records });
}

export async function listCalendar(): Promise<CalendarEntry[]> {
  if (!isTauri()) return browser.browserListCalendar();
  return invoke("list_calendar");
}

export async function saveCalendarEntry(entry: CalendarEntry): Promise<CalendarEntry> {
  const touched = touchCalendarEntry(entry);
  if (!isTauri()) {
    const list = await browser.browserListCalendar();
    const saved = { ...touched, id: touched.id || crypto.randomUUID() };
    const idx = list.findIndex((e) => e.id === saved.id);
    const next = [...list];
    if (idx >= 0) next[idx] = saved;
    else next.push(saved);
    await browser.browserSaveCalendar(next);
    schedulePushMemberSync();
    return saved;
  }
  const saved = await invoke<CalendarEntry>("save_calendar_entry", { entry: touched });
  schedulePushMemberSync();
  return saved;
}

export async function deleteCalendarEntry(id: string): Promise<void> {
  if (!isTauri()) {
    const next = (await browser.browserListCalendar()).filter((e) => e.id !== id);
    await browser.browserSaveCalendar(next);
    schedulePushMemberSync();
    return;
  }
  await invoke("delete_calendar_entry", { id });
  schedulePushMemberSync();
}

export async function getDoc<T>(name: string): Promise<T | null> {
  if (!isTauri()) return browser.browserGetDoc<T>(name);
  return invoke<T | null>("get_doc", { name });
}

export async function saveDoc<T>(name: string, value: T): Promise<void> {
  if (!isTauri()) {
    await browser.browserSaveDoc(name, value);
    schedulePushMemberSync();
    return;
  }
  await invoke("save_doc_cmd", { name, value });
  schedulePushMemberSync();
}

export async function importActivityFile(): Promise<ImportedActivity | null> {
  if (!isTauri()) return browser.browserImportActivityFile();
  return invoke("import_activity_file");
}

export async function importActivityFromPath(path: string): Promise<ImportedActivity> {
  if (!isTauri()) return browser.browserImportActivityFromPath(path);
  return invoke("import_activity_from_path", { path });
}

export function newId(): string {
  return crypto.randomUUID();
}

export function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
