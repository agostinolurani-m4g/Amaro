import { useEffect, useState } from "react";
import { getProfile, saveProfile } from "../hooks/useStorage";
import {
  connectStrava,
  disconnectStrava,
  getStravaStatus,
  setStravaAutoUpload,
} from "../hooks/useStrava";
import { syncStrava } from "../lib/stravaSync";
import { amaroJson } from "../lib/amaroAuth";
import type { StravaStatus } from "../hooks/useStrava";
import type { AmaroMember, UserProfile } from "../types";

interface ProfilePageProps {
  member?: AmaroMember;
  onLogout?: () => void;
}

export function ProfilePage({ member, onLogout }: ProfilePageProps) {
  const [profile, setProfile] = useState<UserProfile>({
    name: "",
    heightCm: 175,
    weightKg: 70,
    ftpWatts: 200,
  });
  const [stravaStatus, setStravaStatus] = useState<StravaStatus | null>(null);
  const [saved, setSaved] = useState(false);
  const [stravaBusy, setStravaBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stravaError, setStravaError] = useState<string | null>(null);
  const [syncNote, setSyncNote] = useState<string | null>(null);

  useEffect(() => {
    void Promise.all([getProfile(), getStravaStatus()])
      .then(([loadedProfile, status]) => {
        setProfile(loadedProfile);
        setStravaStatus(status);
      })
      .catch((e) => setError(String(e)));
  }, []);

  async function handleSave() {
    setError(null);
    try {
      await saveProfile(profile);
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setError(String(e));
    }
  }

  async function handleConnectStrava() {
    setStravaError(null);
    setStravaBusy(true);
    try {
      const status = await connectStrava();
      setStravaStatus(status);
    } catch (e) {
      setStravaError(String(e));
    } finally {
      setStravaBusy(false);
    }
  }

  async function handleDisconnectStrava() {
    setStravaError(null);
    setStravaBusy(true);
    try {
      const status = await disconnectStrava();
      setStravaStatus(status);
    } catch (e) {
      setStravaError(String(e));
    } finally {
      setStravaBusy(false);
    }
  }

  async function handleToggleAutoUpload(enabled: boolean) {
    setStravaError(null);
    try {
      const status = await setStravaAutoUpload(enabled);
      setStravaStatus(status);
    } catch (e) {
      setStravaError(String(e));
    }
  }

  return (
    <section className="page profile-page">
      <header className="hero hero--compact">
        <p className="eyebrow">Impostazioni</p>
        <h1>Profilo</h1>
        <p className="hero__copy">
          Altezza, peso e FTP servono per calcolare i target degli allenamenti strutturati.
        </p>
        {member && (
          <p className="muted-copy">
            Accesso tesserato: {member.email}
          </p>
        )}
      </header>

      <div className="form-panel">
        <label className="form-row">
          <span>Nome</span>
          <input
            type="text"
            value={profile.name}
            onChange={(e) => setProfile({ ...profile, name: e.target.value })}
            placeholder="Il tuo nome"
          />
        </label>

        <label className="form-row">
          <span>Altezza (cm)</span>
          <input
            type="number"
            min={120}
            max={230}
            value={profile.heightCm}
            onChange={(e) =>
              setProfile({ ...profile, heightCm: Number(e.target.value) })
            }
          />
        </label>

        <label className="form-row">
          <span>Peso (kg)</span>
          <input
            type="number"
            min={30}
            max={200}
            step={0.1}
            value={profile.weightKg}
            onChange={(e) =>
              setProfile({ ...profile, weightKg: Number(e.target.value) })
            }
          />
        </label>

        <label className="form-row">
          <span>FTP (W)</span>
          <input
            type="number"
            min={50}
            max={500}
            step={5}
            value={profile.ftpWatts}
            onChange={(e) =>
              setProfile({ ...profile, ftpWatts: Number(e.target.value) })
            }
          />
        </label>

        <label className="form-row">
          <span>Sesso</span>
          <select
            value={profile.sex ?? ""}
            onChange={(e) => setProfile({ ...profile, sex: (e.target.value || undefined) as UserProfile["sex"] })}
          >
            <option value="">Non indicato</option>
            <option value="m">Uomo</option>
            <option value="f">Donna</option>
          </select>
        </label>

        {(
          [
            ["birthYear", "Anno di nascita", 1930, 2020],
            ["hrMax", "FC massima (bpm)", 120, 230],
            ["hrRest", "FC a riposo (bpm)", 30, 100],
            ["lthr", "FC di soglia LTHR bici (bpm)", 100, 210],
            ["lthrRun", "FC di soglia corsa (bpm)", 100, 220],
          ] as const
        ).map(([key, label, min, max]) => (
          <label key={key} className="form-row">
            <span>{label}</span>
            <input
              type="number"
              min={min}
              max={max}
              value={profile[key] ?? ""}
              placeholder="opzionale"
              onChange={(e) => setProfile({ ...profile, [key]: e.target.value ? Number(e.target.value) : undefined })}
            />
          </label>
        ))}
        <p className="muted-copy">
          LTHR = FC media degli ultimi 20' di un test di 30' da solo. Serve per zone FC e TSS da frequenza cardiaca. I test del
          lattato si inseriscono nel Laboratorio.
        </p>

        <div className="profile-stats">
          <div className="summary-stat">
            <span>W/kg</span>
            <strong>{(profile.ftpWatts / profile.weightKg).toFixed(2)}</strong>
          </div>
          <div className="summary-stat">
            <span>BMI</span>
            <strong>
              {(
                profile.weightKg /
                Math.pow(profile.heightCm / 100, 2)
              ).toFixed(1)}
            </strong>
          </div>
        </div>

        <button type="button" className="btn btn--primary" onClick={() => void handleSave()}>
          Salva profilo
        </button>
        {onLogout && (
          <button type="button" className="btn btn--ghost" onClick={onLogout}>
            Esci dall&apos;account
          </button>
        )}
        {saved && <p className="success-banner">Profilo salvato</p>}
        {error && <p className="error-banner">{error}</p>}
      </div>

      <div className="form-panel integration-panel">
        <h2>Strava</h2>
        <p className="muted-copy">
          Collega Strava per caricare le sessioni indoor e leggere strada, MTB e corsa nel calendario e nel coach.
        </p>

        <div className="integration-actions">
          {stravaStatus?.connected ? (
            <>
              <button type="button" className="btn btn--ghost" disabled={stravaBusy} onClick={() => void handleDisconnectStrava()}>
                Disconnetti
              </button>
              {!stravaStatus.canRead && (
                <button type="button" className="btn btn--primary" disabled={stravaBusy} onClick={() => void handleConnectStrava()}>
                  Ricollega per la lettura
                </button>
              )}
              {stravaStatus.canRead && (
                <button
                  type="button"
                  className="btn btn--primary"
                  disabled={stravaBusy}
                  onClick={() => {
                    setStravaBusy(true);
                    setSyncNote(null);
                    void syncStrava({ force: true, onProgress: setSyncNote })
                      .then(async (r) => {
                        setSyncNote(`Importate ${r.imported} attività.${r.note ? ` ${r.note}` : ""}`);
                        setStravaStatus(await getStravaStatus());
                      })
                      .catch((e) => setStravaError(String(e)))
                      .finally(() => setStravaBusy(false));
                  }}
                >
                  {stravaBusy ? "Sincronizzo…" : "Sincronizza ora"}
                </button>
              )}
            </>
          ) : (
            <button
              type="button"
              className="btn btn--primary"
              disabled={stravaBusy || stravaStatus?.configured === false}
              onClick={() => void handleConnectStrava()}
            >
              {stravaBusy ? "In attesa di autorizzazione…" : "Collega Strava"}
            </button>
          )}
        </div>

        {stravaStatus?.connected && !stravaStatus.canRead && (
          <p className="error-banner">
            Strava è collegato solo in scrittura. Premi «Ricollega per la lettura» e autorizza le attività.
          </p>
        )}

        {stravaStatus?.canRead && (
          <button
            type="button"
            className="btn btn--ghost btn--small"
            disabled={stravaBusy}
            onClick={() => {
              setStravaBusy(true);
              void amaroJson<{ athlete?: { weight?: number; ftp?: number } }>("/api/wattlab/strava/athlete")
                .then((data) => {
                  const w = data.athlete?.weight;
                  const ftp = data.athlete?.ftp;
                  const next = { ...profile };
                  const notes: string[] = [];
                  if (w && w > 30 && (profile.weightKg === 70 || !profile.weightKg)) {
                    next.weightKg = Math.round(w * 10) / 10;
                    notes.push(`peso ${next.weightKg} kg`);
                  } else if (w && Math.abs(w - profile.weightKg) >= 1 && window.confirm(`Strava indica ${w} kg. Sostituire ${profile.weightKg} kg?`)) {
                    next.weightKg = Math.round(w * 10) / 10;
                    notes.push(`peso ${next.weightKg} kg`);
                  }
                  if (ftp && ftp > 50 && (profile.ftpWatts === 200 || !profile.ftpWatts)) {
                    next.ftpWatts = ftp;
                    notes.push(`FTP ${ftp} W`);
                  } else if (ftp && ftp !== profile.ftpWatts && window.confirm(`Strava indica FTP ${ftp} W. Sostituire ${profile.ftpWatts} W?`)) {
                    next.ftpWatts = ftp;
                    notes.push(`FTP ${ftp} W`);
                  }
                  setProfile(next);
                  setSyncNote(notes.length ? `Da Strava: ${notes.join(", ")}. Premi Salva profilo.` : "Nessun dato nuovo da Strava.");
                })
                .catch((e) => setStravaError(String(e)))
                .finally(() => setStravaBusy(false));
            }}
          >
            Importa peso e FTP da Strava
          </button>
        )}

        {stravaStatus?.configured === false && (
          <p className="error-banner">
            Strava non è ancora configurato sul server Amaro. Contatta la segreteria.
          </p>
        )}

        {stravaStatus?.connected && (
          <label className="form-row form-row--checkbox">
            <input
              type="checkbox"
              checked={stravaStatus.autoUpload}
              onChange={(e) => void handleToggleAutoUpload(e.target.checked)}
            />
            <span>Carica automaticamente a fine sessione</span>
          </label>
        )}

        {stravaStatus?.connected && stravaStatus.athleteId && (
          <p className="success-banner">Collegato come atleta #{stravaStatus.athleteId}</p>
        )}
        {syncNote && <p className="success-banner">{syncNote}</p>}
        {stravaError && <p className="error-banner">{stravaError}</p>}
      </div>
    </section>
  );
}
