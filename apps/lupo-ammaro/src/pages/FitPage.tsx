import { useEffect, useRef, useState } from "react";
import { getProfile } from "../hooks/useStorage";
import {
  defaultFitProfile,
  loadFitProfile,
  loadFitSessions,
  saveFitProfile,
  saveFitSession,
  updateFitSession,
} from "../lib/fitStore";
import { runFitAnalysis } from "../lib/fit/analyzeVideo";
import type { FrameLandmarks } from "../lib/fit/cycles";
import { FitVideoReview } from "../components/FitVideoReview";
import { hasActiveRedFlags, painHints, trafficLight } from "../lib/fit/rules";
import type {
  FitPainEntry,
  FitProfile,
  FitSession,
  PainSite,
} from "../lib/fit/types";
import { newId } from "../hooks/useStorage";
import "../styles/fit.css";

type FitTab = "intake" | "video" | "report" | "history";

const PAIN_SITES: { id: PainSite; label: string }[] = [
  { id: "knee_anterior", label: "Ginocchio anteriore" },
  { id: "knee_posterior", label: "Ginocchio posteriore" },
  { id: "knee_lateral", label: "Ginocchio laterale" },
  { id: "low_back", label: "Schiena bassa" },
  { id: "neck_shoulders", label: "Collo / spalle" },
  { id: "hands_wrists", label: "Mani / polsi" },
  { id: "feet", label: "Piedi" },
  { id: "saddle_area", label: "Zona sella" },
  { id: "other", label: "Altro" },
];

interface FitPageProps {
  heightCm: number;
}

