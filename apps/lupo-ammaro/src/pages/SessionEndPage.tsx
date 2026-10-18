import { useEffect, useMemo, useRef, useState } from "react";
import { exportFit, getLastSessionSamples } from "../hooks/useBle";
import { getStravaStatus, uploadLastSessionToStrava } from "../hooks/useStrava";
import { downsampleSamples, formatDuration } from "../lib/workoutEngine";
import {
  formatHours,
  formatKm,
  isPowerRecord,
} from "../lib/sessionStats";
import { SessionSeriesChart } from "../components/SessionSeriesChart";
import type {
  CalendarEntry,
  PersonalRecordHit,
  SessionEvaluation,
  SessionSeriesPoint,
  SessionStats,
  SessionSummary,
} from "../types";
import { ZoneBars } from "../components/ZoneBars";
import { RichText } from "../components/RichText";

interface SessionEndPageProps {
  summary: SessionSummary;
  stats: SessionStats | null;
  records: PersonalRecordHit[];
  evaluation?: SessionEvaluation | null;
  coachComment?: string | null;
  coachCommentPending?: boolean;
  savedEntry?: CalendarEntry | null;
  onSaveFeedback?: (rpe: number, feel: string) => Promise<void>;
  onDone: () => void;
  onOpenLeaderboard?: () => void;
}

const RPE_LABELS: Record<number, string> = {
  1: "Molto facile",
  3: "Facile",
  5: "Moderato",
  7: "Duro",
  9: "Molto duro",
  10: "Massimale",
};

const FEELS = ["Gambe ottime", "Normale", "Gambe pesanti", "Stanco", "Dolori"];

type StravaUploadState =
  | { kind: "idle" }
  | { kind: "uploading" }
  | { kind: "success"; activityId: number }
  | { kind: "error"; message: string };

