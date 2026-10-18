import { useMemo, useState } from "react";
import { CoachChart } from "./CoachChart";
import { WorkoutProfileChart } from "./WorkoutProfileChart";
import { flattenWorkout, formatDuration } from "../lib/workoutEngine";
import { workoutFromCoachDraft } from "../lib/coachWorkouts";
import { feasibilityLabel } from "../lib/coachLabels";
import type {
  CoachArtifact,
  CoachPlanSession,
  CoachWorkoutDraft,
  Workout,
} from "../types";

const DAYS = ["Lun", "Mar", "Mer", "Gio", "Ven", "Sab", "Dom"];

interface CoachArtifactCanvasProps {
  artifacts: CoachArtifact[];
  profileFtp: number;
  savedWorkoutNames: Set<string>;
  savedWorkouts: Map<string, Workout>;
  applied?: boolean;
  onSaveWorkout: (draft: CoachWorkoutDraft) => Promise<Workout>;
  onStartWorkout?: (workout: Workout) => void;
  onSavePlan: (sessions: CoachPlanSession[], linkedWorkouts: Workout[]) => Promise<void>;
}

function mondayOf(dateStr: string): Date {
  const d = new Date(`${dateStr}T12:00:00`);
  const dow = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - dow);
  d.setHours(0, 0, 0, 0);
  return d;
}

function isoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function addDays(d: Date, n: number): Date {
  const next = new Date(d);
  next.setDate(next.getDate() + n);
  return next;
}

function PlanArtifact({
  artifact,
  savedWorkouts,
  applied,
  onSave,
}: {
  artifact: Extract<CoachArtifact, { type: "plan" }>;
  savedWorkouts: Workout[];
  applied?: boolean;
  onSave: () => Promise<void>;
}) {
  const [weekOffset, setWeekOffset] = useState(0);
  const [saving, setSaving] = useState(false);

  const sessions = artifact.sessions;
  const firstDate = sessions[0]?.date ?? isoDate(new Date());
  const baseMonday = useMemo(() => mondayOf(firstDate), [firstDate]);
  const weekStart = useMemo(
    () => addDays(baseMonday, weekOffset * 7),
    [baseMonday, weekOffset],
  );
  const weekDays = useMemo(
    () => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)),
    [weekStart],
  );
  const totalWeeks = artifact.weeks ?? Math.max(1, Math.ceil(sessions.length / 4));

  return (
    <div className="artifact artifact--plan">
      <div className="artifact__head">
        <h3>Piano allenamento</h3>
        <span className="artifact__meta">
          {sessions.length} sessioni
          {totalWeeks > 1 ? ` · ${totalWeeks} settimane` : ""}
        </span>
      </div>

      <div className="week-nav">
        <button
          type="button"
          className="btn btn--ghost btn--small"
          onClick={() => setWeekOffset((n) => n - 1)}
        >
          ‹
        </button>
        <span>
          {weekStart.toLocaleDateString("it-IT", { day: "numeric", month: "short" })}{" "}
          –{" "}
          {addDays(weekStart, 6).toLocaleDateString("it-IT", {
            day: "numeric",
            month: "short",
          })}
        </span>
        <button
          type="button"
          className="btn btn--ghost btn--small"
          onClick={() => setWeekOffset((n) => n + 1)}
        >
          ›
        </button>
      </div>

      <div className="week-cards">
        {weekDays.map((day, i) => {
          const key = isoDate(day);
          const session = sessions.find((p) => p.date === key);
          return (
            <div
              key={key}
              className={`day-card ${session ? "day-card--workout" : "day-card--rest"}`}
            >
              <div className="day-card__head">
                <span>
                  {DAYS[i]} {day.getDate()}
                </span>
                <span>{session ? "🚴" : "—"}</span>
              </div>
              {session ? (
                <>
                  <strong>{session.name}</strong>
                  <p>
                    {formatDuration(Math.round(session.durationMin * 60))}
                    {session.description ? ` · ${session.description}` : ""}
                  </p>
                </>
              ) : (
                <p>Riposo</p>
              )}
            </div>
          );
        })}
      </div>

      {applied ? (
        <p className="artifact__hint">Piano già scritto sul calendario (28 giorni).</p>
      ) : (
        <button
          type="button"
          className="btn btn--primary"
          disabled={saving || sessions.length === 0}
          onClick={() => {
            setSaving(true);
            void onSave().finally(() => setSaving(false));
          }}
        >
          Salva piano sul calendario
        </button>
      )}
      {savedWorkouts.length > 0 && (
        <p className="artifact__hint">
          Workout salvati: {savedWorkouts.map((w) => w.name).join(", ")}
        </p>
      )}
    </div>
  );
}

