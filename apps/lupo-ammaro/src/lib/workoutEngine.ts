import { climbDurationSecs, getClimbProfile } from "./climbProfiles";
import type {
  ProfilePoint,
  TimelineStep,
  Workout,
  WorkoutBlock,
  WorkoutRampBlock,
  WorkoutRepeat,
  WorkoutRepeatBlock,
  WorkoutStep,
  WorkoutStepBlock,
  WorkoutStepKind,
  SessionSample,
  SessionSeriesPoint,
} from "../types";
import { STEP_KIND_LABELS } from "../types";

const RAMP_STEP_SECS = 10;

function stepLabel(step: WorkoutStep): string {
  return step.label ?? STEP_KIND_LABELS[step.kind];
}

function appendStep(
  step: WorkoutStep,
  ftp: number,
  timeline: TimelineStep[],
  offset: number,
  labelOverride?: string,
): number {
  timeline.push({
    index: timeline.length,
    kind: step.kind,
    label: labelOverride ?? stepLabel(step),
    durationSecs: step.durationSecs,
    targetWatts: Math.round((ftp * step.targetPctFtp) / 100),
    targetPctFtp: step.targetPctFtp,
    startOffsetSecs: offset,
    gradePercent: step.gradePercent,
  });
  return offset + step.durationSecs;
}

function appendRamp(
  block: WorkoutRampBlock,
  ftp: number,
  timeline: TimelineStep[],
  offset: number,
): number {
  const duration = block.durationSecs;
  const steps = Math.max(1, Math.ceil(duration / RAMP_STEP_SECS));
  let cursor = offset;

  for (let i = 0; i < steps; i += 1) {
    const stepDuration =
      i === steps - 1
        ? duration - i * RAMP_STEP_SECS
        : Math.min(RAMP_STEP_SECS, duration - i * RAMP_STEP_SECS);
    const progress = (i + 0.5) / steps;
    const pct =
      block.targetPctFtp +
      (block.targetEndPctFtp - block.targetPctFtp) * progress;
    const grade =
      block.gradePercent != null && block.gradeEndPercent != null
        ? block.gradePercent +
          (block.gradeEndPercent - block.gradePercent) * progress
        : undefined;
    timeline.push({
      index: timeline.length,
      kind: "ramp",
      label: block.label ?? "Rampa",
      durationSecs: stepDuration,
      targetWatts: Math.round((ftp * pct) / 100),
      targetPctFtp: Math.round(pct),
      startOffsetSecs: cursor,
      gradePercent: grade != null ? Math.round(grade * 10) / 10 : undefined,
    });
    cursor += stepDuration;
  }

  return cursor;
}

function appendRepeat(
  repeat: WorkoutRepeat,
  ftp: number,
  timeline: TimelineStep[],
  offset: number,
): number {
  let cursor = offset;
  for (let n = 0; n < repeat.count; n += 1) {
    repeat.steps.forEach((step) => {
      cursor = appendStep(
        step,
        ftp,
        timeline,
        cursor,
        `${stepLabel(step)} (${n + 1}/${repeat.count})`,
      );
    });
  }
  return cursor;
}

function appendBlock(
  block: WorkoutBlock,
  ftp: number,
  timeline: TimelineStep[],
  offset: number,
): number {
  switch (block.type) {
    case "step":
      return appendStep(block, ftp, timeline, offset);
    case "ramp":
      return appendRamp(block, ftp, timeline, offset);
    case "repeat":
      return appendRepeat(block, ftp, timeline, offset);
    default:
      return offset;
  }
}

/** Migrate legacy steps/repeats into ordered blocks. */
export function normalizeWorkout(workout: Workout): Workout {
  let normalized: Workout;
  if (workout.blocks && workout.blocks.length > 0) {
    normalized = workout;
  } else {
    const blocks: WorkoutBlock[] = [
      ...(workout.steps ?? []).map(
        (step): WorkoutStepBlock => ({ type: "step", ...step }),
      ),
      ...(workout.repeats ?? []).map(
        (repeat): WorkoutRepeatBlock => ({ type: "repeat", ...repeat }),
      ),
    ];
    normalized = { ...workout, blocks };
  }

  if (normalized.category === "climb" && !normalized.executionMode) {
    normalized = { ...normalized, executionMode: "climb" };
  }

  return normalized;
}

export function flattenWorkout(workout: Workout, ftp: number): TimelineStep[] {
  const normalized = normalizeWorkout(workout);
  const timeline: TimelineStep[] = [];
  let offset = 0;

  normalized.blocks.forEach((block) => {
    offset = appendBlock(block, ftp, timeline, offset);
  });

  return timeline;
}

