import type {
  CoachWorkoutDraft,
  CoachWorkoutDraftBlock,
  CoachWorkoutDraftLegacyBlock,
  Workout,
  WorkoutBlock,
  WorkoutStepKind,
} from "../types";

const KINDS = new Set<WorkoutStepKind>(["warmup", "steady", "interval", "recovery", "cooldown"]);

function isLegacyBlock(block: CoachWorkoutDraft["blocks"][number]): block is CoachWorkoutDraftLegacyBlock {
  return !("type" in block);
}

function validStep(s: { kind: WorkoutStepKind; durationSecs: number; targetPctFtp: number }) {
  return KINDS.has(s.kind) && s.durationSecs > 0 && s.targetPctFtp > 0;
}

function normalizeDraftBlock(block: CoachWorkoutDraft["blocks"][number], index: number): WorkoutBlock | null {
  if (isLegacyBlock(block)) {
    if (!validStep(block)) return null;
    return {
      type: "step",
      id: `coach-${index}-${block.kind}`,
      kind: block.kind,
      durationSecs: block.durationSecs,
      targetPctFtp: block.targetPctFtp,
      label: block.label,
    };
  }

  const typed = block as CoachWorkoutDraftBlock;
  if (typed.type === "repeat") {
    const steps = typed.steps.filter(validStep).map((s, j) => ({
      id: `coach-${index}-${j}-${s.kind}`,
      kind: s.kind,
      durationSecs: s.durationSecs,
      targetPctFtp: s.targetPctFtp,
      label: s.label,
    }));
    if (steps.length === 0 || typed.count <= 0) return null;
    return { type: "repeat", id: `coach-repeat-${index}`, count: typed.count, steps };
  }

  if (typed.type === "ramp") {
    if (typed.durationSecs <= 0 || typed.targetPctFtp <= 0 || typed.targetEndPctFtp <= 0) return null;
    return {
      type: "ramp",
      id: `coach-ramp-${index}`,
      durationSecs: typed.durationSecs,
      targetPctFtp: typed.targetPctFtp,
      targetEndPctFtp: typed.targetEndPctFtp,
      label: typed.label,
    };
  }

  if (!validStep(typed)) return null;
  return {
    type: "step",
    id: `coach-${index}-${typed.kind}`,
    kind: typed.kind,
    durationSecs: typed.durationSecs,
    targetPctFtp: typed.targetPctFtp,
    label: typed.label,
  };
}

export function workoutFromCoachDraft(draft: CoachWorkoutDraft): Workout {
  const now = new Date().toISOString();
  const blocks: WorkoutBlock[] = draft.blocks
    .map((block, index) => normalizeDraftBlock(block, index))
    .filter((block): block is WorkoutBlock => block !== null);

  return {
    id: "",
    name: draft.name.slice(0, 80),
    description: draft.description,
    category: "custom",
    blocks,
    createdAt: now,
    updatedAt: now,
  };
}
