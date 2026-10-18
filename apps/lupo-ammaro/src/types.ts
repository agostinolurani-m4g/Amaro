export type Screen =
  | "connect"
  | "live"
  | "summary"
  | "profile"
  | "workouts"
  | "calendar"
  | "today"
  | "leaderboard"
  | "coach"
  | "history"
  | "lab"
  | "fit";

export type {
  FitProfile,
  FitSession,
  FitPainEntry,
  FitDiscipline,
  FitGoal,
  FitLevel,
  PainSite,
  FitVideoView,
} from "./lib/fit/types";

export interface ScanResult {
  id: string;
  name: string;
  hasFtms: boolean;
}

export interface ConnectionState {
  status: "disconnected" | "scanning" | "connecting" | "connected";
  deviceId?: string;
  deviceName?: string;
  error?: string;
}

export interface Telemetry {
  timestampMs: number;
  power?: number;
  cadence?: number;
  speedKmh?: number;
  heartRate?: number;
  targetPower?: number;
  resistance?: number;
}

export interface SessionSummary {
  startedAt?: string;
  endedAt?: string;
  durationSecs: number;
  avgPower?: number;
  maxPower?: number;
  sampleCount: number;
}

export interface SessionSample {
  timestampMs: number;
  power?: number;
  cadence?: number;
  speedKmh?: number;
  heartRate?: number;
  targetPower?: number;
}

export interface PowerWindowBest {
  windowSecs: number;
  label: string;
  watts: number;
}

export interface SessionStats {
  durationSecs: number;
  movingSecs: number;
  avgPower?: number;
  maxPower?: number;
  distanceM: number;
  workKj: number;
  avgHeartRate?: number;
  maxHeartRate?: number;
  bests: PowerWindowBest[];
}

export interface PersonalBest {
  watts: number;
  at: string;
}

export interface PersonalRecords {
  bests: Record<string, PersonalBest>;
  maxDurationSecs: number;
  maxDistanceM: number;
  maxWorkKj: number;
  maxPower?: number;
}

export type PersonalRecordKind =
  | "power"
  | "duration"
  | "distance"
  | "work"
  | "maxPower";

export interface PersonalRecordHit {
  kind: PersonalRecordKind;
  label: string;
  value: string;
  previous?: string;
}

export interface LeaderboardEntry {
  memberId: number;
  firstName: string;
  lastName: string;
  sessions: number;
  durationSecs: number;
  distanceM: number;
  workKj: number;
  maxPower?: number;
  best20min?: number;
}

export type LeaderboardPeriod = "week" | "month" | "all";

export interface LeaderboardResponse {
  period: LeaderboardPeriod;
  entries: LeaderboardEntry[];
}

export interface CoachActivity {
  id: string;
  date: string;
  title: string;
  entryType: CalendarEntry["entryType"];
  durationSecs?: number;
  avgPower?: number;
  maxPower?: number;
  hasSeries?: boolean;
  np?: number;
  tss?: number;
  ifactor?: number;
  kj?: number;
  avgHr?: number;
  maxHr?: number;
  decoupling?: number;
  mmp?: number[];
  zoneSecs?: number[];
  rpe?: number;
  feel?: string;
  plannedTss?: number;
  compliance?: number;
  sessionType?: string;
  sport?: string;
  workoutId?: string;
  notes?: string;
  coachComment?: string;
}

export interface CoachWorkoutSummary {
  id: string;
  name: string;
  durationSecs: number;
  category?: WorkoutCategory;
}

export type Weekday = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";

export type LifeSlot = "morning" | "afternoon" | "evening" | "all";

export type LifeBlockKind = "busy" | "window";

export interface LifeBlock {
  id: string;
  label: string;
  /** Impegno puntuale */
  date?: string;
  /** Impegno ricorrente */
  weekday?: Weekday;
  slot: LifeSlot;
  kind: LifeBlockKind;
  source?: "chat" | "manual" | "day_comment";
  createdAt: string;
  updatedAt: string;
}

export type SessionType =
  | "recovery"
  | "z2"
  | "tempo"
  | "sst"
  | "threshold"
  | "overunder"
  | "vo2"
  | "vo2_30_30"
  | "anaerobic"
  | "lowcadence"
  | "durability"
  | "ftp_test"
  | "openers";

