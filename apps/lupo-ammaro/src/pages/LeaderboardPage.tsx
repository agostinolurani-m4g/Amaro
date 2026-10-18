import { useEffect, useMemo, useState } from "react";
import { fetchLeaderboard } from "../hooks/useLeaderboard";
import { formatHours, formatKm } from "../lib/sessionStats";
import type { AmaroMember, LeaderboardEntry, LeaderboardPeriod } from "../types";

interface LeaderboardPageProps {
  member: AmaroMember;
}

const PERIODS: { id: LeaderboardPeriod; label: string }[] = [
  { id: "week", label: "Settimana" },
  { id: "month", label: "Mese" },
  { id: "all", label: "Tutto" },
];

type SortKey = "distanceM" | "durationSecs" | "sessions" | "workKj" | "best20min";

function sortEntries(entries: LeaderboardEntry[], key: SortKey): LeaderboardEntry[] {
  return [...entries].sort((a, b) => {
    const av = a[key] ?? 0;
    const bv = b[key] ?? 0;
    return bv - av;
  });
}

export function LeaderboardPage({ member }: LeaderboardPageProps) {
  const [period, setPeriod] = useState<LeaderboardPeriod>("month");
  const [sortKey, setSortKey] = useState<SortKey>("distanceM");
  const [entries, setEntries] = useState<LeaderboardEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void fetchLeaderboard(period)
      .then((res) => {
        if (!cancelled) {
          setEntries(res.entries);
          setError(null);
        }
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [period]);

  const ranked = useMemo(() => sortEntries(entries, sortKey), [entries, sortKey]);

  return (
    <section className="page leaderboard-page">
      <header className="hero hero--compact">
        <p className="eyebrow">Tesserati Amaro</p>
        <h1>Classifica</h1>
        <p className="hero__copy">
          Km, ore in sella e lavoro tra i partecipanti WattLab. Ogni sessione indoor
          completata entra in classifica.
        </p>
      </header>

      <div className="chart-toolbar">
        <div className="chart-toolbar__group">
          {PERIODS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`btn btn--ghost btn--small ${period === item.id ? "btn--active" : ""}`}
              onClick={() => setPeriod(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      {loading && <p className="muted-copy">Caricamento classifica…</p>}
      {error && <p className="error-banner">{error}</p>}

      {!loading && !error && ranked.length === 0 && (
        <p className="muted-copy">Ancora nessuna sessione in classifica.</p>
      )}

      {ranked.length > 0 && (
        <div className="leaderboard-table-wrap">
          <table className="leaderboard-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Tesserato</th>
                <th>
                  <button type="button" onClick={() => setSortKey("distanceM")}>
                    Km {sortKey === "distanceM" ? "▾" : ""}
                  </button>
                </th>
                <th>
                  <button type="button" onClick={() => setSortKey("durationSecs")}>
                    Ore {sortKey === "durationSecs" ? "▾" : ""}
                  </button>
                </th>
                <th>
                  <button type="button" onClick={() => setSortKey("sessions")}>
                    Sessioni {sortKey === "sessions" ? "▾" : ""}
                  </button>
                </th>
                <th>
                  <button type="button" onClick={() => setSortKey("workKj")}>
                    kJ {sortKey === "workKj" ? "▾" : ""}
                  </button>
                </th>
                <th>
                  <button type="button" onClick={() => setSortKey("best20min")}>
                    Best 20 min {sortKey === "best20min" ? "▾" : ""}
                  </button>
                </th>
              </tr>
            </thead>
            <tbody>
              {ranked.map((row, index) => {
                const mine = row.memberId === member.id;
                return (
                  <tr key={row.memberId} className={mine ? "leaderboard-row--me" : ""}>
                    <td>{index + 1}</td>
                    <td>
                      {row.firstName} {row.lastName}
                      {mine ? " (tu)" : ""}
                    </td>
                    <td>{formatKm(row.distanceM)}</td>
                    <td>{formatHours(row.durationSecs)}</td>
                    <td>{row.sessions}</td>
                    <td>{Math.round(row.workKj)}</td>
                    <td>{row.best20min != null ? `${row.best20min} W` : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
