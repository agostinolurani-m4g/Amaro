import { useEffect, useMemo, useRef, useState } from "react";
import {
  endSession,
  pauseSession,
  resumeSession,
  setControlMode,
  setTargetPower,
  startSession,
} from "../hooks/useBle";
import { ClimbProfileChart } from "../components/ClimbProfileChart";
import { Metric } from "../components/Metric";
import { PowerChart } from "../components/PowerChart";
import { WorkoutProfileChart } from "../components/WorkoutProfileChart";
import { WorkoutTimeline } from "../components/WorkoutTimeline";
import { isClimbWorkout, isSimWorkout, pctFtpToGrade } from "../lib/climbModel";
import { wattsForClimb } from "../lib/climbPhysics";
import {
  getClimbProfile,
  sampleAtDistance,
} from "../lib/climbProfiles";
import {
  flattenWorkout,
  formatClock,
  getTimelineStepAt,
} from "../lib/workoutEngine";
import { getPersonalRecords, listCalendar, todayIso } from "../hooks/useStorage";
import { athleteModel, lactateAfter, substrateAt } from "../../shared/engine/physiology.mjs";
import type {
  CalendarEntry,
  ConnectionState,
  ControlMode,
  SessionSummary,
  Telemetry,
  UserProfile,
  Workout,
} from "../types";

interface LiveRidePageProps {
  connection: ConnectionState;
  telemetry: Telemetry | null;
  profile: UserProfile;
  activeWorkout: Workout | null;
  onClearWorkout: () => void;
  onSessionEnd: (summary: SessionSummary) => void;
  onBack: () => void;
}