export function SessionEndPage({
  summary,
  stats,
  records,
  evaluation,
  coachComment,
  coachCommentPending,
  savedEntry,
  onSaveFeedback,
  onDone,
  onOpenLeaderboard,
}: SessionEndPageProps) {
  const [rpe, setRpe] = useState<number | null>(null);
  const [feel, setFeel] = useState("");
  const [feedbackSaved, setFeedbackSaved] = useState(false);
  const [savedPath, setSavedPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [series, setSeries] = useState<SessionSeriesPoint[]>([]);
  const [stravaConnected, setStravaConnected] = useState(false);
  const [stravaAutoUpload, setStravaAutoUpload] = useState(false);
  const [stravaState, setStravaState] = useState<StravaUploadState>({ kind: "idle" });
  const autoUploadStarted = useRef(false);

  useEffect(() => {
    void getLastSessionSamples()
      .then((samples) => setSeries(downsampleSamples(samples)))
      .catch(() => setSeries([]));
  }, []);

  useEffect(() => {
    void getStravaStatus()
      .then((status) => {
        setStravaConnected(status.connected);
        setStravaAutoUpload(status.autoUpload);
      })
      .catch(() => {
        setStravaConnected(false);
        setStravaAutoUpload(false);
      });
  }, []);

  useEffect(() => {
    if (!stravaConnected || !stravaAutoUpload || autoUploadStarted.current) return;
    if (coachCommentPending) return;

    autoUploadStarted.current = true;
    setStravaState({ kind: "uploading" });
    void uploadLastSessionToStrava({
      description: coachComment ?? evaluation?.summary,
    })
      .then((result) => {
        setStravaState({ kind: "success", activityId: result.activityId });
      })
      .catch((e) => {
        setStravaState({ kind: "error", message: String(e) });
      });
  }, [
    stravaConnected,
    stravaAutoUpload,
    coachCommentPending,
    coachComment,
    evaluation?.summary,
  ]);

  async function handleExport() {
    setError(null);
    setBusy(true);
    try {
      const path = await exportFit();
      if (path) setSavedPath(path);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleStravaUpload() {
    setStravaState({ kind: "uploading" });
    try {
      const result = await uploadLastSessionToStrava({
        description: coachComment ?? evaluation?.summary,
      });
      setStravaState({ kind: "success", activityId: result.activityId });
    } catch (e) {
      setStravaState({ kind: "error", message: String(e) });
    }
  }

  const durationLabel = stats
    ? formatHours(stats.durationSecs)
    : formatDuration(summary.durationSecs);

  const bests = useMemo(() => stats?.bests ?? [], [stats]);

  return (
    <section className="page summary-page">
      <header className="hero hero--compact">
        <p className="eyebrow">Sessione completata</p>
        <h1>Riepilogo</h1>
      </header>

      {records.length > 0 && (
        <div className="record-banner">
          <p className="eyebrow">Nuovi record personali</p>
          <ul className="record-list">
            {records.map((hit) => (
              <li key={`${hit.kind}-${hit.label}`}>
                <strong>{hit.label}</strong>
                <span>{hit.value}</span>
                {hit.previous && <em>prima {hit.previous}</em>}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="summary-grid">
        <div className="summary-stat">
          <span>Durata</span>
          <strong>{durationLabel}</strong>
        </div>
        <div className="summary-stat">
          <span>Tempo in sella</span>
          <strong>{stats ? formatHours(stats.movingSecs) : "—"}</strong>
        </div>
        <div className="summary-stat">
          <span>Distanza</span>
          <strong>{stats ? formatKm(stats.distanceM) : "—"}</strong>
        </div>
        <div className="summary-stat">
          <span>Lavoro</span>
          <strong>{stats ? `${stats.workKj.toFixed(0)} kJ` : "—"}</strong>
        </div>
        <div className="summary-stat">
          <span>Potenza media</span>
          <strong>{summary.avgPower ?? "—"} W</strong>
        </div>
        <div className="summary-stat">
          <span>Potenza max</span>
          <strong>{summary.maxPower ?? "—"} W</strong>
        </div>
        {stats?.avgHeartRate != null && (
          <div className="summary-stat">
            <span>FC media</span>
            <strong>{stats.avgHeartRate} bpm</strong>
          </div>
        )}
      </div>

      {bests.length > 0 && (
        <div className="power-bests">
          <p className="eyebrow">Migliori sforzi — potenza</p>
          <div className="power-bests__grid">
            {bests.map((best) => (
              <div
                key={best.windowSecs}
                className={`power-best ${
                  isPowerRecord(records, best.windowSecs) ? "power-best--record" : ""
                }`}
              >
                <span>{best.label}</span>
                <strong>{best.watts} W</strong>
                {isPowerRecord(records, best.windowSecs) && <em>PB</em>}
              </div>
            ))}
          </div>
        </div>
      )}

      {series.length > 0 && (
        <div className="summary-chart">
          <p className="eyebrow">Andamento sessione</p>
          <SessionSeriesChart series={series} />
        </div>
      )}

      {onSaveFeedback && savedEntry && (
        <div className="eval-card">
          <p className="eyebrow">Come è andata? (RPE 1–10)</p>
          <div className="rpe-picker">
            {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
              <button
                key={n}
                type="button"
                className={rpe === n ? "is-on" : ""}
                title={RPE_LABELS[n]}
                onClick={() => {
                  setRpe(n);
                  setFeedbackSaved(false);
                }}
              >
                {n}
              </button>
            ))}
          </div>
          {rpe != null && (
            <p className="muted-copy">
              {RPE_LABELS[rpe] ?? RPE_LABELS[rpe - 1] ?? ""} · sRPE {Math.round((rpe * (savedEntry.durationSecs ?? summary.durationSecs)) / 60)} UA
            </p>
          )}
          <div className="quick-row">
            {FEELS.map((f) => (
              <button
                key={f}
                type="button"
                className={`chip-toggle${feel === f ? " chip-toggle--on" : ""}`}
                onClick={() => {
                  setFeel(feel === f ? "" : f);
                  setFeedbackSaved(false);
                }}
              >
                {f}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="btn btn--primary btn--small"
            disabled={rpe == null || feedbackSaved}
            onClick={() => {
              if (rpe == null) return;
              void onSaveFeedback(rpe, feel)
                .then(() => setFeedbackSaved(true))
                .catch((e) => setError(String(e)));
            }}
          >
            {feedbackSaved ? "Salvato ✓" : "Salva feedback"}
          </button>
          <p className="muted-copy">Il coach usa RPE e sensazioni per calibrare carico e adattamenti dei prossimi giorni.</p>
        </div>
      )}

      {(evaluation || coachCommentPending || coachComment) && (
        <div className="eval-card">
          <p className="eyebrow">Valutazione coach</p>
          {coachCommentPending && !coachComment && (
            <p className="muted-copy">Commento coach in arrivo…</p>
          )}
          {coachComment && <RichText text={coachComment} className="coach-comment rich-text--prose" />}
          {evaluation && (
            <>
              <h2>
                IF {evaluation.intensityFactor.toFixed(2)} · TSS {evaluation.tss} ·{" "}
                {evaluation.verdict}
              </h2>
              <RichText text={evaluation.summary} className="rich-text--prose" />
              <ul className="eval-recs">
                {evaluation.notes.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
              <div className="zone-grid">
                <ZoneBars title="Zone potenza (Coggan %FTP)" zones={evaluation.powerZones} />
                <ZoneBars title="Zone cardiache (%FCmax stimata)" zones={evaluation.hrZones} />
              </div>
              {evaluation.docs.length > 0 && (
                <div className="eval-docs">
                  {evaluation.docs.slice(0, 2).map((doc) => (
                    <article key={doc.id} className="doc-card">
                      <h3>{doc.title}</h3>
                      <p className="artifact__meta">{doc.source}</p>
                      <RichText text={doc.body} className="rich-text--prose" />
                    </article>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}

      <div className="summary-actions">
        <button
          type="button"
          className="btn btn--primary"
          disabled={busy}
          onClick={() => void handleExport()}
        >
          Salva .fit
        </button>
        {stravaConnected && !stravaAutoUpload && stravaState.kind !== "success" && (
          <button
            type="button"
            className="btn btn--ghost"
            disabled={stravaState.kind === "uploading"}
            onClick={() => void handleStravaUpload()}
          >
            Invia a Strava
          </button>
        )}
        {onOpenLeaderboard && (
          <button type="button" className="btn btn--ghost" onClick={onOpenLeaderboard}>
            Classifica Amaro
          </button>
        )}
        <button type="button" className="btn btn--ghost" onClick={onDone}>
          Nuova sessione
        </button>
      </div>

      {stravaState.kind === "uploading" && (
        <p className="muted-copy">Caricamento su Strava in corso…</p>
      )}
      {stravaState.kind === "success" && (
        <p className="success-banner">
          Caricato su Strava (attività #{stravaState.activityId})
        </p>
      )}
      {stravaState.kind === "error" && (
        <p className="error-banner">{stravaState.message}</p>
      )}

      {savedPath && <p className="success-banner">Salvato: {savedPath}</p>}
      {error && <p className="error-banner">{error}</p>}
    </section>
  );
}