function WorkoutArtifact({
  artifact,
  profileFtp,
  saved,
  savedWorkout,
  onSave,
  onStart,
}: {
  artifact: Extract<CoachArtifact, { type: "workout" }>;
  profileFtp: number;
  saved: boolean;
  savedWorkout?: Workout;
  onSave: () => Promise<Workout>;
  onStart?: (workout: Workout) => void;
}) {
  const [workout, setWorkout] = useState<Workout | null>(savedWorkout ?? null);
  const [saving, setSaving] = useState(false);

  const preview = useMemo(() => workoutFromCoachDraft(artifact.draft), [artifact.draft]);
  const timeline = useMemo(
    () => flattenWorkout(preview, profileFtp || 200),
    [preview, profileFtp],
  );

  async function handleSave() {
    setSaving(true);
    try {
      const savedW = await onSave();
      setWorkout(savedW);
    } finally {
      setSaving(false);
    }
  }

  const active = workout ?? savedWorkout;

  return (
    <div className="artifact artifact--workout">
      <div className="artifact__head">
        <h3>{artifact.draft.name}</h3>
        {artifact.draft.description && (
          <p className="artifact__meta">{artifact.draft.description}</p>
        )}
      </div>
      <WorkoutProfileChart timeline={timeline} ftp={profileFtp || undefined} height={180} />
      {artifact.draft.prediction && (
        <p className={`artifact__meta artifact__prediction artifact__prediction--${artifact.draft.prediction.feasibility}`}>
          Previsto: {Math.round(artifact.draft.prediction.durationSecs / 60)}′ · TSS {artifact.draft.prediction.tss} · IF{" "}
          {artifact.draft.prediction.ifactor} · {artifact.draft.prediction.kj} kJ · CHO ~{artifact.draft.prediction.choG} g · W′bal min{" "}
          {artifact.draft.prediction.wbalMinPct}% ·{" "}
          {feasibilityLabel(artifact.draft.prediction.feasibility)}
        </p>
      )}
      <div className="artifact__actions">
        <button
          type="button"
          className="btn btn--primary"
          disabled={saving || saved}
          onClick={() => void handleSave()}
        >
          {saved ? "Salvato" : "Salva in Allenamenti"}
        </button>
        {onStart && active && (
          <button type="button" className="btn btn--ghost" onClick={() => onStart(active)}>
            Avvia
          </button>
        )}
      </div>
    </div>
  );
}

export function CoachArtifactCanvas({
  artifacts,
  profileFtp,
  savedWorkoutNames,
  savedWorkouts,
  applied,
  onSaveWorkout,
  onStartWorkout,
  onSavePlan,
}: CoachArtifactCanvasProps) {
  const savedList = useMemo(() => [...savedWorkouts.values()], [savedWorkouts]);

  if (artifacts.length === 0) {
    return (
      <div className="artifact-canvas artifact-canvas--empty">
        <p>Valutazioni, piano mensile e workout appariranno qui dopo l&apos;obiettivo.</p>
      </div>
    );
  }

  const ordered = [...artifacts].reverse();

  return (
    <div className="artifact-canvas">
      {ordered.map((artifact, index) => {
        const key = `${artifact.type}-${index}`;

        if (artifact.type === "workout") {
          return (
            <WorkoutArtifact
              key={key}
              artifact={artifact}
              profileFtp={profileFtp}
              saved={savedWorkoutNames.has(artifact.draft.name.toLowerCase())}
              savedWorkout={savedWorkouts.get(artifact.draft.name.toLowerCase())}
              onSave={() => onSaveWorkout(artifact.draft)}
              onStart={onStartWorkout}
            />
          );
        }

        if (artifact.type === "plan") {
          return (
            <PlanArtifact
              key={key}
              artifact={artifact}
              savedWorkouts={savedList}
              applied={applied}
              onSave={() => onSavePlan(artifact.sessions, savedList)}
            />
          );
        }

        if (artifact.type === "chart") {
          return (
            <div key={key} className="artifact artifact--chart">
              <CoachChart chart={artifact.chart} />
            </div>
          );
        }

        if (artifact.type === "sources") {
          return (
            <div key={key} className="artifact artifact--sources">
              <div className="artifact__head">
                <h3>Ricerca web</h3>
                <p className="artifact__meta">{artifact.query}</p>
              </div>
              <ul className="source-list">
                {artifact.results.map((result) => (
                  <li key={result.url}>
                    <a href={result.url} target="_blank" rel="noreferrer">
                      {result.title}
                    </a>
                    {result.snippet && <p>{result.snippet}</p>}
                  </li>
                ))}
              </ul>
            </div>
          );
        }

        return null;
      })}
    </div>
  );
}
