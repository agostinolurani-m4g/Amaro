import { useEffect, useMemo, useState } from "react";
import { getPersonalRecords, getProfile, listCalendar, todayIso } from "../hooks/useStorage";
import { CoachChart } from "../components/CoachChart";
import { SessionSeriesChart } from "../components/SessionSeriesChart";
import { EntryMetricsGrid } from "../components/EntryMetricsGrid";
import { RichText } from "../components/RichText";
import { formatDuration } from "../lib/workoutEngine";
import { emptyPersonalRecords } from "../lib/sessionStats";
import { complianceLevel, entrySessionType, SESSION_TYPE_KEYS, SESSION_TYPE_META, sessionColor } from "../lib/sessionTypes";
import { COGGAN_ZONES, MMP_WINDOWS, computePmc, loadSnapshot, resample1Hz, weeklySummary } from "../../shared/engine/load.mjs";
import { athleteModel, bestMmp, fitCriticalPower, lactateAfter, wPrimeBalance } from "../../shared/engine/physiology.mjs";
import { SPORT_META, sportColor, sportLabel } from "../lib/sportTypes";
import { activityTss, persistStravaLoad } from "../lib/activityLoad";
import { addDaysIso } from "../../shared/engine/dates.mjs";
import type { CalendarEntry, CoachChartData, PersonalRecords, SessionType, UserProfile } from "../types";

type Tab = "sessions" | "trend" | "curve";
type SortKey = "date" | "durationSecs" | "tss" | "ifactor" | "np" | "avgHr" | "rpe" | "compliance";

const PERIODS = [
  { id: "30", label: "30 giorni", days: 30 },
  { id: "90", label: "90 giorni", days: 90 },
  { id: "365", label: "12 mesi", days: 365 },
  { id: "all", label: "Tutto", days: 36500 },
];

const MMP_LABELS = MMP_WINDOWS.map((s) => (s < 60 ? `${s}s` : `${Math.round(s / 60)}m`));

function wbalChart(entry: CalendarEntry, cp: number, wPrime: number): CoachChartData | null {
  if (!entry.series?.length) return null;
  const { power } = resample1Hz(entry.series);
  if (!power.some((w) => w > 0)) return null;
  const wb = wPrimeBalance(power, cp, wPrime);
  const step = Math.max(1, Math.floor(power.length / 600));
  const x: number[] = [];
  const bal: number[] = [];
  for (let i = 0; i < power.length; i += step) {
    x.push(Math.round(i / 60));
    bal.push(Math.round(wb.series[i] / 100) / 10);
  }
  return {
    kind: "trend",
    title: `W' balance (min ${wb.minPct}% · CP ${cp} W · W' ${(wPrime / 1000).toFixed(1)} kJ)`,
    x,
    yLabel: "kJ (x = minuti)",
    series: [{ label: "W' bal kJ", data: bal, color: "#facc15" }],
  };
}

function ZoneBars({ zoneSecs }: { zoneSecs?: number[] }) {
  if (!zoneSecs?.length) return null;
  const total = zoneSecs.reduce((a, b) => a + b, 0) || 1;
  return (
    <div className="panel">
      <h3>Tempo in zona</h3>
      {COGGAN_ZONES.map((z, i) => {
        const pct = ((zoneSecs[i] ?? 0) / total) * 100;
        return (
          <div key={z.id} className="bar-row">
            <span>{z.label}</span>
            <div className="bar-row__track">
              <div className="bar-row__fill" style={{ width: `${pct}%`, background: z.color }} />
            </div>
            <span>{formatDuration(zoneSecs[i] ?? 0)}</span>
          </div>
        );
      })}
    </div>
  );
}