export type Experience = "principiante" | "intermedio" | "avanzato" | "elite";

export interface AthleteEvent {
  id: string;
  name: string;
  date: string;
  type: "granfondo" | "crono" | "salita" | "criterium" | "gara" | "altro";
  priority: "A" | "B" | "C";
  durationH?: number;
}

export interface AthletePlanSettings {
  goal: string;
  focus?: TrainingFocus;
  events: AthleteEvent[];
  /** minuti disponibili per giorno (0 = riposo) */
  availability: Record<Weekday, number>;
  outdoorDays: Weekday[];
  maxHoursWeek: number;
  experience: Experience;
  preferredLongDay?: Weekday;
  likes: SessionType[];
  avoid: SessionType[];
  injuries?: string;
  constraints: string[];
  recoveryWeekEvery?: 3 | 4;
  onboarded: boolean;
  updatedAt?: string;
}

export interface DailyCheckin {
  date: string;
  /** 1 pessimo … 5 ottimo */
  sleep: number;
  /** 1 fresco … 5 distrutto */
  fatigue: number;
  /** 1 nulla … 5 forte */
  soreness: number;
  /** 1 nullo … 5 alto */
  stress: number;
  motivation: number;
  restingHr?: number;
  note?: string;
}

export interface PlanPhaseWeek {
  weekStart: string;
  phase: "base" | "build" | "peak" | "taper" | "recovery" | "race";
  label: string;
  targetTss: number;
  plannedTss: number;
  recovery: boolean;
  focusNote: string;
}

export interface WorkoutPrediction {
  durationSecs: number;
  np: number;
  ifactor: number;
  tss: number;
  kj: number;
  choG: number;
  zoneSecs: number[];
  wbalMinPct: number;
  feasibility: "ok" | "duro" | "non_fattibile";
  steps: { label: string; watts: number; secs: number; lactate: number | null }[];
}

export interface CoachContext {
  profile: UserProfile;
  goal?: string;
  activities: CoachActivity[];
  planned: CoachActivity[];
  workouts: CoachWorkoutSummary[];
  records: PersonalRecords;
  /** Ultime sessioni con serie potenza (id → punti downsample) */
  sessionSeries?: Record<string, SessionSeriesPoint[]>;
  settings?: AthletePlanSettings;
  checkins?: DailyCheckin[];
  lifeBlocks?: LifeBlock[];
  today?: string;
}

export interface CoachPlanSession {
  date: string;
  name: string;
  durationMin: number;
  description?: string;
  workoutName?: string;
  plannedTss?: number;
  sessionType?: SessionType;
  phase?: PlanPhaseWeek["phase"];
  outdoor?: boolean;
  /** Data originale per sessioni spostate (patch). */
  fromDate?: string;
  workoutId?: string;
}

export type CoachWorkoutDraftBlock =
  | {
      type: "step";
      kind: WorkoutStepKind;
      durationSecs: number;
      targetPctFtp: number;
      label?: string;
    }
  | {
      type: "ramp";
      durationSecs: number;
      targetPctFtp: number;
      targetEndPctFtp: number;
      label?: string;
    }
  | {
      type: "repeat";
      count: number;
      steps: {
        kind: WorkoutStepKind;
        durationSecs: number;
        targetPctFtp: number;
        label?: string;
      }[];
    };

/** @deprecated flat blocks without type — migrated on load */
export type CoachWorkoutDraftLegacyBlock = {
  kind: WorkoutStepKind;
  durationSecs: number;
  targetPctFtp: number;
  label?: string;
};

export interface CoachWorkoutDraft {
  name: string;
  description?: string;
  blocks: (CoachWorkoutDraftBlock | CoachWorkoutDraftLegacyBlock)[];
  sessionType?: SessionType;
  prediction?: WorkoutPrediction;
}

export type CoachProposalKind = "move" | "lighten" | "insert";

export interface CoachProposal {
  id: string;
  kind: CoachProposalKind;
  title: string;
  reason: string;
  planPatch: CoachPlanSession[];
  workouts?: CoachWorkoutDraft[];
  createdAt: string;
}

export type CoachChartKind =
  | "pmc"
  | "weekly_tss"
  | "power_curve"
  | "session"
  | "lactate"
  | "trend";

