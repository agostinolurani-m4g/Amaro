import { getDoc, saveDoc, newId } from "../hooks/useStorage";
import type { FitProfile, FitSession } from "./fit/types";
import { FIT_DOC_PROFILE, FIT_DOC_SESSIONS } from "./fit/types";

export function defaultFitProfile(): FitProfile {
  return {
    updatedAt: new Date().toISOString(),
    discipline: "road",
    level: "recreational",
    goal: "comfort",
    anthropometry: {},
    bike: {},
    pains: [],
    redFlags: {
      acuteOrWorseningPain: false,
      persistentNumbness: false,
      swelling: false,
      nightPain: false,
      recentSurgery: false,
    },
    healthConsent: false,
  };
}

export async function loadFitProfile(): Promise<FitProfile> {
  const stored = await getDoc<FitProfile>(FIT_DOC_PROFILE);
  return stored ?? defaultFitProfile();
}

export async function saveFitProfile(profile: FitProfile): Promise<void> {
  const next = { ...profile, updatedAt: new Date().toISOString() };
  await saveDoc(FIT_DOC_PROFILE, next);
}

export async function loadFitSessions(): Promise<FitSession[]> {
  const stored = await getDoc<FitSession[]>(FIT_DOC_SESSIONS);
  return stored ?? [];
}

export async function saveFitSession(session: FitSession): Promise<FitSession> {
  const sessions = await loadFitSessions();
  const saved = session.id ? session : { ...session, id: newId() };
  const idx = sessions.findIndex((s) => s.id === saved.id);
  if (idx >= 0) sessions[idx] = saved;
  else sessions.unshift(saved);
  await saveDoc(FIT_DOC_SESSIONS, sessions);
  return saved;
}

export async function updateFitSession(
  id: string,
  patch: Partial<FitSession>,
): Promise<FitSession | null> {
  const sessions = await loadFitSessions();
  const idx = sessions.findIndex((s) => s.id === id);
  if (idx < 0) return null;
  const next = { ...sessions[idx], ...patch };
  sessions[idx] = next;
  await saveDoc(FIT_DOC_SESSIONS, sessions);
  return next;
}
