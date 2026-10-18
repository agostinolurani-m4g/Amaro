import { useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { formatDuration } from "../lib/workoutEngine";
import {
  deleteCalendarEntry,
  getProfile,
  importActivityFile,
  importActivityFromPath,
  listCalendar,
  listWorkouts,
  saveCalendarEntry,
  todayIso,
} from "../hooks/useStorage";
import { SessionSeriesChart } from "../components/SessionSeriesChart";
import { EntryMetricsGrid } from "../components/EntryMetricsGrid";
import { RichText } from "../components/RichText";
import { metricsFromPoints, plannedCompliance, storageSeries } from "../lib/sessionEvaluation";
import { complianceLevel, entrySessionType, SESSION_TYPE_META, sessionColor } from "../lib/sessionTypes";
import { sportColor, sportLabel } from "../lib/sportTypes";
import { activityTss } from "../lib/activityLoad";
import { collapseStravaDuplicates, syncStrava } from "../lib/stravaSync";
import { computePmc, weeklySummary } from "../../shared/engine/load.mjs";
import { addDaysIso, diffDays, mondayOfIso, WEEKDAY_LABELS } from "../../shared/engine/dates.mjs";
import type { CalendarEntry, ImportedActivity, LifeBlock, UserProfile, Workout } from "../types";
import { lifeBlocksForDate, listLifeBlocks } from "../lib/lifeBlockStore";

type View = "month" | "week";

function isActivityPath(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.endsWith(".fit") || lower.endsWith(".gpx");
}

async function calendarEntryFromImport(imported: ImportedActivity, profile: UserProfile | null): Promise<CalendarEntry> {
  const points = imported.series ?? [];
  const metrics = points.length > 0 && profile ? metricsFromPoints(points, profile) : null;
  const calendar = await listCalendar().catch(() => []);
  const planned = calendar.find((e) => e.entryType === "planned" && e.date === imported.date);
  const durationSecs = metrics?.durationSecs || imported.durationSecs;
  return saveCalendarEntry({
    id: "",
    date: imported.date,
    entryType: "imported",
    title: imported.title,
    ...metrics,
    durationSecs,
    avgPower: metrics?.avgPower ?? imported.avgPower,
    maxPower: metrics?.maxPower ?? imported.maxPower,
    avgHr: metrics?.avgHr ?? imported.avgHr,
    maxHr: metrics?.maxHr ?? imported.maxHr,
    distanceM: imported.distanceM,
    series: points.length > 0 ? storageSeries(points) : undefined,
    importPath: imported.sourcePath,
    importFormat: imported.format,
    plannedEntryId: planned?.id,
    plannedTss: planned?.plannedTss,
    sessionType: planned?.sessionType,
    compliance: planned ? plannedCompliance({ durationSecs, tss: metrics?.tss }, planned) : undefined,
  });
}

function monthStart(iso: string): string {
  return `${iso.slice(0, 7)}-01`;
}

function monthEnd(iso: string): string {
  const [y, m] = iso.split("-").map(Number);
  const last = new Date(y, m, 0).getDate();
  return `${iso.slice(0, 7)}-${String(last).padStart(2, "0")}`;
}

function shiftMonth(iso: string, delta: number): string {
  const [y, m] = iso.split("-").map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

function dateAtPoint(x: number, y: number): string | null {
  const el = document.elementFromPoint(x, y) as HTMLElement | null;
  return el?.closest<HTMLElement>("[data-date]")?.dataset.date ?? null;
}

interface Props {
  onStartWorkout?: (workout: Workout) => void;
}

export function CalendarPage({ onStartWorkout }: Props) {
  const today = todayIso();
  const [entries, setEntries] = useState<CalendarEntry[]>([]);
  const [workouts, setWorkouts] = useState<Workout[]>([]);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [view, setView] = useState<View>("month");
  const [anchor, setAnchor] = useState(today);
  const [selectedDate, setSelectedDate] = useState(today);
  const [selectedEntryId, setSelectedEntryId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [planWorkoutId, setPlanWorkoutId] = useState("");
  const [fileDragOver, setFileDragOver] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const [lifeBlocks, setLifeBlocks] = useState<LifeBlock[]>([]);
  const [dropDate, setDropDate] = useState<string | null>(null);
  const [ghost, setGhost] = useState<{ x: number; y: number } | null>(null);
  const drag = useRef<{ id: string; x: number; y: number; active: boolean } | null>(null);
  const suppressClick = useRef(false);
  const profileRef = useRef<UserProfile | null>(null);

  useEffect(() => {
    void collapseStravaDuplicates()
      .catch(() => 0)
      .then(() => Promise.all([listCalendar(), listWorkouts(), getProfile(), listLifeBlocks()]))
      .then(([cal, wos, prof, blocks]) => {
        setEntries(cal);
        setWorkouts(wos);
        setProfile(prof);
        setLifeBlocks(blocks);
        profileRef.current = prof;
        if (wos[0]) setPlanWorkoutId(wos[0].id);
      })
      .catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type === "enter" || event.payload.type === "over") {
          setFileDragOver(true);
        } else if (event.payload.type === "leave") {
          setFileDragOver(false);
        } else if (event.payload.type === "drop") {
          setFileDragOver(false);
          const paths = event.payload.paths.filter(isActivityPath);
          if (paths.length === 0) return;
          void (async () => {
            setError(null);
            try {
              const saved: CalendarEntry[] = [];
              for (const path of paths) {
                const imported = await importActivityFromPath(path);
                saved.push(await calendarEntryFromImport(imported, profileRef.current));
              }
              setEntries((prev) => [...prev, ...saved]);
              const last = saved[saved.length - 1];
              if (last) {
                setSelectedDate(last.date);
                setSelectedEntryId(last.id);
              }
            } catch (e) {
              setError(String(e));
            }
          })();
        }
      })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => undefined);
    return () => unlisten?.();
  }, []);

  const range = useMemo(() => {
    if (view === "week") {
      const start = mondayOfIso(anchor);
      return { start, end: addDaysIso(start, 6) };
    }
    const start = mondayOfIso(monthStart(anchor));
    const end = addDaysIso(mondayOfIso(monthEnd(anchor)), 6);
    return { start, end };
  }, [anchor, view]);

  const days = useMemo(() => {
    const n = diffDays(range.start, range.end) + 1;
    return Array.from({ length: n }, (_, i) => addDaysIso(range.start, i));
  }, [range]);

  const byDate = useMemo(() => {
    const map = new Map<string, CalendarEntry[]>();
    for (const e of entries) {
      const list = map.get(e.date) ?? [];
      list.push(e);
      map.set(e.date, list);
    }
    for (const list of map.values()) list.sort((a, b) => Number(a.entryType === "planned") - Number(b.entryType === "planned"));
    return map;
  }, [entries]);

  const ftp = profile?.ftpWatts ?? 0;
  const lthr = profile?.lthr ?? 0;

  const pmcByDate = useMemo(() => {
    const first = entries.reduce((min, e) => (e.date < min ? e.date : min), today);
    const pmc = computePmc(entries, {
      ftp,
      lthr,
      days: Math.max(120, diffDays(first, today) + 1),
      futureDays: Math.max(0, diffDays(today, range.end)),
      today,
    });
    return new Map(pmc.map((p) => [p.date, p]));
  }, [entries, ftp, lthr, range.end, today]);

  const weeks = useMemo(() => {
    const summary = new Map(weeklySummary(entries, { ftp, lthr }).map((w) => [w.weekStart, w]));
    const out: { start: string; days: string[] }[] = [];
    for (let i = 0; i < days.length; i += 7) out.push({ start: days[i], days: days.slice(i, i + 7) });
    return out.map((w) => ({ ...w, summary: summary.get(w.start), pmc: pmcByDate.get(addDaysIso(w.start, 6)) }));
  }, [days, entries, ftp, lthr, pmcByDate]);

  const dayEntries = byDate.get(selectedDate) ?? [];
  const selectedEntry = dayEntries.find((e) => e.id === selectedEntryId) ?? null;
  const workoutById = useMemo(() => new Map(workouts.map((w) => [w.id, w])), [workouts]);

  async function moveEntry(id: string, date: string) {
    const entry = entries.find((e) => e.id === id);
    if (!entry || entry.date === date) return;
    if (date < today) {
      setError("Le sessioni pianificate si possono spostare solo da oggi in avanti.");
      return;
    }
    const saved = await saveCalendarEntry({ ...entry, date });
    setEntries((prev) => prev.map((e) => (e.id === id ? saved : e)));
    setSelectedDate(date);
    setSelectedEntryId(saved.id);
  }

  function onChipPointerDown(e: ReactPointerEvent<HTMLElement>, entry: CalendarEntry) {
    if (entry.entryType !== "planned" || e.button !== 0) return;
    drag.current = { id: entry.id, x: e.clientX, y: e.clientY, active: false };
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function onChipPointerMove(e: ReactPointerEvent<HTMLElement>) {
    const d = drag.current;
    if (!d) return;
    if (!d.active && Math.hypot(e.clientX - d.x, e.clientY - d.y) > 6) {
      d.active = true;
      setDragId(d.id);
    }
    if (d.active) {
      setGhost({ x: e.clientX, y: e.clientY });
      setDropDate(dateAtPoint(e.clientX, e.clientY));
    }
  }

  function endDrag(e: ReactPointerEvent<HTMLElement>, cancel = false) {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.active) {
      suppressClick.current = true;
      const target = cancel ? null : dateAtPoint(e.clientX, e.clientY);
      setDragId(null);
      setDropDate(null);
      setGhost(null);
      if (target) void moveEntry(d.id, target).catch((err) => setError(String(err)));
    }
  }

  function selectEntry(entry: CalendarEntry) {
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    setSelectedDate(entry.date);
    setSelectedEntryId((prev) => (prev === entry.id ? null : entry.id));
  }

  async function handleImport() {
    setError(null);
    try {
      const imported = await importActivityFile();
      if (!imported) return;
      const saved = await calendarEntryFromImport(imported, profile);
      setEntries((prev) => [...prev, saved]);
      setSelectedDate(saved.date);
      setSelectedEntryId(saved.id);
      setAnchor(saved.date);
    } catch (e) {
      setError(String(e));
    }
  }

  async function handlePlan() {
    const workout = workouts.find((w) => w.id === planWorkoutId);
    if (!workout) return;
    const saved = await saveCalendarEntry({
      id: "",
      date: selectedDate,
      entryType: "planned",
      title: workout.name,
      workoutId: workout.id,
    });
    setEntries((prev) => [...prev, saved]);
  }

  async function handleDelete(entry: CalendarEntry) {
    await deleteCalendarEntry(entry.id);
    setEntries((prev) => prev.filter((e) => e.id !== entry.id));
    if (selectedEntryId === entry.id) setSelectedEntryId(null);
  }

  function startEntry(entry: CalendarEntry) {
    const workout = entry.workoutId ? workoutById.get(entry.workoutId) : undefined;
    if (workout && onStartWorkout) onStartWorkout(workout);
  }

  function chip(entry: CalendarEntry, detailed: boolean) {
    const planned = entry.entryType === "planned";
    const type = entrySessionType(entry);
    const color = entry.sport ? sportColor(entry.sport) : sessionColor(entry);
    const tss = Math.round(activityTss(entry, profile));
    const level = complianceLevel(entry.compliance);
    const label = entry.sport ? sportLabel(entry.sport) : type ? SESSION_TYPE_META[type].short : planned ? "PIANO" : "LIBERA";
    return (
      <div
        key={entry.id}
        role="button"
        tabIndex={0}
        className={`cal-chip${planned ? " cal-chip--planned" : " cal-chip--done"}${dragId === entry.id ? " cal-chip--dragging" : ""}${selectedEntryId === entry.id ? " cal-chip--selected" : ""}`}
        style={{ ["--chip-color" as string]: color }}
        onPointerDown={(e) => onChipPointerDown(e, entry)}
        onPointerMove={onChipPointerMove}
        onPointerUp={(e) => endDrag(e)}
        onPointerCancel={(e) => endDrag(e, true)}
        onClick={(e) => {
          e.stopPropagation();
          selectEntry(entry);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") selectEntry(entry);
        }}
        title={planned ? "Trascina per spostare" : entry.title}
      >
        <span className="cal-chip__type">{label}</span>
        {detailed && <span className="cal-chip__title">{entry.title}</span>}
        <span className="cal-chip__meta">
          {entry.durationSecs ? `${Math.round(entry.durationSecs / 60)}'` : ""}
          {tss ? ` · ${tss}` : ""}
        </span>
        {level && <i className={`cal-chip__dot cal-chip__dot--${level}`} title={`Compliance ${entry.compliance}%`} />}
        {detailed && planned && entry.workoutId && onStartWorkout && workoutById.has(entry.workoutId) && entry.date === today && (
          <button
            type="button"
            className="btn btn--primary btn--small cal-chip__start"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              startEntry(entry);
            }}
          >
            Avvia
          </button>
        )}
      </div>
    );
  }

  const title =
    view === "week"
      ? `${new Date(`${range.start}T12:00:00`).toLocaleDateString("it-IT", { day: "numeric", month: "short" })} – ${new Date(`${range.end}T12:00:00`).toLocaleDateString("it-IT", { day: "numeric", month: "short", year: "numeric" })}`
      : new Date(`${anchor.slice(0, 7)}-15T12:00:00`).toLocaleDateString("it-IT", { month: "long", year: "numeric" });

  const currentMonth = anchor.slice(0, 7);

  return (
    <section className={`page calendar-page${fileDragOver ? " calendar-page--dragover" : ""}${dragId ? " calendar-page--moving" : ""}`}>
      <header className="hero hero--compact">
        <p className="eyebrow">Pianificazione</p>
        <h1>Calendario</h1>
      </header>

      <div className="calendar-toolbar">
        <button type="button" className="btn btn--ghost btn--small" onClick={() => setAnchor(view === "week" ? addDaysIso(anchor, -7) : shiftMonth(anchor, -1))}>
          ←
        </button>
        <strong className="cal-title">{title}</strong>
        <button type="button" className="btn btn--ghost btn--small" onClick={() => setAnchor(view === "week" ? addDaysIso(anchor, 7) : shiftMonth(anchor, 1))}>
          →
        </button>
        <button type="button" className="btn btn--ghost btn--small" onClick={() => { setAnchor(today); setSelectedDate(today); }}>
          Oggi
        </button>
        <div className="mode-tabs cal-view-tabs">
          <button type="button" className={`mode-tab${view === "month" ? " mode-tab--active" : ""}`} onClick={() => setView("month")}>
            Mese
          </button>
          <button
            type="button"
            className={`mode-tab${view === "week" ? " mode-tab--active" : ""}`}
            onClick={() => {
              setView("week");
              setAnchor(selectedDate);
            }}
          >
            Settimana
          </button>
        </div>
        <button type="button" className="btn btn--primary btn--small" onClick={() => void handleImport()}>
          Importa .fit / .gpx
        </button>
        <button
          type="button"
          className="btn btn--ghost btn--small"
          disabled={syncing}
          onClick={() => {
            setSyncing(true);
            void syncStrava({ onProgress: (m) => setError(m) })
              .then(async () => {
                setEntries(await listCalendar());
                setError(null);
              })
              .catch((e) => setError(String(e)))
              .finally(() => setSyncing(false));
          }}
        >
          {syncing ? "Strava…" : "Sincronizza Strava"}
        </button>
      </div>

      <div className={`cal-grid cal-grid--${view}`}>
        {WEEKDAY_LABELS.map((d) => (
          <div key={d} className="cal-grid__head">
            {d}
          </div>
        ))}
        <div className="cal-grid__head">Settimana</div>
        {weeks.map((w) => (
          <div key={w.start} className="cal-week-row">
            {w.days.map((iso) => {
              const list = byDate.get(iso) ?? [];
              const outside = view === "month" && iso.slice(0, 7) !== currentMonth;
              return (
                <div
                  key={iso}
                  data-date={iso}
                  role="button"
                  tabIndex={0}
                  className={`cal-day${outside ? " cal-day--outside" : ""}${iso === today ? " cal-day--today" : ""}${iso === selectedDate ? " cal-day--selected" : ""}${dropDate === iso ? " cal-day--drop" : ""}${iso < today ? " cal-day--past" : ""}`}
                  onClick={() => {
                    setSelectedDate(iso);
                    setSelectedEntryId(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") setSelectedDate(iso);
                  }}
                >
                  <span className="cal-day__num">{Number(iso.slice(8))}</span>
                  <div className="cal-day__chips">{list.map((entry) => chip(entry, view === "week"))}</div>
                </div>
              );
            })}
            <div className="cal-week-total">
              <span>
                <strong>{w.summary?.doneTss ?? 0}</strong>
                {w.summary?.plannedTss ? ` / ${w.summary.plannedTss}` : ""} TSS
              </span>
              <span>{formatDuration(w.summary?.doneSecs ?? 0)}{w.summary?.plannedSecs ? ` / ${formatDuration(w.summary.plannedSecs)}` : ""}</span>
              {w.pmc && (
                <span className={w.pmc.projected ? "cal-week-total__proj" : ""}>
                  CTL {Math.round(w.pmc.ctl)}
                  {w.pmc.projected ? " prev." : ""}
                </span>
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="cal-legend">
        <span><i className="cal-legend__box cal-legend__box--planned" /> Pianificato (trascina per spostare)</span>
        <span><i className="cal-legend__box cal-legend__box--done" /> Svolto</span>
        <span><i className="cal-chip__dot cal-chip__dot--good" /> compliance 80–120%</span>
        <span><i className="cal-chip__dot cal-chip__dot--warn" /> 50–80% / 120–140%</span>
        <span><i className="cal-chip__dot cal-chip__dot--bad" /> fuori target</span>
      </div>

      <div className="calendar-day-panel">
        <h3>
          {new Date(`${selectedDate}T12:00:00`).toLocaleDateString("it-IT", { weekday: "long", day: "numeric", month: "long" })}
          {pmcByDate.get(selectedDate) && (
            <small className="cal-day-pmc">
              {" "}
              · CTL {Math.round(pmcByDate.get(selectedDate)!.ctl)} · TSB {Math.round(pmcByDate.get(selectedDate)!.tsb)}
            </small>
          )}
        </h3>
        {lifeBlocksForDate(lifeBlocks, selectedDate).length > 0 && (
          <div className="life-block-list">
            {lifeBlocksForDate(lifeBlocks, selectedDate).map((b) => (
              <p key={b.id} className="life-block-pill">
                {b.label}
              </p>
            ))}
          </div>
        )}
        {dayEntries.length === 0 ? (
          <p className="muted-copy">Nessuna sessione per questo giorno.</p>
        ) : (
          <ul className="calendar-entry-list">
            {dayEntries.map((entry) => (
              <li key={entry.id} className={`calendar-entry ${selectedEntryId === entry.id ? "calendar-entry--selected" : ""}`}>
                <button type="button" className="calendar-entry__select" onClick={() => setSelectedEntryId((prev) => (prev === entry.id ? null : entry.id))}>
                  <i className="cal-entry-swatch" style={{ background: sessionColor(entry) }} />
                  <strong>{entry.title}</strong>
                  <span>
                    {entry.entryType === "planned" ? "Programmato" : entry.entryType === "imported" ? "Importato" : "Completato"}
                    {entry.externalSource === "strava" && entry.externalId ? (
                      <>
                        {" · "}
                        <button type="button" className="rich-text__link" onClick={() => void import("@tauri-apps/plugin-opener").then((m) => m.openUrl(`https://www.strava.com/activities/${entry.externalId}`))}>
                          Strava
                        </button>
                      </>
                    ) : null}
                    {entry.durationSecs ? ` · ${formatDuration(entry.durationSecs)}` : ""}
                    {entry.entryType === "planned" && entry.plannedTss ? ` · ${Math.round(entry.plannedTss)} TSS previsti` : ""}
                    {entry.entryType !== "planned" && entry.tss ? ` · ${Math.round(entry.tss)} TSS` : ""}
                    {entry.np ? ` · NP ${entry.np} W` : entry.avgPower ? ` · ${entry.avgPower} W` : ""}
                  </span>
                </button>
                {entry.entryType === "planned" && entry.workoutId && workoutById.has(entry.workoutId) && onStartWorkout && (
                  <button type="button" className="btn btn--primary btn--small" onClick={() => startEntry(entry)}>
                    Avvia
                  </button>
                )}
                <button type="button" className="btn btn--ghost btn--small" onClick={() => void handleDelete(entry)}>
                  Elimina
                </button>
              </li>
            ))}
          </ul>
        )}

        {selectedEntry && (
          <div className="cal-entry-detail">
            <EntryMetricsGrid entry={selectedEntry} profile={profile} />
            {selectedEntry.entryType === "planned" && (
              <label className="cal-move">
                Sposta a
                <input
                  type="date"
                  min={today}
                  value={selectedEntry.date}
                  onChange={(e) => e.target.value && void moveEntry(selectedEntry.id, e.target.value)}
                />
              </label>
            )}
            {selectedEntry.notes && <p className="muted-copy">{selectedEntry.notes.replace(/^Coach WattLab · /, "")}</p>}
            {selectedEntry.feel && <p className="muted-copy">Sensazioni: {selectedEntry.feel}</p>}
            {selectedEntry.coachComment && (
              <div className="eval-card eval-card--compact">
                <p className="eyebrow">Commento coach</p>
                <RichText text={selectedEntry.coachComment} className="rich-text--prose" />
              </div>
            )}
            {selectedEntry.series && selectedEntry.series.length > 0 && (
              <div className="calendar-series-chart">
                <p className="eyebrow">Andamento · {selectedEntry.title}</p>
                <SessionSeriesChart series={selectedEntry.series} />
              </div>
            )}
          </div>
        )}

        {workouts.length > 0 && (
          <div className="plan-row">
            <select value={planWorkoutId} onChange={(e) => setPlanWorkoutId(e.target.value)}>
              {workouts.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
            <button type="button" className="btn btn--primary btn--small" onClick={() => void handlePlan()}>
              Programma il {selectedDate.slice(8)}/{selectedDate.slice(5, 7)}
            </button>
          </div>
        )}
      </div>

      {error && (
        <p className="error-banner" onClick={() => setError(null)}>
          {error}
        </p>
      )}

      {ghost && dragId && (
        <div className="cal-ghost" style={{ left: ghost.x + 12, top: ghost.y + 12 }}>
          {entries.find((e) => e.id === dragId)?.title} → {dropDate ?? "…"}
        </div>
      )}

      {fileDragOver && (
        <div className="calendar-drop-overlay" aria-hidden="true">
          <p>Rilascia file .fit o .gpx</p>
        </div>
      )}
    </section>
  );
}