export interface CoachChartSeries {
  label: string;
  data: (number | null)[];
  color?: string;
}

export interface CoachChartData {
  kind: CoachChartKind;
  title: string;
  x: (string | number)[];
  series: CoachChartSeries[];
  yLabel?: string;
  sessionSeries?: SessionSeriesPoint[];
}

export interface CoachWebSource {
  title: string;
  url: string;
  snippet: string;
}

export type CoachArtifact =
  | { type: "workout"; draft: CoachWorkoutDraft }
  | { type: "plan"; sessions: CoachPlanSession[]; weeks?: number }
  | { type: "chart"; chart: CoachChartData }
  | { type: "sources"; results: CoachWebSource[]; query: string };

export type TrainingFocus =
  | "ftp"
  | "vo2"
  | "endurance"
  | "granfondo"
  | "climb"
  | "recovery"
  | "mixed";

export interface ZoneShare {
  id: string;
  label: string;
  range: string;
  seconds: number;
  percent: number;
  color: string;
}

export interface LoadSnapshot {
  ctl: number;
  atl: number;
  tsb: number;
  weekTss: number;
  prevWeekTss: number;
  status: "fresco" | "bilanciato" | "affaticato";
  summary: string;
  rampRate?: number;
  monotony?: number;
  strain?: number;
  acwr?: number;
}

export interface TrainingDoc {
  id: string;
  title: string;
  source: string;
  body: string;
}

export interface CoachAthleteProfile {
  strengths: string[];
  weaknesses: string[];
  consistency: string;
  preferredDays: string[];
  ftpTrend: string;
}

export interface CoachBriefing {
  generatedAt: string;
  goal: string;
  focus: TrainingFocus;
  load: LoadSnapshot;
  verdict: string;
  recommendations: string[];
  plan: CoachPlanSession[];
  workouts: CoachWorkoutDraft[];
  docs: TrainingDoc[];
  sources?: CoachWebSource[];
  sourcesQuery?: string;
  applied: boolean;
  athleteProfile?: CoachAthleteProfile;
  weekReview?: string;
  phases?: PlanPhaseWeek[];
  planSummary?: string;
}

export interface SessionEvaluation {
  at: string;
  title: string;
  intensityFactor: number;
  tss: number;
  verdict: "easy" | "on_target" | "hard" | "fatigue";
  summary: string;
  notes: string[];
  powerZones: ZoneShare[];
  hrZones: ZoneShare[];
  docs: TrainingDoc[];
}

export interface CoachChatResponse {
  reply: string;
  artifacts?: CoachArtifact[];
  planUpdate?: CoachPlanSession[];
  /** replace = riscrive le sessioni coach future; merge = modifica solo le date indicate */
  planMode?: "replace" | "merge";
  phases?: PlanPhaseWeek[];
  workouts?: CoachWorkoutDraft[];
  persistentConstraint?: string;
  lifeBlocks?: LifeBlock[];
  toolsUsed: string[];
}

export interface CoachHealth {
  provider: "ollama" | "openai";
  model: string;
  fallbackModel: string | null;
  activeModel: string;
  ok: boolean;
  models: string[];
  error: string | null;
}

export interface SessionSeriesPoint {
  t: number;
  power?: number;
  hr?: number;
  cadence?: number;
  target?: number;
}

export type ControlMode = "erg" | "resistance" | "sim";

export interface LactateTestPoint {
  watts: number;
  mmol: number;
  hr?: number;
  date?: string;
}

export interface UserProfile {
  name: string;
  heightCm: number;
  weightKg: number;
  ftpWatts: number;
  sex?: "m" | "f";
  birthYear?: number;
  hrMax?: number;
  hrRest?: number;
  lthr?: number;
  lthrRun?: number;
  lactateTests?: LactateTestPoint[];
}

export interface AmaroMember {
  id: number;
  email: string;
  firstName: string;
  lastName: string;
  membershipStatus: string;
}

export interface AuthSession {
  token: string;
  expiresAt: string;
  member: AmaroMember;
}

export type WorkoutStepKind =
  | "warmup"
  | "steady"
  | "interval"
  | "recovery"
  | "cooldown";

export type WorkoutCategory = "classic" | "climb" | "custom";

export type WorkoutExecutionMode = "erg" | "sim" | "climb";

