import { useEffect, useMemo, useState } from "react";
import {
  createRampBlock,
  createRepeatBlock,
  createStepBlock,
  duplicateWorkout,
  flattenWorkout,
  formatDuration,
  normalizeWorkout,
  workoutTotalDuration,
} from "../lib/workoutEngine";
import {
  deleteWorkout,
  ensurePresetWorkouts,
  getProfile,
  newId,
  saveWorkout,
} from "../hooks/useStorage";
import { getClimbProfile } from "../lib/climbProfiles";
import { wattsForClimb } from "../lib/climbPhysics";
import { isClimbWorkout, isSimWorkout } from "../lib/climbModel";
import { ClimbProfileChart } from "../components/ClimbProfileChart";
import { WorkoutProfileChart } from "../components/WorkoutProfileChart";
import type {
  UserProfile,
  Workout,
  WorkoutBlock,
  WorkoutRampBlock,
  WorkoutRepeatBlock,
  WorkoutStepBlock,
  WorkoutStepKind,
} from "../types";
import { STEP_KIND_LABELS } from "../types";

const STEP_KINDS: WorkoutStepKind[] = [
  "warmup",
  "steady",
  "interval",
  "recovery",
  "cooldown",
];

type BuilderTab = "mine" | "classic" | "climb";

function wattsLabel(pct: number, ftp: number): string {
  return `${Math.round((ftp * pct) / 100)} W`;
}

function StepEditor({
  step,
  ftp,
  onChange,
  onRemove,
  onMoveUp,
  onMoveDown,
  canMoveUp,
  canMoveDown,
}: {
  step: WorkoutStepBlock;
  ftp: number;
  onChange: (step: WorkoutStepBlock) => void;
  onRemove: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  canMoveUp: boolean;
  canMoveDown: boolean;
}) {
  return (
    <div className="block-card">
      <div className="block-card__head">
        <strong>{step.label ?? STEP_KIND_LABELS[step.kind]}</strong>
        <div className="block-card__actions">
          <button type="button" className="btn btn--ghost btn--small" disabled={!canMoveUp} onClick={onMoveUp}>
            ↑
          </button>
          <button type="button" className="btn btn--ghost btn--small" disabled={!canMoveDown} onClick={onMoveDown}>
            ↓
          </button>
          <button type="button" className="btn btn--ghost btn--small" onClick={onRemove}>
            Rimuovi
          </button>
        </div>
      </div>
      <div className="block-card__grid">
        <label>
          <span>Etichetta</span>
          <input
            type="text"
            value={step.label ?? ""}
            placeholder={STEP_KIND_LABELS[step.kind]}
            onChange={(e) => onChange({ ...step, label: e.target.value || undefined })}
          />
        </label>
        <label>
          <span>Durata (min)</span>
          <input
            type="number"
            min={1}
            value={Math.round(step.durationSecs / 60) || ""}
            onChange={(e) =>
              onChange({
                ...step,
                durationSecs: Math.max(60, Number(e.target.value) * 60),
              })
            }
          />
        </label>
        <label>
          <span>Durata (sec)</span>
          <input
            type="number"
            min={10}
            value={step.durationSecs}
            onChange={(e) =>
              onChange({
                ...step,
                durationSecs: Math.max(10, Number(e.target.value)),
              })
            }
          />
        </label>
        <label>
          <span>Target (% FTP)</span>
          <input
            type="number"
            min={30}
            max={200}
            value={step.targetPctFtp}
            onChange={(e) =>
              onChange({ ...step, targetPctFtp: Number(e.target.value) })
            }
          />
        </label>
        <label>
          <span>Target (W)</span>
          <input type="text" readOnly value={wattsLabel(step.targetPctFtp, ftp)} />
        </label>
      </div>
    </div>
  );
}

