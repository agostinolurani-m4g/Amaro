import type { TimelineStep } from "../types";
import { formatClock, formatDuration } from "../lib/workoutEngine";

interface WorkoutTimelineProps {
  workoutName: string;
  timeline: TimelineStep[];
  elapsedSecs: number;
  current: TimelineStep | null;
  next: TimelineStep | null;
  stepProgress: number;
  simMode?: boolean;
}

function stepTargetLabel(step: TimelineStep, simMode: boolean): string {
  if (simMode && step.gradePercent != null) {
    return `${step.gradePercent.toFixed(1)}%`;
  }
  return `${step.targetWatts} W`;
}

export function WorkoutTimeline({
  workoutName,
  timeline,
  elapsedSecs,
  current,
  next,
  stepProgress,
  simMode = false,
}: WorkoutTimelineProps) {
  const total = timeline.reduce((s, t) => s + t.durationSecs, 0);
  const overall = total > 0 ? Math.min(1, elapsedSecs / total) : 0;
  const stepRemaining = current
    ? Math.max(0, current.durationSecs - Math.round(stepProgress * current.durationSecs))
    : 0;

  return (
    <div className="workout-timeline">
      <div className="workout-timeline__head">
        <div>
          <p className="eyebrow">{simMode ? "Salita · modalità SIM" : "Allenamento"}</p>
          <h3>{workoutName}</h3>
        </div>
        <div className="workout-timeline__timer">
          <span>{formatClock(elapsedSecs)}</span>
          <small>/ {formatDuration(total)}</small>
        </div>
      </div>

      <div className="progress-bar progress-bar--overall">
        <div style={{ width: `${overall * 100}%` }} />
      </div>

      {current ? (
        <div className="workout-current">
          <div className="workout-current__main">
            <span className="workout-current__label">{current.label}</span>
            <strong>
              {simMode && current.gradePercent != null
                ? `${current.gradePercent.toFixed(1)}%`
                : `${current.targetWatts} W`}
            </strong>
            <small>
              {simMode
                ? "pendenza simulata"
                : `${current.targetPctFtp}% FTP`}
            </small>
          </div>
          <div className="workout-current__meta">
            <span>{formatClock(stepRemaining)} rimanenti</span>
            <div className="progress-bar">
              <div style={{ width: `${stepProgress * 100}%` }} />
            </div>
          </div>
          {next && (
            <p className="workout-next">
              Prossimo: {next.label} · {stepTargetLabel(next, simMode)}
            </p>
          )}
        </div>
      ) : (
        <p className="muted-copy">Allenamento completato</p>
      )}

      <div className="timeline-list">
        {timeline.map((step) => {
          const active =
            current &&
            step.startOffsetSecs === current.startOffsetSecs &&
            step.durationSecs === current.durationSecs &&
            step.label === current.label;
          const done = elapsedSecs >= step.startOffsetSecs + step.durationSecs;
          return (
            <div
              key={`${step.index}-${step.label}`}
              className={`timeline-item ${active ? "timeline-item--active" : ""} ${done ? "timeline-item--done" : ""}`}
            >
              <span>{step.label}</span>
              <span>{formatDuration(step.durationSecs)}</span>
              <span>{stepTargetLabel(step, simMode)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
