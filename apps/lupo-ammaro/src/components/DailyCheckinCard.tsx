import { useEffect, useState } from "react";
import type { DailyCheckin } from "../types";

const SCALES: { key: keyof Pick<DailyCheckin, "sleep" | "fatigue" | "soreness" | "stress" | "motivation">; label: string; low: string; high: string }[] = [
  { key: "sleep", label: "Sonno", low: "pessimo", high: "ottimo" },
  { key: "fatigue", label: "Fatica", low: "fresco", high: "distrutto" },
  { key: "soreness", label: "Dolori muscolari", low: "nessuno", high: "forti" },
  { key: "stress", label: "Stress", low: "nullo", high: "alto" },
  { key: "motivation", label: "Motivazione", low: "zero", high: "altissima" },
];

interface Props {
  date: string;
  initial: DailyCheckin | null;
  readiness: number | null;
  onSave: (checkin: DailyCheckin) => void;
}

export function DailyCheckinCard({ date, initial, readiness, onSave }: Props) {
  const [c, setC] = useState<DailyCheckin>(
    initial ?? { date, sleep: 3, fatigue: 3, soreness: 2, stress: 3, motivation: 3 },
  );
  const [dirty, setDirty] = useState(!initial);

  useEffect(() => {
    if (initial) {
      setC(initial);
      setDirty(false);
    }
  }, [initial]);

  const level = readiness == null ? "" : readiness < 35 ? "low" : readiness < 55 ? "mid" : "high";

  return (
    <div className="panel">
      <div className="readiness-head">
        <h3>Check-in di oggi</h3>
        {readiness != null && (
          <div className={`readiness readiness--${level}`}>
            <span className="readiness__value">{readiness}</span>
            <span className="muted-copy">prontezza /100</span>
          </div>
        )}
      </div>
      <div className="checkin-grid">
        {SCALES.map((s) => (
          <div key={s.key}>
            <span className="metric__label">
              {s.label} <small className="muted-copy">({s.low} → {s.high})</small>
            </span>
            <div className="scale-row">
              {[1, 2, 3, 4, 5].map((v) => (
                <button
                  key={v}
                  type="button"
                  className={c[s.key] === v ? "is-on" : ""}
                  onClick={() => {
                    setC({ ...c, [s.key]: v });
                    setDirty(true);
                  }}
                >
                  {v}
                </button>
              ))}
            </div>
          </div>
        ))}
        <label className="onboard-form">
          <span className="metric__label">FC a riposo</span>
          <input
            type="number"
            min={30}
            max={110}
            value={c.restingHr ?? ""}
            onChange={(e) => {
              setC({ ...c, restingHr: e.target.value ? Number(e.target.value) : undefined });
              setDirty(true);
            }}
          />
        </label>
      </div>
      <div className="chat-input" style={{ marginTop: 10 }}>
        <textarea
          rows={1}
          placeholder="Note (es. raffreddore, viaggio, gambe pesanti)…"
          value={c.note ?? ""}
          onChange={(e) => {
            setC({ ...c, note: e.target.value || undefined });
            setDirty(true);
          }}
        />
        <button type="button" className="btn btn--primary btn--small" disabled={!dirty} onClick={() => onSave({ ...c, date })}>
          {initial && !dirty ? "Salvato" : "Salva check-in"}
        </button>
      </div>
    </div>
  );
}