function RampEditor({
  block,
  ftp,
  onChange,
  onRemove,
  onMoveUp,
  onMoveDown,
  canMoveUp,
  canMoveDown,
}: {
  block: WorkoutRampBlock;
  ftp: number;
  onChange: (block: WorkoutRampBlock) => void;
  onRemove: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  canMoveUp: boolean;
  canMoveDown: boolean;
}) {
  return (
    <div className="block-card block-card--ramp">
      <div className="block-card__head">
        <strong>{block.label ?? "Rampa"}</strong>
        <div className="block-card__actions">
          <button type="button" className="btn btn--ghost btn--small" disabled={!canMoveUp} onClick={onMoveUp}>
            ↑
          </button>
          <button type="button" className="btn btn--ghost btn--small" disabled={!canMoveDown} onClick={onMoveDown}>
            ↓
          </button>
          <button type="button" className="btn btn--ghost btn--small" onClick={onRemove}>
            Rimuovi
          </button>
        </div>
      </div>
      <div className="block-card__grid">
        <label>
          <span>Etichetta</span>
          <input
            type="text"
            value={block.label ?? ""}
            onChange={(e) => onChange({ ...block, label: e.target.value || undefined })}
          />
        </label>
        <label>
          <span>Durata (min)</span>
          <input
            type="number"
            min={1}
            value={Math.round(block.durationSecs / 60) || ""}
            onChange={(e) =>
              onChange({
                ...block,
                durationSecs: Math.max(60, Number(e.target.value) * 60),
              })
            }
          />
        </label>
        <label>
          <span>Inizio (% FTP)</span>
          <input
            type="number"
            min={30}
            max={200}
            value={block.targetPctFtp}
            onChange={(e) =>
              onChange({ ...block, targetPctFtp: Number(e.target.value) })
            }
          />
        </label>
        <label>
          <span>Fine (% FTP)</span>
          <input
            type="number"
            min={30}
            max={200}
            value={block.targetEndPctFtp}
            onChange={(e) =>
              onChange({ ...block, targetEndPctFtp: Number(e.target.value) })
            }
          />
        </label>
        <label>
          <span>Range (W)</span>
          <input
            type="text"
            readOnly
            value={`${wattsLabel(block.targetPctFtp, ftp)} → ${wattsLabel(block.targetEndPctFtp, ftp)}`}
          />
        </label>
      </div>
    </div>
  );
}

function RepeatEditor({
  repeat,
  ftp,
  onChange,
  onRemove,
  onMoveUp,
  onMoveDown,
  canMoveUp,
  canMoveDown,
}: {
  repeat: WorkoutRepeatBlock;
  ftp: number;
  onChange: (repeat: WorkoutRepeatBlock) => void;
  onRemove: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  canMoveUp: boolean;
  canMoveDown: boolean;
}) {
  return (
    <div className="block-card block-card--repeat">
      <div className="block-card__head">
        <strong>Ripetizioni</strong>
        <div className="block-card__actions">
          <button type="button" className="btn btn--ghost btn--small" disabled={!canMoveUp} onClick={onMoveUp}>
            ↑
          </button>
          <button type="button" className="btn btn--ghost btn--small" disabled={!canMoveDown} onClick={onMoveDown}>
            ↓
          </button>
          <button type="button" className="btn btn--ghost btn--small" onClick={onRemove}>
            Rimuovi
          </button>
        </div>
      </div>
      <label className="form-row">
        <span>Numero ripetizioni</span>
        <input
          type="number"
          min={1}
          max={50}
          value={repeat.count}
          onChange={(e) => onChange({ ...repeat, count: Number(e.target.value) })}
        />
      </label>
      {repeat.steps.map((step, idx) => (
        <div key={step.id} className="block-card block-card--nested">
          <div className="block-card__head">
            <strong>{step.label ?? STEP_KIND_LABELS[step.kind]}</strong>
            <button
              type="button"
              className="btn btn--ghost btn--small"
              onClick={() =>
                onChange({
                  ...repeat,
                  steps: repeat.steps.filter((s) => s.id !== step.id),
                })
              }
            >
              Rimuovi
            </button>
          </div>
          <div className="block-card__grid">
            <label>
              <span>Durata (sec)</span>
              <input
                type="number"
                min={10}
                value={step.durationSecs}
                onChange={(e) => {
                  const steps = [...repeat.steps];
                  steps[idx] = { ...step, durationSecs: Number(e.target.value) };
                  onChange({ ...repeat, steps });
                }}
              />
            </label>
            <label>
              <span>% FTP</span>
              <input
                type="number"
                min={30}
                max={200}
                value={step.targetPctFtp}
                onChange={(e) => {
                  const steps = [...repeat.steps];
                  steps[idx] = { ...step, targetPctFtp: Number(e.target.value) };
                  onChange({ ...repeat, steps });
                }}
              />
            </label>
            <label>
              <span>W</span>
              <input type="text" readOnly value={wattsLabel(step.targetPctFtp, ftp)} />
            </label>
          </div>
        </div>
      ))}
      <div className="block-actions">
        {(["interval", "recovery", "steady"] as WorkoutStepKind[]).map((kind) => (
          <button
            key={kind}
            type="button"
            className="btn btn--ghost btn--small"
            onClick={() => {
              const step = createStepBlock(kind, newId());
              onChange({
                ...repeat,
                steps: [
                  ...repeat.steps,
                  {
                    id: step.id,
                    kind: step.kind,
                    durationSecs: step.durationSecs,
                    targetPctFtp: step.targetPctFtp,
                  },
                ],
              });
            }}
          >
            + {STEP_KIND_LABELS[kind]}
          </button>
        ))}
      </div>
    </div>
  );
}