export function HistoryPage() {
  const today = todayIso();
  const [entries, setEntries] = useState<CalendarEntry[]>([]);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [records, setRecords] = useState<PersonalRecords>(emptyPersonalRecords());
  const [tab, setTab] = useState<Tab>("sessions");
  const [period, setPeriod] = useState("90");
  const [source, setSource] = useState<"all" | "completed" | "imported">("all");
  const [typeFilter, setTypeFilter] = useState<SessionType | "all">("all");
  const [sportFilter, setSportFilter] = useState<string>("all");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "date", dir: -1 });
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    void Promise.all([listCalendar().catch(() => []), getProfile(), getPersonalRecords().catch(() => emptyPersonalRecords())]).then(
      ([cal, prof, rec]) => {
        const withLoad = cal.map((entry) => {
          const tss = activityTss(entry, prof);
          return tss > 0 && !(entry.tss && entry.tss > 0) ? { ...entry, tss } : entry;
        });
        setEntries(withLoad);
        setProfile(prof);
        setRecords(rec);
        void persistStravaLoad(cal)
          .then(setEntries)
          .catch(() => undefined);
      },
    );
  }, []);

  const done = useMemo(() => entries.filter((e) => e.entryType !== "planned"), [entries]);
  const model = useMemo(() => (profile ? athleteModel(profile, done, { records, today }) : null), [profile, done, records, today]);
  const ftp = profile?.ftpWatts || model?.ftp || 0;
  const lthr = profile?.lthr ?? 0;

  const filtered = useMemo(() => {
    const days = PERIODS.find((p) => p.id === period)?.days ?? 90;
    const from = addDaysIso(today, -days);
    const q = query.trim().toLowerCase();
    const list = done.filter(
      (e) =>
        e.date >= from &&
        (source === "all" || e.entryType === source) &&
        (typeFilter === "all" || entrySessionType(e) === typeFilter) &&
        (sportFilter === "all" || (e.sport || "ride") === sportFilter) &&
        (!q || e.title.toLowerCase().includes(q)),
    );
    return list.sort((a, b) => {
      const va = a[sort.key] ?? 0;
      const vb = b[sort.key] ?? 0;
      if (va < vb) return -sort.dir;
      if (va > vb) return sort.dir;
      return 0;
    });
  }, [done, period, source, typeFilter, sportFilter, query, sort, today]);

  const totals = useMemo(
    () => ({
      sessions: filtered.length,
      secs: filtered.reduce((s, e) => s + (e.durationSecs ?? 0), 0),
      tss: Math.round(filtered.reduce((s, e) => s + activityTss(e, profile), 0)),
      kj: Math.round(filtered.reduce((s, e) => s + (e.kj ?? 0), 0)),
    }),
    [filtered, profile],
  );

  const selected = filtered.find((e) => e.id === selectedId) ?? null;

  const pmc = useMemo(() => computePmc(entries, { ftp, lthr, days: 180, futureDays: 28, today }), [entries, ftp, lthr, today]);
  const load = useMemo(() => loadSnapshot(pmc, today), [pmc, today]);

  const pmcChart: CoachChartData = useMemo(() => {
    const rows = pmc.filter((p) => p.date >= addDaysIso(today, -120));
    return {
      kind: "pmc",
      title: "Performance Manager (proiezione dal piano)",
      x: rows.map((p) => p.date),
      yLabel: "CTL / ATL / TSB",
      series: [
        { label: "CTL", data: rows.map((p) => (p.projected ? null : p.ctl)), color: "#4ade80" },
        { label: "ATL", data: rows.map((p) => (p.projected ? null : p.atl)), color: "#ff0a54" },
        { label: "TSB", data: rows.map((p) => (p.projected ? null : p.tsb)), color: "#60a5fa" },
        { label: "CTL previsto", data: rows.map((p) => (p.projected || p.date === today ? p.ctl : null)), color: "#86efac" },
        { label: "TSB previsto", data: rows.map((p) => (p.projected || p.date === today ? p.tsb : null)), color: "#93c5fd" },
      ],
    };
  }, [pmc, today]);

  const weekly = useMemo(() => weeklySummary(entries, { ftp, lthr }).filter((w) => w.weekStart >= addDaysIso(today, -7 * 16)), [entries, ftp, lthr, today]);

  const weeklyChart: CoachChartData = useMemo(
    () => ({
      kind: "weekly_tss",
      title: "TSS settimanale: svolto vs pianificato",
      x: weekly.map((w) => w.weekStart),
      yLabel: "TSS",
      series: [
        { label: "Svolto", data: weekly.map((w) => w.doneTss), color: "#ff0a54" },
        { label: "Pianificato", data: weekly.map((w) => w.plannedTss), color: "#8a93a8" },
      ],
    }),
    [weekly],
  );

  const zonesChart: CoachChartData = useMemo(() => {
    const rows = weekly.filter((w) => w.weekStart <= today);
    return {
      kind: "trend",
      title: "Ore per zona per settimana",
      x: rows.map((w) => w.weekStart),
      yLabel: "ore",
      series: COGGAN_ZONES.slice(0, 6).map((z, i) => ({
        label: z.label,
        data: rows.map((w) => Math.round(((w.zoneSecs[i] ?? 0) / 3600) * 10) / 10),
        color: z.color,
      })),
    };
  }, [weekly, today]);

  const fitnessTrend: CoachChartData = useMemo(() => {
    const points: { date: string; cp: number | null; ftp: number | null }[] = [];
    for (let k = 8; k >= 0; k--) {
      const end = addDaysIso(today, -k * 21);
      const best = bestMmp(done, { days: 42, today: end });
      const fit = fitCriticalPower(best);
      const p20 = best[MMP_WINDOWS.indexOf(1200)]?.watts ?? 0;
      points.push({ date: end, cp: fit?.cp ?? null, ftp: p20 ? Math.round(p20 * 0.95) : null });
    }
    return {
      kind: "trend",
      title: "Andamento CP e FTP stimata (finestre di 6 settimane)",
      x: points.map((p) => p.date),
      yLabel: "W",
      series: [
        { label: "CP", data: points.map((p) => p.cp), color: "#60a5fa" },
        { label: "FTP (95% 20')", data: points.map((p) => p.ftp), color: "#ff0a54" },
      ],
    };
  }, [done, today]);

  const curveChart: CoachChartData | null = useMemo(() => {
    const periods = [
      { label: "30 g", days: 30, color: "#ff0a54" },
      { label: "90 g", days: 90, color: "#facc15" },
      { label: "12 mesi", days: 365, color: "#60a5fa" },
      { label: "Storico", days: 36500, color: "#8a93a8" },
    ];
    const rows = periods.map((p) => bestMmp(done, { days: p.days, today }).map((b) => b.watts));
    const idx = MMP_WINDOWS.map((_, i) => i).filter((i) => rows.some((r) => r[i] > 0));
    if (!idx.length) return null;
    return {
      kind: "power_curve",
      title: "Curva potenza-durata per periodo",
      x: idx.map((i) => MMP_LABELS[i]),
      yLabel: "W",
      series: [
        ...periods.map((p, k) => ({ label: p.label, data: idx.map((i) => rows[k][i] || null), color: p.color })),
        ...(model
          ? [
              {
                label: "Modello CP",
                data: idx.map((i) => (MMP_WINDOWS[i] >= 120 ? Math.round(model.cp + model.wPrime / MMP_WINDOWS[i]) : null)),
                color: "#4ade80",
              },
            ]
          : []),
      ],
    };
  }, [done, today, model]);

  function header(label: string, key: SortKey) {
    const active = sort.key === key;
    return (
      <th onClick={() => setSort((s) => ({ key, dir: s.key === key ? (s.dir === 1 ? -1 : 1) : -1 }))}>
        {label}
        {active ? (sort.dir === 1 ? " ↑" : " ↓") : ""}
      </th>
    );
  }

  const selectedWbal = selected && model ? wbalChart(selected, model.cp, model.wPrime) : null;
  const selectedBest5 = selected?.mmp?.[MMP_WINDOWS.indexOf(300)] ?? 0;

  return (
    <section className="page history-page">
      <header className="hero hero--compact">
        <p className="eyebrow">Analisi</p>
        <h1>Storico</h1>
      </header>

      <div className="tabs-row">
        {(
          [
            ["sessions", "Sessioni"],
            ["trend", "Trend e carico"],
            ["curve", "Curva di potenza"],
          ] as [Tab, string][]
        ).map(([id, label]) => (
          <button key={id} type="button" className={`mode-tab${tab === id ? " mode-tab--active" : ""}`} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>

      {tab === "sessions" && (
        <>
          <div className="history-filters">
            <select value={period} onChange={(e) => setPeriod(e.target.value)}>
              {PERIODS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
            <select value={source} onChange={(e) => setSource(e.target.value as typeof source)}>
              <option value="all">Tutte le fonti</option>
              <option value="completed">Rullo WattLab</option>
              <option value="imported">Importate</option>
            </select>
            <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value as SessionType | "all")}>
              <option value="all">Tutti i tipi</option>
              {SESSION_TYPE_KEYS.map((t) => (
                <option key={t} value={t}>
                  {SESSION_TYPE_META[t].label}
                </option>
              ))}
            </select>
            <select value={sportFilter} onChange={(e) => setSportFilter(e.target.value)}>
              <option value="all">Tutti gli sport</option>
              {Object.entries(SPORT_META).map(([id, meta]) => (
                <option key={id} value={id}>
                  {meta.label}
                </option>
              ))}
            </select>
            <input placeholder="Cerca titolo…" value={query} onChange={(e) => setQuery(e.target.value)} />
            <span className="muted-copy">
              {totals.sessions} sessioni · {formatDuration(totals.secs)} · {totals.tss} TSS · {totals.kj} kJ
            </span>
          </div>

          <div className="panel table-scroll">
            <table className="history-table">
              <thead>
                <tr>
                  {header("Data", "date")}
                  <th>Sessione</th>
                  {header("Durata", "durationSecs")}
                  {header("TSS", "tss")}
                  {header("IF", "ifactor")}
                  {header("NP", "np")}
                  {header("FC", "avgHr")}
                  {header("RPE", "rpe")}
                  {header("Compliance", "compliance")}
                </tr>
              </thead>
              <tbody>
                {filtered.map((e) => {
                  const level = complianceLevel(e.compliance);
                  return (
                    <tr key={e.id} className={selectedId === e.id ? "is-selected" : ""} onClick={() => setSelectedId((p) => (p === e.id ? null : e.id))}>
                      <td>{e.date}</td>
                      <td>
                        <i className="cal-entry-swatch" style={{ background: e.sport ? sportColor(e.sport) : sessionColor(e) }} />
                        {e.sport ? `${sportLabel(e.sport)} · ` : ""}
                        {e.title}
                      </td>
                      <td>{e.durationSecs ? formatDuration(e.durationSecs) : "–"}</td>
                      <td>{activityTss(e, profile) ? Math.round(activityTss(e, profile)) : "–"}</td>
                      <td>{e.ifactor ? e.ifactor.toFixed(2) : "–"}</td>
                      <td>{e.np ?? e.avgPower ?? "–"}</td>
                      <td>{e.avgHr ?? "–"}</td>
                      <td>{e.rpe ?? "–"}</td>
                      <td>{e.compliance != null ? <span className={`metric--${level}`}>{e.compliance}%</span> : "–"}</td>
                    </tr>
                  );
                })}
                {filtered.length === 0 && (
                  <tr>
                    <td colSpan={9} className="muted-copy">
                      Nessuna sessione con questi filtri.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {selected && (
            <div className="panel">
              <h3>
                {selected.title} · {selected.date}
              </h3>
              <EntryMetricsGrid entry={selected} profile={profile} />
              {model && selectedBest5 > 0 && (
                <p className="muted-copy">
                  Miglior 5' {selectedBest5} W ({Math.round((selectedBest5 / model.ftp) * 100)}% FTP) · lattato stimato a fine sforzo ~
                  {lactateAfter(selectedBest5, 300, model.params).toFixed(1)} mmol/l
                </p>
              )}
              {selected.coachComment && (
                <div className="eval-card eval-card--compact">
                  <p className="eyebrow">Commento coach</p>
                  <RichText text={selected.coachComment} className="rich-text--prose" />
                </div>
              )}
              <div className="panel-grid">
                <ZoneBars zoneSecs={selected.zoneSecs} />
                {selectedWbal && (
                  <div className="panel">
                    <CoachChart chart={selectedWbal} height={200} />
                  </div>
                )}
              </div>
              {selected.series && selected.series.length > 0 && <SessionSeriesChart series={selected.series} />}
            </div>
          )}
        </>
      )}

      {tab === "trend" && (
        <>
          <div className="metrics-grid">
            <div className="metric metric--accent">
              <span className="metric__label">CTL fitness</span>
              <strong className="metric__value">{load.ctl}</strong>
            </div>
            <div className="metric">
              <span className="metric__label">ATL fatica</span>
              <strong className="metric__value">{load.atl}</strong>
            </div>
            <div className="metric">
              <span className="metric__label">TSB forma</span>
              <strong className="metric__value">{load.tsb}</strong>
            </div>
            <div className="metric">
              <span className="metric__label">Ramp rate</span>
              <strong className="metric__value">{load.rampRate}/sett</strong>
            </div>
            <div className="metric">
              <span className="metric__label">Monotonia</span>
              <strong className="metric__value">{load.monotony}</strong>
            </div>
            <div className="metric">
              <span className="metric__label">ACWR</span>
              <strong className="metric__value">{load.acwr}</strong>
            </div>
          </div>
          <p className="muted-copy">{load.summary}</p>
          <div className="panel">
            <CoachChart chart={pmcChart} height={260} />
          </div>
          <div className="panel-grid">
            <div className="panel">
              <CoachChart chart={weeklyChart} height={220} />
            </div>
            <div className="panel">
              <CoachChart chart={zonesChart} height={220} />
            </div>
            <div className="panel">
              <CoachChart chart={fitnessTrend} height={220} />
            </div>
            <div className="panel">
              <h3>Durabilità</h3>
              {model?.durability && model.durability.sessions > 0 ? (
                <dl className="kv-list">
                  <dt>Sessioni analizzate</dt>
                  <dd>{model.durability.sessions} (dopo {model.durability.kjThreshold} kJ)</dd>
                  <dt>Miglior 5' da affaticato</dt>
                  <dd>
                    {model.durability.p5Fatigued ?? "–"} W {model.durability.p5Pct ? `(${model.durability.p5Pct}% del fresco)` : ""}
                  </dd>
                  <dt>Miglior 20' da affaticato</dt>
                  <dd>
                    {model.durability.p20Fatigued ?? "–"} W {model.durability.p20Pct ? `(${model.durability.p20Pct}% del fresco)` : ""}
                  </dd>
                </dl>
              ) : (
                <p className="muted-copy">Servono uscite oltre 1500 kJ con serie di potenza per stimare la durabilità.</p>
              )}
            </div>
          </div>
        </>
      )}

      {tab === "curve" && (
        <>
          <div className="panel">{curveChart ? <CoachChart chart={curveChart} height={300} /> : <p className="muted-copy">Nessuna sessione con potenza.</p>}</div>
          {model && (
            <div className="panel table-scroll">
              <table className="history-table">
                <thead>
                  <tr>
                    <th>Durata</th>
                    <th>Watt (90 g)</th>
                    <th>W/kg</th>
                    <th>Data</th>
                  </tr>
                </thead>
                <tbody>
                  {model.best
                    .filter((b) => b.watts > 0)
                    .map((b) => (
                      <tr key={b.secs}>
                        <td>{MMP_LABELS[MMP_WINDOWS.indexOf(b.secs)]}</td>
                        <td>{b.watts}</td>
                        <td>{(b.watts / model.weightKg).toFixed(2)}</td>
                        <td>{b.date ?? "–"}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}
