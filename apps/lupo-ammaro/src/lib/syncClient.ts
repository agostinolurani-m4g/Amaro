import { amaroJson } from "./amaroAuth";
import { browserExportSyncSlice, browserImportSyncSlice } from "./browserStorage";
import { isTauri } from "./runtime";
import { mergeSyncBundles, type SyncBundle } from "./syncMerge";
import type { CalendarEntry, LifeBlock, UserProfile, Workout } from "../types";
import { invoke } from "@tauri-apps/api/core";

let pushTimer: ReturnType<typeof setTimeout> | null = null;
let syncInFlight: Promise<void> | null = null;

async function tauriExportSlice(): Promise<SyncBundle> {
  const [calendar, profile, workouts] = await Promise.all([
    invoke<CalendarEntry[]>("list_calendar").catch(() => []),
    invoke<UserProfile>("get_profile").catch(() => null),
    invoke<Workout[]>("list_workouts").catch(() => []),
  ]);
  const [checkins, athleteSettings, chat, lifeBlocks] = await Promise.all([
    invoke<unknown[] | null>("get_doc", { name: "checkins" }).catch(() => []),
    invoke<unknown | null>("get_doc", { name: "athlete_settings" }).catch(() => null),
    invoke<unknown[] | null>("get_doc", { name: "coach_chat" }).catch(() => []),
    invoke<LifeBlock[] | null>("get_doc", { name: "life_blocks" }).catch(() => []),
  ]);
  return {
    calendar,
    profile,
    workouts,
    checkins: checkins ?? [],
    athleteSettings: athleteSettings ?? null,
    chat: chat ?? [],
    lifeBlocks: lifeBlocks ?? [],
  };
}

async function tauriImportSlice(bundle: SyncBundle): Promise<void> {
  for (const entry of bundle.calendar ?? []) {
    await invoke("save_calendar_entry", { entry }).catch(() => undefined);
  }
  if (bundle.profile) await invoke("save_profile_cmd", { profile: bundle.profile }).catch(() => undefined);
  for (const w of bundle.workouts ?? []) {
    await invoke("save_workout", { workout: w }).catch(() => undefined);
  }
  if (bundle.checkins) await invoke("save_doc_cmd", { name: "checkins", value: bundle.checkins });
  if (bundle.athleteSettings) {
    await invoke("save_doc_cmd", { name: "athlete_settings", value: bundle.athleteSettings });
  }
  if (bundle.chat) await invoke("save_doc_cmd", { name: "coach_chat", value: bundle.chat });
  if (bundle.lifeBlocks) await invoke("save_doc_cmd", { name: "life_blocks", value: bundle.lifeBlocks });
}

async function localSlice(): Promise<SyncBundle> {
  if (isTauri()) return tauriExportSlice();
  const slice = browserExportSyncSlice();
  return {
    calendar: slice.calendar,
    workouts: slice.workouts,
    checkins: slice.checkins ?? [],
    athleteSettings: slice.athleteSettings,
    chat: slice.chat ?? [],
    lifeBlocks: (slice.lifeBlocks ?? []) as LifeBlock[],
    profile: slice.profile,
  };
}

async function applySlice(bundle: SyncBundle): Promise<void> {
  if (isTauri()) {
    await tauriImportSlice(bundle);
    return;
  }
  await browserImportSyncSlice({
    calendar: bundle.calendar,
    workouts: bundle.workouts,
    checkins: bundle.checkins,
    athleteSettings: bundle.athleteSettings,
    chat: bundle.chat,
    lifeBlocks: bundle.lifeBlocks,
    profile: (bundle.profile as UserProfile | null | undefined) ?? undefined,
  });
}

export async function pullMemberSync(): Promise<void> {
  if (syncInFlight) return syncInFlight;
  syncInFlight = (async () => {
    const remote = await amaroJson<SyncBundle>("/api/wattlab/sync");
    const local = await localSlice();
    const merged = mergeSyncBundles(local, remote);
    await applySlice(merged);
  })().finally(() => {
    syncInFlight = null;
  });
  return syncInFlight;
}

export function schedulePushMemberSync(): void {
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    pushTimer = null;
    void pushMemberSync().catch(() => undefined);
  }, 1200);
}

export async function pushMemberSync(): Promise<void> {
  const local = await localSlice();
  const merged = await amaroJson<SyncBundle>("/api/wattlab/sync", {
    method: "PUT",
    body: JSON.stringify(local),
  });
  const again = mergeSyncBundles(local, merged);
  await applySlice(again);
}

export function touchCalendarEntry(entry: CalendarEntry): CalendarEntry {
  return { ...entry, updatedAt: new Date().toISOString() };
}

export function touchLifeBlock(block: LifeBlock): LifeBlock {
  const now = new Date().toISOString();
  return { ...block, updatedAt: now, createdAt: block.createdAt ?? now };
}
