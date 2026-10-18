import { useEffect, useMemo, useState } from "react";
import { getPersonalRecords, getProfile, listCalendar, saveProfile, todayIso } from "../hooks/useStorage";
import { CoachChart } from "../components/CoachChart";
import { emptyPersonalRecords } from "../lib/sessionStats";
import { athleteModel, fuelingPlan, lactateAfter, substrateAt } from "../../shared/engine/physiology.mjs";
import type { CalendarEntry, CoachChartData, LactateTestPoint, PersonalRecords, UserProfile } from "../types";

function Confidence({ level }: { level: string }) {
  return <span className={`confidence confidence--${level}`}>{level}</span>;
}

export function LabPage() {
  const today = todayIso();
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [entries, setEntries] = useState<CalendarEntry[]>([]);
  const [records, setRecords] = useState<PersonalRecords>(emptyPersonalRecords());
  const [draft, setDraft] = useState({ watts: "", mmol: "", hr: "", date: today });
  const [simWatts, setSimWatts] = useState(200);
  const [simMin, setSimMin] = useState(60);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void Promise.all([getProfile(), listCalendar().catch(() => []), getPersonalRecords().catch(() => emptyPersonalRecords())]).then(
      ([p, cal, rec]) => {
        setProfile(p);
        setEntries(cal.filter((e) => e.entryType !== "planned"));
        setRecords(rec);
      },
    );
  }, []);

  const model = useMemo(() => (profile ? athleteModel(profile, entries, { records, today }) : null), [profile, entries, records, today]);
  const tests = profile?.lactateTests ?? [];

  const lactateChart: CoachChartData | null = useMemo(() => {
    if (!model) return null;
    const curve = model.curve.filter((p) => p.lactate <= 14);
    const measured = curve.map(() => null as number | null);
    for (const t of tests) {
      let best = 0;
      curve.forEach((p, i) => {
        if (Math.abs(p.watts - t.watts) < Math.abs(curve[best].watts - t.watts)) best = i;
      });
      if (curve[best] && Math.abs(curve[best].watts - t.watts) <= 10) measured[best] = t.mmol;
    }
    return {
      kind: "lactate",
      title: `Curva lattato ${model.calibration ? "calibrata sui tuoi test" : "modellata (Mader)"}`,
      x: curve.map((p) => p.watts),
      yLabel: "mmol/l · g/h ÷ 10 (x = watt)",
      series: [
        { label: "Lattato mmol/l", data: curve.map((p) => p.lactate), color: "#ff0a54" },
        ...(tests.length ? [{ label: "Test misurato", data: measured, color: "#ffffff" }] : []),
        { label: "CHO g/h ÷10", data: curve.map((p) => Math.round(p.choGh) / 10), color: "#facc15" },
        { label: "Grassi g/h ÷10", data: curve.map((p) => Math.round(p.fatGh * 10) / 100), color: "#4ade80" },
      ],
    };
  }, [model, tests]);

  async function persistTests(next: LactateTestPoint[]) {
    if (!profile) return;
    setSaving(true);
    try {
      const updated = { ...profile, lactateTests: next };
      await saveProfile(updated);
      setProfile(updated);
    } finally {
      setSaving(false);
    }
  }

  function addPoint() {
    const watts = Number(draft.watts);
    const mmol = Number(String(draft.mmol).replace(",", "."));
    if (!(watts > 0) || !(mmol > 0)) return;
    const point: LactateTestPoint = { watts: Math.round(watts), mmol: Math.round(mmol * 10) / 10, date: draft.date || today };
    if (Number(draft.hr) > 0) point.hr = Math.round(Number(draft.hr));
    const next = [...tests, point].sort((a, b) => (a.date ?? "").localeCompare(b.date ?? "") || a.watts - b.watts);
    void persistTests(next);
    setDraft({ watts: "", mmol: "", hr: "", date: draft.date });
  }

  if (!profile || !model) {
    return (
      <section className="page">
        <p className="muted-copy">Caricamento modello fisiologico…</p>
      </section>
    );
  }

  const sim = {
    lactate: lactateAfter(simWatts, simMin * 60, model.params),
    sub: substrateAt(simWatts, model.params),
    fuel: fuelingPlan(model, { durationMin: simMin, avgWatts: simWatts }),
  };

  return (
    <section className="page lab-page">
      <header className="hero hero--compact">
        <p className="eyebrow">Fisiologia</p>
        <h1>Laboratorio</h1>
        <p className="muted-copy">
          Stime indirette dai tuoi dati di potenza ({entries.length} sessioni). Con un test del lattato reale la curva viene calibrata.
        </p>
      </header>

      <div className="metrics-grid">
        <div className="metric metric--accent">
          <span className="metric__label">FTP</span>
          <strong className="metric__value">{model.ftp} W</strong>
          <span className="muted-copy">
            {(model.ftp / model.weightKg).toFixed(2)} W/kg{model.ftpEstimated ? ` · dati ${model.ftpEstimated} W` : ""}
          </span>
        </div>
        <div className="metric">
          <span className="metric__label">
            CP / W' <Confidence level={model.confidence.cp} />
          </span>
          <strong className="metric__value">{model.cp} W</strong>
          <span className="muted-copy">W' {(model.wPrime / 1000).toFixed(1)} kJ</span>
        </div>
        <div className="metric">
          <span className="metric__label">
            VO2max <Confidence level={model.confidence.vo2max} />
          </span>
          <strong className="metric__value">{model.vo2max}</strong>
          <span className="muted-copy">ml/kg/min · MAP {model.mapWatts} W</span>
        </div>
        <div className="metric">
          <span className="metric__label">
            VLamax <Confidence level={model.confidence.vlamax} />
          </span>
          <strong className="metric__value">{model.vlamax}</strong>
          <span className="muted-copy">mmol/l/s</span>
        </div>
        <div className="metric">
          <span className="metric__label">
            LT1 · LT2 <Confidence level={model.confidence.lactate} />
          </span>
          <strong className="metric__value">
            {model.lt1} · {model.lt2} W
          </strong>
          <span className="muted-copy">MLSS {model.mlss} W</span>
        </div>
        <div className="metric">
          <span className="metric__label">FatMax</span>
          <strong className="metric__value">{model.fatMax.watts} W</strong>
          <span className="muted-copy">{model.fatMax.fatGh} g/h di grassi</span>
        </div>
        <div className="metric">
          <span className="metric__label">Pmax</span>
          <strong className="metric__value">{model.pmax ?? "–"} W</strong>
        </div>
      </div>

      {model.warnings.length > 0 && (
        <ul className="warning-list">
          {model.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}

      <div className="panel">{lactateChart && <CoachChart chart={lactateChart} height={300} />}</div>

      <div className="panel-grid">
        <div className="panel">
          <h3>Zone di potenza (Coggan)</h3>
          <table className="zone-table">
            <tbody>
              {model.zones.coggan.map((z) => (
                <tr key={z.label}>
                  <td>{z.label}</td>
                  <td>{z.pct}</td>
                  <td>
                    {z.fromW}–{z.toW ?? "max"} W
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="panel">
          <h3>Modello a 3 zone (soglie lattato)</h3>
          <table className="zone-table">
            <tbody>
              {model.zones.three.map((z) => (
                <tr key={z.label}>
                  <td>{z.label}</td>
                  <td>
                    {z.fromW}–{z.toW ?? "max"} W
                  </td>
                  <td className="muted-copy">{z.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {model.zones.hr.length > 0 && (
            <>
              <h3 style={{ marginTop: 14 }}>Zone FC (LTHR {profile.lthr})</h3>
              <table className="zone-table">
                <tbody>
                  {model.zones.hr.map((z) => (
                    <tr key={z.label}>
                      <td>{z.label}</td>
                      <td>
                        {z.fromBpm}–{z.toBpm ?? "max"} bpm
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </div>
      </div>

      <div className="panel-grid">
        <div className="panel">
          <h3>Test del lattato</h3>
          <p className="muted-copy">
            Protocollo: step da 4' (+20–30 W), prelievo a fine step. Servono almeno 3 punti, idealmente da sotto LT1 a sopra LT2.
          </p>
          <div className="lab-form">
            <label>
              Watt
              <input type="number" value={draft.watts} onChange={(e) => setDraft({ ...draft, watts: e.target.value })} />
            </label>
            <label>
              mmol/l
              <input type="text" inputMode="decimal" value={draft.mmol} onChange={(e) => setDraft({ ...draft, mmol: e.target.value })} />
            </label>
            <label>
              FC
              <input type="number" value={draft.hr} onChange={(e) => setDraft({ ...draft, hr: e.target.value })} />
            </label>
            <label>
              Data
              <input type="date" value={draft.date} onChange={(e) => setDraft({ ...draft, date: e.target.value })} />
            </label>
            <button type="button" className="btn btn--primary btn--small" disabled={saving} onClick={addPoint}>
              Aggiungi
            </button>
          </div>
          {tests.length > 0 && (
            <table className="zone-table">
              <tbody>
                {tests.map((t, i) => (
                  <tr key={`${t.date}-${t.watts}-${i}`}>
                    <td>{t.date ?? "–"}</td>
                    <td>{t.watts} W</td>
                    <td>{t.mmol} mmol/l</td>
                    <td>{t.hr ? `${t.hr} bpm` : ""}</td>
                    <td className="muted-copy">modello {lactateAfter(t.watts, 240, model.params).toFixed(1)}</td>
                    <td>
                      <button type="button" className="btn btn--ghost btn--small" onClick={() => void persistTests(tests.filter((_, k) => k !== i))}>
                        ✕
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {model.calibration && (
            <p className="muted-copy">
              Calibrazione su {model.calibration.points} punti · errore medio {model.calibration.rmse} mmol/l
            </p>
          )}
        </div>

        <div className="panel">
          <h3>Simulatore intensità</h3>
          <div className="lab-form">
            <label>
              Watt
              <input type="number" value={simWatts} onChange={(e) => setSimWatts(Math.max(30, Number(e.target.value) || 0))} />
            </label>
            <label>
              Minuti
              <input type="number" value={simMin} onChange={(e) => setSimMin(Math.max(1, Number(e.target.value) || 0))} />
            </label>
          </div>
          <dl className="kv-list">
            <dt>% FTP</dt>
            <dd>{Math.round((simWatts / model.ftp) * 100)}%</dd>
            <dt>Lattato stimato</dt>
            <dd>{sim.lactate.toFixed(1)} mmol/l{simWatts > model.mlss ? " (sopra MLSS: accumulo)" : ""}</dd>
            <dt>Carboidrati ossidati</dt>
            <dd>{sim.sub.choGh} g/h</dd>
            <dt>Grassi ossidati</dt>
            <dd>{sim.sub.fatGh} g/h</dd>
            <dt>Spesa energetica</dt>
            <dd>{sim.sub.kcalH} kcal/h</dd>
            <dt>Da assumere</dt>
            <dd>
              {sim.fuel.intakeGh ? `${sim.fuel.intakeGh} g/h CHO (${sim.fuel.totalIntake} g totali)` : "non necessario sotto 75'"}
              {sim.fuel.fluidsMlH ? ` · ${sim.fuel.fluidsMlH} ml/h liquidi` : ""}
              {sim.fuel.sodiumMgH ? ` · ${sim.fuel.sodiumMgH} mg/h sodio` : ""}
            </dd>
            {simWatts > model.cp && (
              <>
                <dt>Tempo limite stimato</dt>
                <dd>{Math.round(model.wPrime / (simWatts - model.cp) / 6) / 10} min (W' / (P − CP))</dd>
              </>
            )}
          </dl>
        </div>
      </div>
    </section>
  );
}