export function LiveRidePage({
  connection,
  telemetry,
  profile,
  activeWorkout,
  onClearWorkout,
  onSessionEnd,
  onBack,
}: LiveRidePageProps) {
  const [mode, setMode] = useState<ControlMode>("erg");
  const [targetPower, setTargetPowerState] = useState(profile.ftpWatts);
  const [resistance, setResistance] = useState(50);
  const [grade, setGrade] = useState(0);
  const [wind, setWind] = useState(0);
  const [sessionState, setSessionState] = useState<"idle" | "active" | "paused">("idle");
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [sessionStart, setSessionStart] = useState<number | null>(null);
  const lastStepKey = useRef<string | null>(null);
  const lastTelemetryMs = useRef<number | null>(null);
  const lastSentGrade = useRef<number | null>(null);
  const [climbDistanceM, setClimbDistanceM] = useState(0);
  const [entries, setEntries] = useState<CalendarEntry[] | null>(null);
  const [records, setRecords] = useState<Awaited<ReturnType<typeof getPersonalRecords>> | null>(null);
  const [physio, setPhysio] = useState<{ wbal: number; lactate: number; choGh: number; choG: number } | null>(null);
  const physioRef = useRef({ wbal: 0, lastMs: null as number | null, window: [] as { t: number; p: number }[], choG: 0 });

  useEffect(() => {
    void listCalendar()
      .then(setEntries)
      .catch(() => setEntries([]));
    void getPersonalRecords()
      .then(setRecords)
      .catch(() => setRecords(null));
  }, []);

  const model = useMemo(
    () => (entries ? athleteModel(profile, entries, { records, today: todayIso() }) : null),
    [profile, entries, records],
  );

  useEffect(() => {
    if (!model || sessionState !== "active" || !telemetry) return;
    const st = physioRef.current;
    const now = telemetry.timestampMs;
    const power = Math.max(0, telemetry.power ?? 0);
    if (st.lastMs == null) {
      st.lastMs = now;
      return;
    }
    const dt = Math.min(3, Math.max(0, (now - st.lastMs) / 1000));
    st.lastMs = now;
    if (dt === 0) return;
    const { cp, wPrime } = model;
    if (power > cp) st.wbal -= (power - cp) * dt;
    else st.wbal += ((cp - power) * (wPrime - st.wbal) * dt) / wPrime;
    st.wbal = Math.min(wPrime, Math.max(0, st.wbal));
    st.window.push({ t: now, p: power });
    while (st.window.length && now - st.window[0].t > 180_000) st.window.shift();
    const avg = st.window.reduce((s, x) => s + x.p, 0) / st.window.length;
    const span = Math.max(30, (now - st.window[0].t) / 1000);
    const sub = power > 0 ? substrateAt(power, model.params) : { choGh: 0 };
    st.choG += (sub.choGh * dt) / 3600;
    setPhysio({
      wbal: st.wbal,
      lactate: avg > 0 ? lactateAfter(avg, span, model.params) : 1,
      choGh: sub.choGh,
      choG: st.choG,
    });
  }, [model, sessionState, telemetry]);

  const climbProfile = activeWorkout
    ? getClimbProfile(activeWorkout.climbProfileId)
    : undefined;
  const climbWorkout = Boolean(activeWorkout && isClimbWorkout(activeWorkout) && climbProfile);

  const timeline = useMemo(
    () => (activeWorkout ? flattenWorkout(activeWorkout, profile.ftpWatts) : []),
    [activeWorkout, profile.ftpWatts],
  );

  const { current, next, progress } = useMemo(
    () => getTimelineStepAt(timeline, elapsed),
    [timeline, elapsed],
  );

  useEffect(() => {
    if (connection.status === "disconnected" && sessionState !== "idle") {
      setError("Connessione persa con il rullo");
      setSessionState("paused");
    }
  }, [connection.status, sessionState]);

  useEffect(() => {
    if (sessionState !== "active" || sessionStart === null) return;
    const id = window.setInterval(() => {
      setElapsed(Math.floor((Date.now() - sessionStart) / 1000));
    }, 1000);
    return () => window.clearInterval(id);
  }, [sessionState, sessionStart]);

  const simWorkout = activeWorkout ? isSimWorkout(activeWorkout) : false;

  const climbSample = useMemo(() => {
    if (!climbProfile) return null;
    return sampleAtDistance(climbProfile, climbDistanceM);
  }, [climbProfile, climbDistanceM]);

  const climbWatts = climbSample
    ? wattsForClimb(profile.weightKg, climbSample.gradePercent)
    : 0;

  const currentGrade = useMemo(() => {
    if (climbSample) return climbSample.gradePercent;
    if (!current) return 0;
    if (current.gradePercent != null) return current.gradePercent;
    return pctFtpToGrade(current.targetPctFtp);
  }, [current, climbSample]);

  const climbingNow = currentGrade > 0.5;

  useEffect(() => {
    if (!climbWorkout || sessionState !== "active" || !telemetry) return;
    const now = telemetry.timestampMs;
    if (lastTelemetryMs.current != null) {
      const dt = Math.min(2, (now - lastTelemetryMs.current) / 1000);
      const speed = telemetry.speedKmh ?? 0;
      if (dt > 0 && speed > 1) {
        setClimbDistanceM((d) =>
          Math.min(climbProfile!.lengthM, d + (speed / 3.6) * dt),
        );
      }
    }
    lastTelemetryMs.current = now;
  }, [climbWorkout, sessionState, telemetry, climbProfile]);

  useEffect(() => {
    if (!climbWorkout || sessionState !== "active" || !climbSample) return;
    const nextGrade = climbSample.gradePercent;
    if (lastSentGrade.current != null && Math.abs(nextGrade - lastSentGrade.current) < 0.1) {
      return;
    }
    lastSentGrade.current = nextGrade;
    setGrade(nextGrade);
    setMode("sim");
    void setControlMode("sim", {
      simulation: { gradePercent: nextGrade, windSpeedMs: 0 },
    }).catch((e) => setError(String(e)));
  }, [climbWorkout, sessionState, climbSample]);

  useEffect(() => {
    if (climbWorkout) return;
    if (!activeWorkout || sessionState !== "active" || !current) return;
    const key = `${current.startOffsetSecs}-${current.label}`;
    if (lastStepKey.current === key) return;
    lastStepKey.current = key;

    if (simWorkout) {
      const nextGrade = currentGrade;
      setGrade(nextGrade);
      setMode("sim");
      void setControlMode("sim", {
        simulation: { gradePercent: nextGrade, windSpeedMs: 0 },
      }).catch((e) => setError(String(e)));
      return;
    }

    setTargetPowerState(current.targetWatts);
    setMode("erg");
    void setControlMode("erg", { targetPower: current.targetWatts }).catch((e) =>
      setError(String(e)),
    );
  }, [activeWorkout, sessionState, current, simWorkout, currentGrade, climbWorkout]);

  async function applyMode(nextMode: ControlMode) {
    setMode(nextMode);
    try {
      await setControlMode(nextMode, {
        targetPower,
        resistance,
        simulation: { gradePercent: grade, windSpeedMs: wind },
      });
    } catch (e) {
      setError(String(e));
    }
  }

  async function handleTargetChange(watts: number) {
    setTargetPowerState(watts);
    if (mode === "erg" && !activeWorkout) {
      try {
        await setTargetPower(watts);
      } catch (e) {
        setError(String(e));
      }
    }
  }

  async function handleStart() {
    setError(null);
    lastStepKey.current = null;
    try {
      await startSession();
      physioRef.current = { wbal: model?.wPrime ?? 0, lastMs: null, window: [], choG: 0 };
      setPhysio(null);
      lastTelemetryMs.current = null;
      lastSentGrade.current = null;
      setClimbDistanceM(0);
      if (climbWorkout && climbProfile) {
        const start = sampleAtDistance(climbProfile, 0);
        lastSentGrade.current = start.gradePercent;
        setGrade(start.gradePercent);
        setMode("sim");
        await setControlMode("sim", {
          simulation: { gradePercent: start.gradePercent, windSpeedMs: 0 },
        });
      } else if (activeWorkout && simWorkout && timeline[0]) {
        const startGrade =
          timeline[0].gradePercent ?? pctFtpToGrade(timeline[0].targetPctFtp);
        setGrade(startGrade);
        setMode("sim");
        await setControlMode("sim", {
          simulation: { gradePercent: startGrade, windSpeedMs: 0 },
        });
      } else {
        const startWatts =
          activeWorkout && timeline[0] ? timeline[0].targetWatts : targetPower;
        setTargetPowerState(startWatts);
        setMode("erg");
        await setControlMode("erg", { targetPower: startWatts });
      }
      setSessionState("active");
      setSessionStart(Date.now());
      setElapsed(0);
    } catch (e) {
      setError(String(e));
    }
  }

  async function handlePauseResume() {
    setError(null);
    try {
      if (sessionState === "active") {
        await pauseSession();
        setSessionState("paused");
      } else if (sessionState === "paused") {
        await resumeSession();
        setSessionState("active");
      }
    } catch (e) {
      setError(String(e));
    }
  }

  async function handleEnd() {
    setError(null);
    try {
      const summary = await endSession();
      onSessionEnd(summary);
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <section className="page live-page">
      <header className="live-header">
        <button type="button" className="btn btn--ghost btn--small" onClick={onBack}>
          ← Indietro
        </button>
        <div>
          <p className="eyebrow">Sessione live</p>
          <h2>{connection.deviceName ?? "Rullo"}</h2>
        </div>
        <div className="session-timer">{formatClock(elapsed)}</div>
      </header>

      {climbWorkout && climbProfile ? (
        <div className="workout-timeline">
          <div className="workout-timeline__head">
            <div>
              <p className="eyebrow">Salita · SIM (pendenza al rullo)</p>
              <h3>{climbProfile.name}</h3>
            </div>
            <div className="workout-timeline__timer">
              <span>{(climbDistanceM / 1000).toFixed(2)} km</span>
              <small>/ {(climbProfile.lengthM / 1000).toFixed(1)} km</small>
            </div>
          </div>
          <div className="progress-bar progress-bar--overall">
            <div style={{ width: `${Math.min(100, (climbDistanceM / climbProfile.lengthM) * 100)}%` }} />
          </div>
          <p className="muted-copy">
            {climbSample?.elevationM.toFixed(0)} m · {currentGrade.toFixed(1)}%
            {climbingNow
              ? ` · stima ${climbWatts} W a ${profile.weightKg} kg in salita (non è un target).`
              : " · discesa/pianura: i watt li scegli tu, la stima non ha senso qui."}{" "}
            Più spingi, più avanzi.
          </p>
        </div>
      ) : activeWorkout ? (
        <WorkoutTimeline
          workoutName={activeWorkout.name}
          timeline={timeline}
          elapsedSecs={elapsed}
          current={current}
          next={next}
          stepProgress={progress}
          simMode={simWorkout}
        />
      ) : (
        <p className="muted-copy live-free-note">
          Modalità libera — seleziona un allenamento dalla tab Allenamenti per guidare la sessione.
        </p>
      )}

      <div className="metrics-grid">
        <Metric label="Potenza" value={telemetry?.power?.toString() ?? "—"} unit="W" accent />
        {climbWorkout ? (
          <>
            <Metric label="Pendenza" value={currentGrade.toFixed(1)} unit="%" />
            <Metric
              label="Stima"
              value={climbingNow ? String(climbWatts) : "—"}
              unit={climbingNow ? "W" : ""}
            />
          </>
        ) : simWorkout && activeWorkout ? (
          <Metric label="Pendenza" value={currentGrade.toFixed(1)} unit="%" />
        ) : (
          <Metric label="Target" value={targetPower.toString()} unit="W" />
        )}
        <Metric label="Cadenza" value={telemetry?.cadence?.toFixed(0) ?? "—"} unit="rpm" />
        <Metric label="Velocità" value={telemetry?.speedKmh?.toFixed(1) ?? "—"} unit="km/h" />
        <Metric label="FC" value={telemetry?.heartRate?.toString() ?? "—"} unit="bpm" />
      </div>

      {model && (
        <div className="live-physio">
          <div className="summary-stat">
            <span>W' residuo</span>
            <strong>
              {physio ? `${(physio.wbal / 1000).toFixed(1)} / ${(model.wPrime / 1000).toFixed(1)} kJ` : `${(model.wPrime / 1000).toFixed(1)} kJ`}
            </strong>
            <div className="wbal-bar">
              <div
                className="wbal-bar__fill"
                style={{ width: `${physio ? Math.round((physio.wbal / model.wPrime) * 100) : 100}%` }}
              />
            </div>
          </div>
          <div className="summary-stat">
            <span>Lattato stimato (3')</span>
            <strong>{physio ? `${physio.lactate.toFixed(1)} mmol/l` : "—"}</strong>
          </div>
          <div className="summary-stat">
            <span>Carboidrati ora · totali</span>
            <strong>{physio ? `${physio.choGh} g/h · ${Math.round(physio.choG)} g` : "—"}</strong>
          </div>
          <div className="summary-stat">
            <span>CP · LT1 · LT2</span>
            <strong>
              {model.cp} · {model.lt1} · {model.lt2} W
            </strong>
          </div>
        </div>
      )}

      <PowerChart
        telemetry={telemetry}
        targetPower={climbWorkout ? (climbingNow ? climbWatts : undefined) : targetPower}
        timeline={timeline}
        elapsedSecs={elapsed}
      />

      {climbWorkout && climbProfile ? (
        <div className="live-profile-overlay">
          <p className="eyebrow">Profilo salita</p>
          <ClimbProfileChart
            profile={climbProfile}
            riderKg={profile.weightKg}
            height={160}
            distanceM={climbDistanceM}
          />
        </div>
      ) : (
        activeWorkout &&
        timeline.length > 0 && (
          <div className="live-profile-overlay">
            <p className="eyebrow">Profilo allenamento</p>
            <WorkoutProfileChart
              timeline={timeline}
              ftp={profile.ftpWatts}
              height={120}
              elapsedSecs={elapsed}
              showCursor
              showGrade={simWorkout}
            />
          </div>
        )
      )}

      {!activeWorkout && (
        <div className="control-panel">
          <div className="mode-tabs">
            {(["erg", "resistance", "sim"] as ControlMode[]).map((m) => (
              <button
                key={m}
                type="button"
                className={`mode-tab ${mode === m ? "mode-tab--active" : ""}`}
                onClick={() => void applyMode(m)}
              >
                {m === "erg" ? "ERG" : m === "resistance" ? "Resistenza" : "Sim"}
              </button>
            ))}
          </div>

          {mode === "erg" && (
            <label className="control-field">
              <span>Target power (W)</span>
              <input
                type="range"
                min={50}
                max={500}
                step={5}
                value={targetPower}
                onChange={(e) => void handleTargetChange(Number(e.target.value))}
              />
              <strong>{targetPower} W</strong>
            </label>
          )}

          {mode === "resistance" && (
            <label className="control-field">
              <span>Resistenza (%)</span>
              <input
                type="range"
                min={0}
                max={100}
                step={1}
                value={resistance}
                onChange={(e) => setResistance(Number(e.target.value))}
                onMouseUp={() => void applyMode("resistance")}
                onTouchEnd={() => void applyMode("resistance")}
              />
              <strong>{resistance}%</strong>
            </label>
          )}

          {mode === "sim" && (
            <div className="sim-controls">
              <label className="control-field">
                <span>Pendenza (%)</span>
                <input
                  type="range"
                  min={-10}
                  max={20}
                  step={0.5}
                  value={grade}
                  onChange={(e) => setGrade(Number(e.target.value))}
                  onMouseUp={() => void applyMode("sim")}
                  onTouchEnd={() => void applyMode("sim")}
                />
                <strong>{grade.toFixed(1)}%</strong>
              </label>
              <label className="control-field">
                <span>Vento (m/s)</span>
                <input
                  type="range"
                  min={0}
                  max={15}
                  step={0.5}
                  value={wind}
                  onChange={(e) => setWind(Number(e.target.value))}
                  onMouseUp={() => void applyMode("sim")}
                  onTouchEnd={() => void applyMode("sim")}
                />
                <strong>{wind.toFixed(1)} m/s</strong>
              </label>
            </div>
          )}
        </div>
      )}

      <div className="session-actions">
        {activeWorkout && sessionState === "idle" && (
          <button type="button" className="btn btn--ghost" onClick={onClearWorkout}>
            Rimuovi allenamento
          </button>
        )}
        {sessionState === "idle" ? (
          <button type="button" className="btn btn--primary" onClick={() => void handleStart()}>
            Avvia sessione
          </button>
        ) : (
          <>
            <button type="button" className="btn btn--ghost" onClick={() => void handlePauseResume()}>
              {sessionState === "active" ? "Pausa" : "Riprendi"}
            </button>
            <button type="button" className="btn btn--danger" onClick={() => void handleEnd()}>
              Termina
            </button>
          </>
        )}
      </div>

      {error && <p className="error-banner">{error}</p>}
    </section>
  );
}