export interface WorkoutStep {
  id: string;
  kind: WorkoutStepKind;
  durationSecs: number;
  targetPctFtp: number;
  label?: string;
  /** Pendenza simulata (%) — usata in modalità SIM */
  gradePercent?: number;
}

export interface WorkoutRepeat {
  id: string;
  count: number;
  steps: WorkoutStep[];
}

export interface WorkoutStepBlock {
  type: "step";
  id: string;
  kind: WorkoutStepKind;
  durationSecs: number;
  targetPctFtp: number;
  label?: string;
  gradePercent?: number;
}

export interface WorkoutRampBlock {
  type: "ramp";
  id: string;
  durationSecs: number;
  targetPctFtp: number;
  targetEndPctFtp: number;
  label?: string;
  gradePercent?: number;
  gradeEndPercent?: number;
}

export interface WorkoutRepeatBlock {
  type: "repeat";
  id: string;
  count: number;
  steps: WorkoutStep[];
}

export type WorkoutBlock =
  | WorkoutStepBlock
  | WorkoutRampBlock
  | WorkoutRepeatBlock;

export interface Workout {
  id: string;
  name: string;
  description?: string;
  blocks: WorkoutBlock[];
  /** @deprecated legacy storage — migrated to blocks on load */
  steps?: WorkoutStep[];
  /** @deprecated legacy storage — migrated to blocks on load */
  repeats?: WorkoutRepeat[];
  category?: WorkoutCategory;
  presetId?: string;
  /** erg = target watt; sim = pendenza sul rullo; climb = SIM sul profilo (come Zwift) */
  executionMode?: WorkoutExecutionMode;
  climbProfileId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CalendarEntry {
  id: string;
  date: string;
  entryType: "completed" | "planned" | "imported";
  title: string;
  workoutId?: string;
  durationSecs?: number;
  avgPower?: number;
  importPath?: string;
  importFormat?: string;
  notes?: string;
  coachComment?: string;
  series?: SessionSeriesPoint[];
  maxPower?: number;
  np?: number;
  tss?: number;
  ifactor?: number;
  kj?: number;
  avgHr?: number;
  maxHr?: number;
  avgCadence?: number;
  distanceM?: number;
  /** Pw:HR decoupling % (seconda metà vs prima) */
  decoupling?: number;
  /** Mean-max power allineata a MMP_WINDOWS */
  mmp?: number[];
  /** Secondi per zona Coggan Z1..Z7 */
  zoneSecs?: number[];
  rpe?: number;
  feel?: string;
  plannedTss?: number;
  plannedEntryId?: string;
  compliance?: number;
  sessionType?: string;
  coachPlan?: boolean;
  sport?: string;
  externalSource?: string;
  externalId?: string;
  elevationM?: number;
  updatedAt?: string;
}

export interface ImportedActivity {
  title: string;
  date: string;
  durationSecs: number;
  avgPower?: number;
  maxPower?: number;
  distanceM?: number;
  format: string;
  sourcePath: string;
  avgHr?: number;
  maxHr?: number;
  series?: SessionSeriesPoint[];
}

export interface TimelineStep {
  index: number;
  kind: WorkoutStepKind | "repeat" | "ramp";
  label: string;
  durationSecs: number;
  targetWatts: number;
  targetPctFtp: number;
  startOffsetSecs: number;
  gradePercent?: number;
}

export interface ProfilePoint {
  offsetSecs: number;
  targetPctFtp: number;
  targetWatts: number;
  label: string;
}

export const STEP_KIND_LABELS: Record<WorkoutStepKind, string> = {
  warmup: "Riscaldamento",
  steady: "Steady",
  interval: "Intervallo",
  recovery: "Recupero",
  cooldown: "Defaticamento",
};

export const STEP_KIND_DEFAULTS: Record<
  WorkoutStepKind,
  { durationSecs: number; targetPctFtp: number }
> = {
  warmup: { durationSecs: 600, targetPctFtp: 55 },
  steady: { durationSecs: 1200, targetPctFtp: 75 },
  interval: { durationSecs: 300, targetPctFtp: 110 },
  recovery: { durationSecs: 180, targetPctFtp: 50 },
  cooldown: { durationSecs: 600, targetPctFtp: 45 },
};
