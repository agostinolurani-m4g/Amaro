import { useState } from "react";
import type { AthleteEvent, AthletePlanSettings, Experience, SessionType, Weekday } from "../types";
import { WEEKDAY_NAMES, WEEKDAY_ORDER } from "../lib/athleteStore";
import { SESSION_TYPE_KEYS, SESSION_TYPE_META } from "../lib/sessionTypes";

interface Props {
  initial: AthletePlanSettings;
  busy?: boolean;
  onSave: (settings: AthletePlanSettings) => void;
  onCancel?: () => void;
}

const EXPERIENCES: { id: Experience; label: string }[] = [
  { id: "principiante", label: "Principiante (< 1 anno strutturato)" },
  { id: "intermedio", label: "Intermedio" },
  { id: "avanzato", label: "Avanzato / agonista" },
  { id: "elite", label: "Élite" },
];

const EVENT_TYPES: AthleteEvent["type"][] = ["granfondo", "crono", "salita", "criterium", "gara", "altro"];

function toggle<T>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

export function AthleteSettingsForm({ initial, busy, onSave, onCancel }: Props) {
  const [s, setS] = useState<AthletePlanSettings>(initial);
  const [ev, setEv] = useState<Omit<AthleteEvent, "id">>({ name: "", date: "", type: "granfondo", priority: "A", durationH: undefined });

  const weekMinutes = WEEKDAY_ORDER.reduce((sum, d) => sum + (s.availability[d] ?? 0), 0);

  function setAvail(day: Weekday, value: number) {
    setS({ ...s, availability: { ...s.availability, [day]: Math.max(0, Math.min(600, value)) } });
  }

  function addEvent() {
    if (!ev.name.trim() || !ev.date) return;
    setS({
      ...s,
      events: [...s.events, { ...ev, name: ev.name.trim(), id: `${ev.date}-${Date.now()}` }].sort((a, b) => a.date.localeCompare(b.date)),
    });
    setEv({ name: "", date: "", type: "granfondo", priority: "A", durationH: undefined });
  }

  return (
    <form
      className="onboard-form panel"
      onSubmit={(e) => {
        e.preventDefault();
        onSave({ ...s, onboarded: true });
      }}
    >
      <fieldset>
        <legend>Obiettivo</legend>
        <label>
          Cosa vuoi ottenere
          <textarea
            rows={2}
            value={s.goal}
            maxLength={240}
            placeholder="Es. finire la granfondo di giugno sotto le 5 ore, alzare l'FTP a 280 W…"
            onChange={(e) => setS({ ...s, goal: e.target.value })}
          />
        </label>
        <div className="onboard-row">
          <label>
            Esperienza
            <select value={s.experience} onChange={(e) => setS({ ...s, experience: e.target.value as Experience })}>
              {EXPERIENCES.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Ore max a settimana
            <input type="number" min={2} max={30} step={0.5} value={s.maxHoursWeek} onChange={(e) => setS({ ...s, maxHoursWeek: Number(e.target.value) || 0 })} />
          </label>
          <label>
            Settimana di scarico
            <select
              value={s.recoveryWeekEvery ?? ""}
              onChange={(e) => setS({ ...s, recoveryWeekEvery: e.target.value ? (Number(e.target.value) as 3 | 4) : undefined })}
            >
              <option value="">Automatica</option>
              <option value="3">Ogni 3 settimane (2:1)</option>
              <option value="4">Ogni 4 settimane (3:1)</option>
            </select>
          </label>
        </div>
      </fieldset>

      <fieldset>
        <legend>Disponibilità (minuti al giorno, 0 = riposo) · {Math.round(weekMinutes / 6) / 10} h</legend>
        <div className="avail-grid">
          {WEEKDAY_ORDER.map((d) => (
            <label key={d}>
              {WEEKDAY_NAMES[d].slice(0, 3)}
              <input type="number" min={0} max={600} step={15} value={s.availability[d] ?? 0} onChange={(e) => setAvail(d, Number(e.target.value) || 0)} />
            </label>
          ))}
        </div>
        <div className="onboard-row">
          <label>
            Giorno del lungo
            <select value={s.preferredLongDay ?? ""} onChange={(e) => setS({ ...s, preferredLongDay: (e.target.value || undefined) as Weekday | undefined })}>
              <option value="">Automatico</option>
              {WEEKDAY_ORDER.map((d) => (
                <option key={d} value={d}>
                  {WEEKDAY_NAMES[d]}
                </option>
              ))}
            </select>
          </label>
        </div>
        <span className="muted-copy">Giorni in cui esci su strada (il coach programma uscite outdoor):</span>
        <div className="chip-toggle-row">
          {WEEKDAY_ORDER.map((d) => (
            <button
              key={d}
              type="button"
              className={`chip-toggle${s.outdoorDays.includes(d) ? " chip-toggle--on" : ""}`}
              onClick={() => setS({ ...s, outdoorDays: toggle(s.outdoorDays, d) })}
            >
              {WEEKDAY_NAMES[d].slice(0, 3)}
            </button>
          ))}
        </div>
      </fieldset>

      <fieldset>
        <legend>Eventi</legend>
        {s.events.length > 0 && (
          <table className="zone-table">
            <tbody>
              {s.events.map((x) => (
                <tr key={x.id}>
                  <td>{x.date}</td>
                  <td>{x.name}</td>
                  <td>{x.type}</td>
                  <td>Priorità {x.priority}</td>
                  <td>{x.durationH ? `${x.durationH} h` : ""}</td>
                  <td>
                    <button type="button" className="btn btn--ghost btn--small" onClick={() => setS({ ...s, events: s.events.filter((e) => e.id !== x.id) })}>
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="onboard-row">
          <label>
            Nome
            <input value={ev.name} onChange={(e) => setEv({ ...ev, name: e.target.value })} placeholder="GF Nove Colli" />
          </label>
          <label>
            Data
            <input type="date" value={ev.date} onChange={(e) => setEv({ ...ev, date: e.target.value })} />
          </label>
          <label>
            Tipo
            <select value={ev.type} onChange={(e) => setEv({ ...ev, type: e.target.value as AthleteEvent["type"] })}>
              {EVENT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
          <label>
            Priorità
            <select value={ev.priority} onChange={(e) => setEv({ ...ev, priority: e.target.value as AthleteEvent["priority"] })}>
              <option value="A">A (obiettivo)</option>
              <option value="B">B</option>
              <option value="C">C (allenamento)</option>
            </select>
          </label>
          <label>
            Durata (h)
            <input type="number" min={0.5} max={14} step={0.5} value={ev.durationH ?? ""} onChange={(e) => setEv({ ...ev, durationH: e.target.value ? Number(e.target.value) : undefined })} />
          </label>
          <button type="button" className="btn btn--ghost btn--small" onClick={addEvent}>
            Aggiungi evento
          </button>
        </div>
      </fieldset>

      <fieldset>
        <legend>Preferenze</legend>
        <span className="muted-copy">Allenamenti che ami (il coach li preferisce):</span>
        <div className="chip-toggle-row">
          {SESSION_TYPE_KEYS.filter((t) => t !== "recovery").map((t) => (
            <button key={t} type="button" className={`chip-toggle${s.likes.includes(t) ? " chip-toggle--on" : ""}`} onClick={() => setS({ ...s, likes: toggle<SessionType>(s.likes, t), avoid: s.avoid.filter((a) => a !== t) })}>
              {SESSION_TYPE_META[t].label}
            </button>
          ))}
        </div>
        <span className="muted-copy">Allenamenti da evitare (sostituiti con alternative equivalenti):</span>
        <div className="chip-toggle-row">
          {SESSION_TYPE_KEYS.filter((t) => t !== "recovery" && t !== "z2").map((t) => (
            <button
              key={t}
              type="button"
              className={`chip-toggle chip-toggle--avoid${s.avoid.includes(t) ? " chip-toggle--on" : ""}`}
              onClick={() => setS({ ...s, avoid: toggle<SessionType>(s.avoid, t), likes: s.likes.filter((l) => l !== t) })}
            >
              {SESSION_TYPE_META[t].label}
            </button>
          ))}
        </div>
        <label>
          Infortuni / limitazioni
          <input value={s.injuries ?? ""} onChange={(e) => setS({ ...s, injuries: e.target.value || undefined })} placeholder="Es. ginocchio destro: niente bassa cadenza" />
        </label>
        {s.constraints.length > 0 && (
          <div className="chip-toggle-row">
            {s.constraints.map((c) => (
              <button key={c} type="button" className="chip-toggle chip-toggle--on" title="Rimuovi vincolo" onClick={() => setS({ ...s, constraints: s.constraints.filter((x) => x !== c) })}>
                {c} ✕
              </button>
            ))}
          </div>
        )}
      </fieldset>

      <div className="onboard-row">
        <button type="submit" className="btn btn--primary" disabled={busy || !s.goal.trim()}>
          {busy ? "Genero il piano…" : "Salva e genera il piano"}
        </button>
        {onCancel && (
          <button type="button" className="btn btn--ghost" onClick={onCancel}>
            Annulla
          </button>
        )}
      </div>
    </form>
  );
}