export function workoutProfile(
  workout: Workout,
  ftp: number,
): ProfilePoint[] {
  const timeline = flattenWorkout(workout, ftp);
  const points: ProfilePoint[] = [{ offsetSecs: 0, targetPctFtp: 0, targetWatts: 0, label: "" }];

  timeline.forEach((step) => {
    points.push({
      offsetSecs: step.startOffsetSecs,
      targetPctFtp: step.targetPctFtp,
      targetWatts: step.targetWatts,
      label: step.label,
    });
    points.push({
      offsetSecs: step.startOffsetSecs + step.durationSecs,
      targetPctFtp: step.targetPctFtp,
      targetWatts: step.targetWatts,
      label: step.label,
    });
  });

  return points;
}

export function workoutTotalDuration(workout: Workout): number {
  const normalized = normalizeWorkout(workout);
  const profile = getClimbProfile(normalized.climbProfileId);
  if (profile) {
    const extras = normalized.blocks
      .filter((b) => b.type === "step" && (b.kind === "warmup" || b.kind === "cooldown"))
      .reduce((s, b) => s + (b.type === "step" ? b.durationSecs : 0), 0);
    return climbDurationSecs(profile) + extras;
  }
  return normalized.blocks.reduce((total, block) => {
    switch (block.type) {
      case "step":
      case "ramp":
        return total + block.durationSecs;
      case "repeat":
        return (
          total +
          block.count *
            block.steps.reduce((s, step) => s + step.durationSecs, 0)
        );
      default:
        return total;
    }
  }, 0);
}

export function getTimelineStepAt(
  timeline: TimelineStep[],
  elapsedSecs: number,
): { current: TimelineStep | null; next: TimelineStep | null; progress: number } {
  if (timeline.length === 0) {
    return { current: null, next: null, progress: 0 };
  }

  const total = timeline.reduce((s, t) => s + t.durationSecs, 0);
  if (elapsedSecs >= total) {
    const last = timeline[timeline.length - 1];
    return { current: last, next: null, progress: 1 };
  }

  for (let i = 0; i < timeline.length; i += 1) {
    const step = timeline[i];
    const end = step.startOffsetSecs + step.durationSecs;
    if (elapsedSecs < end) {
      const inStep = elapsedSecs - step.startOffsetSecs;
      return {
        current: step,
        next: timeline[i + 1] ?? null,
        progress: step.durationSecs > 0 ? inStep / step.durationSecs : 0,
      };
    }
  }

  return { current: timeline[timeline.length - 1], next: null, progress: 1 };
}

export function createStep(kind: WorkoutStepKind, id: string): WorkoutStep {
  const defaults = {
    warmup: { durationSecs: 600, targetPctFtp: 55 },
    steady: { durationSecs: 1200, targetPctFtp: 75 },
    interval: { durationSecs: 300, targetPctFtp: 110 },
    recovery: { durationSecs: 180, targetPctFtp: 50 },
    cooldown: { durationSecs: 600, targetPctFtp: 45 },
  }[kind];

  return { id, kind, ...defaults };
}

export function createStepBlock(kind: WorkoutStepKind, id: string): WorkoutStepBlock {
  return { type: "step", ...createStep(kind, id) };
}

export function createRampBlock(id: string): WorkoutRampBlock {
  return {
    type: "ramp",
    id,
    durationSecs: 600,
    targetPctFtp: 55,
    targetEndPctFtp: 85,
    label: "Rampa",
  };
}

export function createRepeat(id: string): WorkoutRepeat {
  return {
    id,
    count: 3,
    steps: [
      createStep("interval", `${id}-i`),
      createStep("recovery", `${id}-r`),
    ],
  };
}

export function createRepeatBlock(id: string): WorkoutRepeatBlock {
  return { type: "repeat", ...createRepeat(id) };
}

export function duplicateWorkout(workout: Workout): Workout {
  const now = new Date().toISOString();
  const normalized = normalizeWorkout(workout);
  return {
    ...normalized,
    id: "",
    presetId: undefined,
    category: "custom",
    name: `${workout.name} (copia)`,
    createdAt: now,
    updatedAt: now,
    blocks: structuredClone(normalized.blocks),
  };
}

export function downsampleSamples(
  samples: SessionSample[],
  intervalSecs = 5,
): SessionSeriesPoint[] {
  if (samples.length === 0) return [];

  const startMs = samples[0].timestampMs;
  const buckets = new Map<number, SessionSeriesPoint>();

  samples.forEach((sample) => {
    const t = Math.floor((sample.timestampMs - startMs) / 1000);
    const bucket = Math.floor(t / intervalSecs) * intervalSecs;
    buckets.set(bucket, {
      t: bucket,
      power: sample.power,
      hr: sample.heartRate,
      cadence: sample.cadence ? Math.round(sample.cadence) : undefined,
      target: sample.targetPower,
    });
  });

  return [...buckets.values()].sort((a, b) => a.t - b.t);
}

export function formatDuration(secs: number): string {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function formatClock(secs: number): string {
  const m = Math.floor(secs / 60)
    .toString()
    .padStart(2, "0");
  const s = (secs % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}
