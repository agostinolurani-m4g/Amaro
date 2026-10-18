import type { Workout } from "../types";

/**
 * Maps road gradient (%) to ERG target (% FTP).
 * Rule of thumb: ~6% ≈ threshold, 9% ≈ 95–100%, 12% ≈ VO2.
 */
export function gradeToPctFtp(gradePercent: number): number {
  const raw = 58 + 4.2 * gradePercent;
  return Math.round(Math.min(130, Math.max(55, raw)));
}

export interface ClimbSegment {
  label: string;
  durationSecs: number;
  gradePercent: number;
}

export function segmentsToPctTargets(
  segments: ClimbSegment[],
): { label: string; durationSecs: number; targetPctFtp: number }[] {
  return segments.map((seg) => ({
    label: seg.label,
    durationSecs: seg.durationSecs,
    targetPctFtp: gradeToPctFtp(seg.gradePercent),
  }));
}

export function rampSegment(
  label: string,
  durationSecs: number,
  startGrade: number,
  endGrade: number,
): { type: "ramp"; durationSecs: number; targetPctFtp: number; targetEndPctFtp: number; label: string } {
  return {
    type: "ramp",
    durationSecs,
    targetPctFtp: gradeToPctFtp(startGrade),
    targetEndPctFtp: gradeToPctFtp(endGrade),
    label,
  };
}

export function stepFromGrade(
  label: string,
  durationSecs: number,
  gradePercent: number,
  kind: "steady" | "interval" = "steady",
): {
  kind: "steady" | "interval";
  durationSecs: number;
  targetPctFtp: number;
  label: string;
} {
  return {
    kind,
    durationSecs,
    targetPctFtp: gradeToPctFtp(gradePercent),
    label,
  };
}

export function climbWarmup(durationSecs = 600): {
  kind: "warmup";
  durationSecs: number;
  targetPctFtp: number;
  label: string;
} {
  return { kind: "warmup", durationSecs, targetPctFtp: 55, label: "Riscaldamento" };
}

export function pctFtpToGrade(pctFtp: number): number {
  return Math.round(((pctFtp - 58) / 4.2) * 10) / 10;
}

export function isSimWorkout(workout: Workout): boolean {
  return workout.executionMode === "sim";
}

export function isClimbWorkout(workout: Workout): boolean {
  return (
    workout.executionMode === "climb" ||
    Boolean(workout.climbProfileId) ||
    workout.category === "climb"
  );
}

export function climbCooldown(durationSecs = 480): {
  kind: "cooldown";
  durationSecs: number;
  targetPctFtp: number;
  label: string;
} {
  return { kind: "cooldown", durationSecs, targetPctFtp: 45, label: "Defaticamento" };
}
