export type FitDiscipline = "road" | "gravel" | "mtb" | "tt" | "indoor";
export type FitLevel = "beginner" | "recreational" | "competitive";
export type FitGoal = "comfort" | "performance" | "aero";

export type PainSite =
  | "knee_anterior"
  | "knee_posterior"
  | "knee_lateral"
  | "low_back"
  | "neck_shoulders"
  | "hands_wrists"
  | "feet"
  | "saddle_area"
  | "other";

export interface FitPainEntry {
  id: string;
  site: PainSite;
  side?: "left" | "right" | "both";
  intensity: number;
  onsetKm?: number;
  notes?: string;
}

export interface FitBikeSetup {
  brand?: string;
  size?: string;
  saddleHeightMm?: number;
  saddleSetbackMm?: number;
  stemLengthMm?: number;
  handlebarDropMm?: number;
  handlebarWidthMm?: number;
  crankLengthMm?: number;
  cleatNotes?: string;
}

export interface FitAnthropometry {
  inseamMm?: number;
  femurMm?: number;
  tibiaMm?: number;
  torsoMm?: number;
  armMm?: number;
  shoeSizeEu?: number;
}

export interface FitProfile {
  updatedAt: string;
  discipline: FitDiscipline;
  weeklyHours?: number;
  level: FitLevel;
  goal: FitGoal;
  anthropometry: FitAnthropometry;
  bike: FitBikeSetup;
  pains: FitPainEntry[];
  redFlags: FitRedFlagAnswers;
  healthConsent: boolean;
  consentAt?: string;
}

export interface FitRedFlagAnswers {
  acuteOrWorseningPain: boolean;
  persistentNumbness: boolean;
  swelling: boolean;
  nightPain: boolean;
  recentSurgery: boolean;
}

export type FitVideoView = "lateral_left" | "lateral_right" | "posterior";

export interface FitJointMetrics {
  kneeFlexionBdcDeg: number;
  kneeFlexionUncertaintyDeg: number;
  hipFlexionBdcDeg?: number;
  trunkAngleDeg?: number;
  kneeRangeDeg?: number;
  cyclesUsed: number;
  side: "left" | "right";
}

export interface FitQcResult {
  ok: boolean;
  issues: string[];
  framesAnalyzed: number;
  meanVisibility: number;
}

export interface FitSaddleRecommendation {
  status: "ok" | "high" | "low";
  measuredFlexionDeg: number;
  targetMinDeg: number;
  targetMaxDeg: number;
  adjustmentMmMin: number;
  adjustmentMmMax: number;
  direction: "raise" | "lower" | "none";
  summary: string;
  blockedByRedFlags: boolean;
}

export interface FitSession {
  id: string;
  createdAt: string;
  videoView: FitVideoView;
  videoLabel?: string;
  metrics: FitJointMetrics;
  qc: FitQcResult;
  saddle: FitSaddleRecommendation;
  confirmedSaddleHeightMm?: number;
  painIntensitySnapshot?: number;
  notes?: string;
}

export const FIT_DOC_PROFILE = "fit_profile";
export const FIT_DOC_SESSIONS = "fit_sessions";

export const KNEE_FLEXION_DYNAMIC_MIN = 33;
export const KNEE_FLEXION_DYNAMIC_MAX = 43;
export const MEASUREMENT_UNCERTAINTY_DEG = 4;
