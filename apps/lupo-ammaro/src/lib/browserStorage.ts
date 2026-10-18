import type {
  AuthSession,
  CalendarEntry,
  ImportedActivity,
  PersonalRecords,
  UserProfile,
  Workout,
} from "../types";
import { emptyPersonalRecords } from "./sessionStats";

const AUTH_KEY = "wattlab.auth";
const PROFILE_KEY = "wattlab.profile";
const CALENDAR_KEY = "wattlab.calendar";
const WORKOUTS_KEY = "wattlab.workouts";
const RECORDS_KEY = "wattlab.records";
const DOC_PREFIX = "wattlab.doc.";

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  localStorage.setItem(key, JSON.stringify(value));
}

export async function browserGetAuth(): Promise<AuthSession | null> {
  return read<AuthSession | null>(AUTH_KEY, null);
}

export async function browserSaveAuth(session: AuthSession): Promise<void> {
  write(AUTH_KEY, session);
}

export async function browserClearAuth(): Promise<void> {
  localStorage.removeItem(AUTH_KEY);
}

export async function browserGetProfile(): Promise<UserProfile> {
  return read<UserProfile>(PROFILE_KEY, {
    name: "",
    heightCm: 175,
    weightKg: 70,
    ftpWatts: 200,
  });
}

export async function browserSaveProfile(profile: UserProfile): Promise<void> {
  write(PROFILE_KEY, profile);
}

export async function browserListCalendar(): Promise<CalendarEntry[]> {
  return read<CalendarEntry[]>(CALENDAR_KEY, []);
}

export async function browserSaveCalendar(entries: CalendarEntry[]): Promise<void> {
  write(CALENDAR_KEY, entries);
}

export async function browserListWorkouts(): Promise<Workout[]> {
  return read<Workout[]>(WORKOUTS_KEY, []);
}

export async function browserSaveWorkouts(workouts: Workout[]): Promise<void> {
  write(WORKOUTS_KEY, workouts);
}

export async function browserGetPersonalRecords(): Promise<PersonalRecords> {
  return read(PERSONS_KEY(), emptyPersonalRecords());
}

function PERSONS_KEY() {
  return RECORDS_KEY;
}

export async function browserSavePersonalRecords(records: PersonalRecords): Promise<void> {
  write(RECORDS_KEY, records);
}

export async function browserGetDoc<T>(name: string): Promise<T | null> {
  return read<T | null>(`${DOC_PREFIX}${name}`, null);
}

export async function browserSaveDoc<T>(name: string, value: T): Promise<void> {
  write(`${DOC_PREFIX}${name}`, value);
}

export function browserExportSyncSlice(): {
  calendar: CalendarEntry[];
  workouts: Workout[];
  checkins: unknown[];
  athleteSettings: unknown | null;
  chat: unknown[];
  lifeBlocks: unknown[];
  profile: UserProfile;
} {
  return {
    calendar: read(CALENDAR_KEY, []),
    workouts: read(WORKOUTS_KEY, []),
    checkins: read(`${DOC_PREFIX}checkins`, []),
    athleteSettings: read(`${DOC_PREFIX}athlete_settings`, null),
    chat: read(`${DOC_PREFIX}coach_chat`, []),
    lifeBlocks: read(`${DOC_PREFIX}life_blocks`, []),
    profile: read(PROFILE_KEY, {
      name: "",
      heightCm: 175,
      weightKg: 70,
      ftpWatts: 200,
    }),
  };
}

export async function browserImportSyncSlice(bundle: {
  calendar?: CalendarEntry[];
  workouts?: Workout[];
  checkins?: unknown[];
  athleteSettings?: unknown | null;
  chat?: unknown[];
  lifeBlocks?: unknown[];
  profile?: UserProfile | null;
}): Promise<void> {
  if (bundle.calendar) write(CALENDAR_KEY, bundle.calendar);
  if (bundle.workouts) write(WORKOUTS_KEY, bundle.workouts);
  if (bundle.checkins) write(`${DOC_PREFIX}checkins`, bundle.checkins);
  if (bundle.athleteSettings) write(`${DOC_PREFIX}athlete_settings`, bundle.athleteSettings);
  if (bundle.chat) write(`${DOC_PREFIX}coach_chat`, bundle.chat);
  if (bundle.lifeBlocks) write(`${DOC_PREFIX}life_blocks`, bundle.lifeBlocks);
  if (bundle.profile) write(PROFILE_KEY, bundle.profile);
}

export async function browserImportActivityFile(): Promise<ImportedActivity | null> {
  return null;
}

export async function browserImportActivityFromPath(_path: string): Promise<ImportedActivity> {
  throw new Error("Import file non disponibile nel browser.");
}