function BlockEditor({
  block,
  ftp,
  index,
  total,
  onChange,
  onRemove,
  onMoveUp,
  onMoveDown,
}: {
  block: WorkoutBlock;
  ftp: number;
  index: number;
  total: number;
  onChange: (block: WorkoutBlock) => void;
  onRemove: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
}) {
  const props = {
    ftp,
    onRemove,
    onMoveUp,
    onMoveDown,
    canMoveUp: index > 0,
    canMoveDown: index < total - 1,
  };

  if (block.type === "step") {
    return <StepEditor step={block} onChange={onChange} {...props} />;
  }
  if (block.type === "ramp") {
    return <RampEditor block={block} onChange={onChange} {...props} />;
  }
  return <RepeatEditor repeat={block} onChange={onChange} {...props} />;
}

export function WorkoutBuilderPage({
  onStartWorkout,
}: {
  onStartWorkout: (workout: Workout) => void;
}) {
  const [workouts, setWorkouts] = useState<Workout[]>([]);
  const [profile, setProfile] = useState<UserProfile>({
    name: "",
    heightCm: 175,
    weightKg: 70,
    ftpWatts: 200,
  });
  const [tab, setTab] = useState<BuilderTab>("mine");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Workout | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void Promise.all([ensurePresetWorkouts(), getProfile()])
      .then(([wos, prof]) => {
        setWorkouts(wos);
        setProfile(prof);
      })
      .catch((e) => setError(String(e)));
  }, []);

  const mineWorkouts = useMemo(
    () => workouts.filter((w) => !w.presetId),
    [workouts],
  );

  const listForTab = useMemo(() => {
    if (tab === "mine") return mineWorkouts;
    const prefix = tab === "classic" ? "classic-" : "climb-";
    const seen = new Set<string>();
    return workouts.filter((w) => {
      if (!w.presetId?.startsWith(prefix)) return false;
      const key = w.climbProfileId || w.presetId;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [tab, workouts, mineWorkouts]);

  const total = useMemo(
    () => (draft ? workoutTotalDuration(draft) : 0),
    [draft],
  );

  const timeline = useMemo(
    () => (draft ? flattenWorkout(draft, profile.ftpWatts) : []),
    [draft, profile.ftpWatts],
  );

  function newWorkout() {
    const now = new Date().toISOString();
    const w: Workout = {
      id: "",
      name: "Nuovo allenamento",
      description: "",
      blocks: [createStepBlock("warmup", newId()), createStepBlock("cooldown", newId())],
      category: "custom",
      createdAt: now,
      updatedAt: now,
    };
    setDraft(w);
    setSelectedId(null);
    setTab("mine");
  }

  function editWorkout(w: Workout) {
    setDraft(normalizeWorkout({ ...w, blocks: structuredClone(normalizeWorkout(w).blocks) }));
    setSelectedId(w.id);
  }

  function moveBlock(index: number, direction: -1 | 1) {
    if (!draft) return;
    const next = [...draft.blocks];
    const target = index + direction;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    setDraft({ ...draft, blocks: next });
  }

  async function handleSave() {
    if (!draft) return null;
    setError(null);
    try {
      const saved = await saveWorkout(draft);
      setWorkouts((prev) => {
        const next = prev.filter((w) => w.id !== saved.id);
        return [...next, saved].sort((a, b) => a.name.localeCompare(b.name));
      });
      setDraft(saved);
      setSelectedId(saved.id);
      return saved;
    } catch (e) {
      setError(String(e));
      return null;
    }
  }

  async function handleDelete(id: string) {
    await deleteWorkout(id);
    setWorkouts((prev) => prev.filter((w) => w.id !== id));
    if (selectedId === id) {
      setDraft(null);
      setSelectedId(null);
    }
  }

  async function handleDuplicatePreset(preset: Workout) {
    const copy = duplicateWorkout(preset);
    const saved = await saveWorkout(copy);
    setWorkouts((prev) => [...prev, saved]);
    editWorkout(saved);
    setTab("mine");
  }

  const isPresetDraft = Boolean(draft?.presetId);

  return (
    <section className="page builder-page">
      <header className="hero hero--compact">
        <p className="eyebrow">Strutturati</p>
        <h1>Allenamenti</h1>
      </header>

      <div className="builder-layout">
        <aside className="builder-list">
          <div className="builder-tabs">
            {(
              [
                ["mine", "I miei"],
                ["classic", "Classici"],
                ["climb", "Salite Amaro"],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                className={`builder-tab ${tab === key ? "builder-tab--active" : ""}`}
                onClick={() => setTab(key)}
              >
                {label}
              </button>
            ))}
          </div>

          {tab === "mine" && (
            <button type="button" className="btn btn--primary" onClick={newWorkout}>
              + Nuovo
            </button>
          )}

          <ul>
            {listForTab.map((w) => (
              <li key={w.id || w.presetId}>
                <button
                  type="button"
                  className={`builder-list__item ${selectedId === w.id ? "builder-list__item--active" : ""}`}
                  onClick={() => editWorkout(w)}
                >
                  <strong>{w.name}</strong>
                  <span>{formatDuration(workoutTotalDuration(w))}</span>
                </button>
              </li>
            ))}
          </ul>
        </aside>

        <div className="builder-editor">
          {!draft ? (
            <p className="muted-copy">Seleziona o crea un allenamento.</p>
          ) : (
            <>
              {isPresetDraft && (
                <div className="preset-banner">
                  <p>Preset di catalogo — duplica per modificarlo.</p>
                  <button
                    type="button"
                    className="btn btn--ghost btn--small"
                    onClick={() => void handleDuplicatePreset(draft)}
                  >
                    Aggiungi ai miei
                  </button>
                </div>
              )}

              <label className="form-row">
                <span>Nome</span>
                <input
                  type="text"
                  value={draft.name}
                  disabled={isPresetDraft}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                />
              </label>

              {draft.description && (
                <p className="muted-copy builder-description">{draft.description}</p>
              )}

              <div className="builder-preview">
                <div className="builder-preview__head">
                  <strong>Anteprima profilo</strong>
                  <span>
                    {formatDuration(total)}
                    {isClimbWorkout(draft)
                      ? ` · ${profile.weightKg} kg`
                      : ` · FTP ${profile.ftpWatts} W`}
                  </span>
                </div>
                {isClimbWorkout(draft) && getClimbProfile(draft.climbProfileId) ? (
                  <ClimbProfileChart
                    profile={getClimbProfile(draft.climbProfileId)!}
                    riderKg={profile.weightKg}
                  />
                ) : (
                  <WorkoutProfileChart
                    timeline={timeline}
                    ftp={profile.ftpWatts}
                    showGrade={isSimWorkout(draft)}
                  />
                )}
                {isClimbWorkout(draft) && (
                  <p className="muted-copy builder-description">
                    Come Zwift: il rullo riceve la pendenza, non un target watt. A 8% la stima
                    per {profile.weightKg} kg (bici 8 kg) è {wattsForClimb(profile.weightKg, 8)} W
                    — vai più piano se vuoi spingere meno.
                  </p>
                )}
              </div>

              {!isPresetDraft && (
                <div className="builder-toolbar">
                  {STEP_KINDS.map((kind) => (
                    <button
                      key={kind}
                      type="button"
                      className="btn btn--ghost btn--small"
                      onClick={() =>
                        setDraft({
                          ...draft,
                          blocks: [...draft.blocks, createStepBlock(kind, newId())],
                        })
                      }
                    >
                      + {STEP_KIND_LABELS[kind]}
                    </button>
                  ))}
                  <button
                    type="button"
                    className="btn btn--ghost btn--small"
                    onClick={() =>
                      setDraft({
                        ...draft,
                        blocks: [...draft.blocks, createRampBlock(newId())],
                      })
                    }
                  >
                    + Rampa
                  </button>
                  <button
                    type="button"
                    className="btn btn--ghost btn--small"
                    onClick={() =>
                      setDraft({
                        ...draft,
                        blocks: [...draft.blocks, createRepeatBlock(newId())],
                      })
                    }
                  >
                    + Ripetizioni
                  </button>
                </div>
              )}

              {!isPresetDraft &&
                draft.blocks.map((block, idx) => (
                  <BlockEditor
                    key={block.id}
                    block={block}
                    ftp={profile.ftpWatts}
                    index={idx}
                    total={draft.blocks.length}
                    onChange={(updated) => {
                      const blocks = [...draft.blocks];
                      blocks[idx] = updated;
                      setDraft({ ...draft, blocks });
                    }}
                    onRemove={() =>
                      setDraft({
                        ...draft,
                        blocks: draft.blocks.filter((b) => b.id !== block.id),
                      })
                    }
                    onMoveUp={() => moveBlock(idx, -1)}
                    onMoveDown={() => moveBlock(idx, 1)}
                  />
                ))}

              <div className="builder-footer">
                <span className="builder-total">Durata totale: {formatDuration(total)}</span>
                <div className="session-actions">
                  {!isPresetDraft && (
                    <button type="button" className="btn btn--primary" onClick={() => void handleSave()}>
                      Salva
                    </button>
                  )}
                  {selectedId && !isPresetDraft && (
                    <button
                      type="button"
                      className="btn btn--danger"
                      onClick={() => void handleDelete(selectedId)}
                    >
                      Elimina
                    </button>
                  )}
                  {isPresetDraft ? (
                    <>
                      <button
                        type="button"
                        className="btn btn--primary"
                        onClick={() => void handleDuplicatePreset(draft)}
                      >
                        Aggiungi ai miei
                      </button>
                      <button
                        type="button"
                        className="btn btn--ghost"
                        onClick={() => onStartWorkout(draft)}
                      >
                        Usa in sessione
                      </button>
                    </>
                  ) : draft.id ? (
                    <button
                      type="button"
                      className="btn btn--ghost"
                      onClick={() => onStartWorkout(draft)}
                    >
                      Usa in sessione
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="btn btn--ghost"
                      onClick={() =>
                        void handleSave().then((saved) => {
                          if (saved) onStartWorkout(saved);
                        })
                      }
                    >
                      Salva e usa
                    </button>
                  )}
                </div>
              </div>
            </>
          )}
          {error && <p className="error-banner">{error}</p>}
        </div>
      </div>
    </section>
  );
}