export function FitPage({ heightCm }: FitPageProps) {
  const [tab, setTab] = useState<FitTab>("intake");
  const [profile, setProfile] = useState<FitProfile>(defaultFitProfile());
  const [sessions, setSessions] = useState<FitSession[]>([]);
  const [currentSession, setCurrentSession] = useState<FitSession | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [review, setReview] = useState<{ sessionId: string; frames: FrameLandmarks[] } | null>(
    null,
  );
  const [confirmMm, setConfirmMm] = useState("");

  useEffect(() => {
    void loadFitProfile().then(setProfile);
    void loadFitSessions().then(setSessions);
  }, []);

  async function handleSaveProfile() {
    setError(null);
    try {
      await saveFitProfile(profile);
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setError(String(e));
    }
  }

  function updateRedFlag(key: keyof FitProfile["redFlags"], value: boolean) {
    setProfile((p) => ({
      ...p,
      redFlags: { ...p.redFlags, [key]: value },
    }));
  }

  function addPain() {
    const entry: FitPainEntry = {
      id: newId(),
      site: "knee_anterior",
      intensity: 5,
      side: "both",
    };
    setProfile((p) => ({ ...p, pains: [...p.pains, entry] }));
  }

  function updatePain(id: string, patch: Partial<FitPainEntry>) {
    setProfile((p) => ({
      ...p,
      pains: p.pains.map((x) => (x.id === id ? { ...x, ...patch } : x)),
    }));
  }

  function removePain(id: string) {
    setProfile((p) => ({ ...p, pains: p.pains.filter((x) => x.id !== id) }));
  }

  async function handleVideoFile(file: File) {
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    const url = URL.createObjectURL(file);
    setVideoUrl(url);
    setCurrentSession(null);
    setReview(null);
    setError(null);
  }

  async function handleAnalyze() {
    const video = videoRef.current;
    if (!video || !videoUrl) {
      setError("Carica un video laterale prima di analizzare.");
      return;
    }
    if (!profile.healthConsent) {
      setError("Accetta il consenso sul trattamento dei dati di salute.");
      setTab("intake");
      return;
    }
    setAnalyzing(true);
    setError(null);
    setStatus(null);
    try {
      await video.play().catch(() => undefined);
      video.pause();
      const h = heightCm > 0 ? heightCm : (await getProfile()).heightCm;
      const { session, frames } = await runFitAnalysis(
        video,
        profile,
        h,
        "lateral_left",
        "Video laterale",
        setStatus,
      );
      setReview({ sessionId: session.id, frames });
      await saveFitSession(session);
      setSessions(await loadFitSessions());
      setCurrentSession(session);
      setTab("report");
    } catch (e) {
      setError(String(e));
    } finally {
      setAnalyzing(false);
      setStatus(null);
    }
  }

  async function handleConfirmSaddle() {
    if (!currentSession) return;
    const mm = Number(confirmMm);
    if (!Number.isFinite(mm) || mm <= 0) {
      setError("Inserisci l'altezza sella misurata con il metro (mm).");
      return;
    }
    const updated = await updateFitSession(currentSession.id, {
      confirmedSaddleHeightMm: mm,
    });
    if (updated) {
      setCurrentSession(updated);
      setProfile((p) => ({
        ...p,
        bike: { ...p.bike, saddleHeightMm: mm },
      }));
      await saveFitProfile({
        ...profile,
        bike: { ...profile.bike, saddleHeightMm: mm },
      });
      setConfirmMm("");
      setSessions(await loadFitSessions());
    }
  }

  const hints = painHints(profile.pains);
  const redActive = hasActiveRedFlags(profile.redFlags);
  const report = currentSession ?? sessions[0] ?? null;
  const prev = sessions.length > 1 ? sessions[1] : null;
  const kneeSpread = report?.metrics.kneeRangeDeg;

  return (
    <section className="page fit-page">
      <header className="hero hero--compact">
        <p className="eyebrow">Posizione</p>
        <h1>Bike fit</h1>
        <p className="hero__copy">
          Video sul rullo, analisi in locale. Indicazioni di fit, non diagnosi medica.
          Margine di errore tipico ±4° sul ginocchio (circa 6–12 mm sulla sella).
        </p>
      </header>

      <div className="fit-tabs">
        {(
          [
            ["intake", "Anamnesi"],
            ["video", "Video"],
            ["report", "Report"],
            ["history", "Storico"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            className={`fit-tabs__btn ${tab === id ? "fit-tabs__btn--active" : ""}`}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>

      {error && <p className="fit-alert fit-alert--error">{error}</p>}
      {redActive && (
        <p className="fit-alert fit-alert--warn">
          Segnali di allarme attivi: sospendi le modifiche di assetto e consulta un medico.
        </p>
      )}

      {tab === "intake" && (
        <div className="fit-panel">
          <h2>Anamnesi e bici</h2>
          <div className="fit-grid">
            <label>
              Disciplina
              <select
                value={profile.discipline}
                onChange={(e) =>
                  setProfile({ ...profile, discipline: e.target.value as FitProfile["discipline"] })
                }
              >
                <option value="road">Strada</option>
                <option value="gravel">Gravel</option>
                <option value="mtb">MTB</option>
                <option value="tt">Crono / TT</option>
                <option value="indoor">Indoor</option>
              </select>
            </label>
            <label>
              Livello
              <select
                value={profile.level}
                onChange={(e) =>
                  setProfile({ ...profile, level: e.target.value as FitProfile["level"] })
                }
              >
                <option value="beginner">Principiante</option>
                <option value="recreational">Amatoriale</option>
                <option value="competitive">Competitivo</option>
              </select>
            </label>
            <label>
              Obiettivo
              <select
                value={profile.goal}
                onChange={(e) =>
                  setProfile({ ...profile, goal: e.target.value as FitProfile["goal"] })
                }
              >
                <option value="comfort">Comfort</option>
                <option value="performance">Performance</option>
                <option value="aero">Aerodinamica</option>
              </select>
            </label>
            <label>
              Ore settimanali
              <input
                type="number"
                min={0}
                value={profile.weeklyHours ?? ""}
                onChange={(e) =>
                  setProfile({
                    ...profile,
                    weeklyHours: e.target.value ? Number(e.target.value) : undefined,
                  })
                }
              />
            </label>
          </div>

          <h3>Misure (mm)</h3>
          <div className="fit-grid">
            <label>
              Inseam (pubis–pavimento)
              <input
                type="number"
                value={profile.anthropometry.inseamMm ?? ""}
                onChange={(e) =>
                  setProfile({
                    ...profile,
                    anthropometry: {
                      ...profile.anthropometry,
                      inseamMm: e.target.value ? Number(e.target.value) : undefined,
                    },
                  })
                }
              />
            </label>
            <label>
              Femore
              <input
                type="number"
                value={profile.anthropometry.femurMm ?? ""}
                onChange={(e) =>
                  setProfile({
                    ...profile,
                    anthropometry: {
                      ...profile.anthropometry,
                      femurMm: e.target.value ? Number(e.target.value) : undefined,
                    },
                  })
                }
              />
            </label>
            <label>
              Tibia
              <input
                type="number"
                value={profile.anthropometry.tibiaMm ?? ""}
                onChange={(e) =>
                  setProfile({
                    ...profile,
                    anthropometry: {
                      ...profile.anthropometry,
                      tibiaMm: e.target.value ? Number(e.target.value) : undefined,
                    },
                  })
                }
              />
            </label>
          </div>

          <h3>Bici attuale</h3>
          <div className="fit-grid">
            <label>
              Altezza sella (mm, BB → piano sella)
              <input
                type="number"
                value={profile.bike.saddleHeightMm ?? ""}
                onChange={(e) =>
                  setProfile({
                    ...profile,
                    bike: {
                      ...profile.bike,
                      saddleHeightMm: e.target.value ? Number(e.target.value) : undefined,
                    },
                  })
                }
              />
            </label>
            <label>
              Arretramento sella (mm)
              <input
                type="number"
                value={profile.bike.saddleSetbackMm ?? ""}
                onChange={(e) =>
                  setProfile({
                    ...profile,
                    bike: {
                      ...profile.bike,
                      saddleSetbackMm: e.target.value ? Number(e.target.value) : undefined,
                    },
                  })
                }
              />
            </label>
            <label>
              Lunghezza pedivelle (mm)
              <input
                type="number"
                value={profile.bike.crankLengthMm ?? ""}
                onChange={(e) =>
                  setProfile({
                    ...profile,
                    bike: {
                      ...profile.bike,
                      crankLengthMm: e.target.value ? Number(e.target.value) : undefined,
                    },
                  })
                }
              />
            </label>
          </div>

          <h3>Dolori</h3>
          {profile.pains.map((p) => (
            <div key={p.id} className="fit-pain-row">
              <select
                value={p.site}
                onChange={(e) => updatePain(p.id, { site: e.target.value as PainSite })}
              >
                {PAIN_SITES.map((s) => (
                  <option key={s.id} value={s.id}>{s.label}</option>
                ))}
              </select>
              <input
                type="number"
                min={0}
                max={10}
                title="Intensità 0–10"
                value={p.intensity}
                onChange={(e) => updatePain(p.id, { intensity: Number(e.target.value) })}
              />
              <button type="button" className="btn-ghost" onClick={() => removePain(p.id)}>
                Rimuovi
              </button>
            </div>
          ))}
          <button type="button" className="btn-secondary" onClick={addPain}>
            Aggiungi dolore
          </button>
          {hints.length > 0 && (
            <ul className="fit-hints">
              {hints.map((h) => (
                <li key={h}>{h}</li>
              ))}
            </ul>
          )}

          <h3>Segnali di allarme</h3>
          <div className="fit-checks">
            {(
              [
                ["acuteOrWorseningPain", "Dolore acuto o in peggioramento"],
                ["persistentNumbness", "Formicolio persistente"],
                ["swelling", "Gonfiore"],
                ["nightPain", "Dolore notturno"],
                ["recentSurgery", "Intervento recente"],
              ] as const
            ).map(([key, label]) => (
              <label key={key} className="fit-check">
                <input
                  type="checkbox"
                  checked={profile.redFlags[key]}
                  onChange={(e) => updateRedFlag(key, e.target.checked)}
                />
                {label}
              </label>
            ))}
          </div>

          <label className="fit-consent">
            <input
              type="checkbox"
              checked={profile.healthConsent}
              onChange={(e) =>
                setProfile({
                  ...profile,
                  healthConsent: e.target.checked,
                  consentAt: e.target.checked ? new Date().toISOString() : undefined,
                })
              }
            />
            Acconsento al trattamento locale di video e dati sul dolore (GDPR). I file non
            vengono inviati al server Amaro.
          </label>

          <button type="button" className="btn-primary" onClick={() => void handleSaveProfile()}>
            Salva anamnesi
          </button>
          {saved && <p className="muted-copy">Salvato.</p>}
        </div>
      )}

      {tab === "video" && (
        <div className="fit-panel">
          <h2>Video laterale (MVP)</h2>
          <ol className="fit-protocol">
            <li>Bici sul rullo, assi in bolla, 2–3 min di riscaldamento.</li>
            <li>Camera su treppiede, orizzontale, 2–3 m, altezza sella, lente normale.</li>
            <li>15–20 s di pedalata costante, corpo intero in quadro, abiti aderenti.</li>
            <li>Segna sul pavimento posizione bici e camera per i confronti successivi.</li>
          </ol>
          <input
            type="file"
            accept="video/*"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void handleVideoFile(f);
            }}
          />
          {videoUrl && (
            <video
              ref={videoRef}
              src={videoUrl}
              className={`fit-video${analyzing ? " fit-video--busy" : ""}`}
              controls={!analyzing}
              playsInline
            />
          )}
          {status && <p className="muted-copy">{status}</p>}
          <button
            type="button"
            className="btn-primary"
            disabled={analyzing || !videoUrl}
            onClick={() => void handleAnalyze()}
          >
            {analyzing ? "Analisi in corso…" : "Analizza video"}
          </button>
        </div>
      )}

      {tab === "report" && (
        <div className="fit-panel">
          {!report ? (
            <p className="muted-copy">Nessun report. Carica e analizza un video.</p>
          ) : (
            <>
              <div
                className={`fit-semaphore fit-semaphore--${trafficLight(
                  report.metrics.kneeFlexionBdcDeg,
                  report.saddle.targetMinDeg,
                  report.saddle.targetMaxDeg,
                )}`}
              >
                <span className="fit-semaphore__value">
                  {Number.isFinite(report.metrics.kneeFlexionBdcDeg)
                    ? `${report.metrics.kneeFlexionBdcDeg.toFixed(1)}°`
                    : "—"}
                </span>
                <span className="fit-semaphore__label">
                  Flessione ginocchio al BDC (fascia {report.saddle.targetMinDeg}–
                  {report.saddle.targetMaxDeg}°)
                </span>
              </div>
              {review && review.sessionId === report.id && videoUrl && (
                <FitVideoReview
                  src={videoUrl}
                  frames={review.frames}
                  meanFlexionDeg={report.metrics.kneeFlexionBdcDeg}
                />
              )}
              <p className="fit-summary">{report.saddle.summary}</p>
              {!report.qc.ok && (
                <ul className="fit-qc">
                  {report.qc.issues.map((i) => (
                    <li key={i}>{i}</li>
                  ))}
                </ul>
              )}
              <p className="muted-copy">
                Cicli usati: {report.metrics.cyclesUsed} · Lato:{" "}
                {report.metrics.side === "left" ? "sinistro" : "destro"} · Frame:{" "}
                {report.qc.framesAnalyzed}
                {kneeSpread != null &&
                  Number.isFinite(kneeSpread) &&
                  ` · dispersione tra i cicli ±${(kneeSpread / 2).toFixed(1)}°`}
              </p>

              {prev && Number.isFinite(prev.metrics.kneeFlexionBdcDeg) && (
                <div className="fit-compare">
                  <h3>Confronto con sessione precedente</h3>
                  <p>
                    Prima: {prev.metrics.kneeFlexionBdcDeg.toFixed(1)}° → Ora:{" "}
                    {report.metrics.kneeFlexionBdcDeg.toFixed(1)}° (
                    {(report.metrics.kneeFlexionBdcDeg - prev.metrics.kneeFlexionBdcDeg).toFixed(
                      1,
                    )}
                    °)
                  </p>
                  {prev.confirmedSaddleHeightMm != null && (
                    <p>
                      Sella confermata prima: {prev.confirmedSaddleHeightMm} mm
                      {report.confirmedSaddleHeightMm != null &&
                        ` · ora: ${report.confirmedSaddleHeightMm} mm`}
                    </p>
                  )}
                </div>
              )}

              <h3>Conferma con il metro</h3>
              <p className="muted-copy">
                Dopo ogni modifica, misura l&apos;altezza sella (BB → piano sella) e registrala qui.
              </p>
              <div className="fit-confirm-row">
                <input
                  type="number"
                  placeholder="Altezza sella mm"
                  value={confirmMm}
                  onChange={(e) => setConfirmMm(e.target.value)}
                />
                <button type="button" className="btn-secondary" onClick={() => void handleConfirmSaddle()}>
                  Salva misura
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {tab === "history" && (
        <div className="fit-panel">
          <h2>Storico fit</h2>
          {sessions.length === 0 ? (
            <p className="muted-copy">Nessuna sessione salvata.</p>
          ) : (
            <table className="fit-table">
              <thead>
                <tr>
                  <th>Data</th>
                  <th>Ginocchio BDC</th>
                  <th>Sella (metro)</th>
                  <th>Azione</th>
                </tr>
              </thead>
              <tbody>
                {sessions.map((s) => (
                  <tr key={s.id}>
                    <td>{new Date(s.createdAt).toLocaleString()}</td>
                    <td>
                      {Number.isFinite(s.metrics.kneeFlexionBdcDeg)
                        ? `${s.metrics.kneeFlexionBdcDeg.toFixed(1)}°`
                        : "—"}
                    </td>
                    <td>{s.confirmedSaddleHeightMm ?? profile.bike.saddleHeightMm ?? "—"}</td>
                    <td>
                      <button
                        type="button"
                        className="btn-ghost"
                        onClick={() => {
                          setCurrentSession(s);
                          setTab("report");
                        }}
                      >
                        Apri
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </section>
  );
}
