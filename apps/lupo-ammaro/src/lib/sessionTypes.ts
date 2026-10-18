import type { CalendarEntry, SessionType } from "../types";

export const SESSION_TYPE_META: Record<SessionType, { label: string; short: string; color: string }> = {
  recovery: { label: "Recupero attivo", short: "REC", color: "#8a93a8" },
  z2: { label: "Endurance Z2", short: "Z2", color: "#60a5fa" },
  tempo: { label: "Tempo", short: "TEMPO", color: "#4ade80" },
  sst: { label: "Sweet spot", short: "SST", color: "#a3e635" },
  threshold: { label: "Soglia", short: "SOGLIA", color: "#facc15" },
  overunder: { label: "Over-under", short: "O/U", color: "#fbbf24" },
  vo2: { label: "VO2max", short: "VO2", color: "#fb923c" },
  vo2_30_30: { label: "VO2 30/30", short: "30/30", color: "#f97316" },
  anaerobic: { label: "Capacità anaerobica", short: "ANA", color: "#ff0a54" },
  lowcadence: { label: "Forza (bassa cadenza)", short: "FORZA", color: "#e879f9" },
  durability: { label: "Lungo + durabilità", short: "LUNGO", color: "#38bdf8" },
  ftp_test: { label: "Test FTP", short: "TEST", color: "#c084fc" },
  openers: { label: "Attivazione pre-gara", short: "OPEN", color: "#f472b6" },
};

export const SESSION_TYPE_KEYS = Object.keys(SESSION_TYPE_META) as SessionType[];

/** Tipo di sessione dichiarato o dedotto dall'IF per le sessioni svolte. */
export function entrySessionType(entry: Pick<CalendarEntry, "sessionType" | "ifactor">): SessionType | null {
  if (entry.sessionType && entry.sessionType in SESSION_TYPE_META) return entry.sessionType as SessionType;
  const ifv = entry.ifactor;
  if (!ifv) return null;
  if (ifv < 0.62) return "recovery";
  if (ifv < 0.76) return "z2";
  if (ifv < 0.85) return "tempo";
  if (ifv < 0.92) return "sst";
  if (ifv < 1.02) return "threshold";
  return "vo2";
}

export function sessionColor(entry: Pick<CalendarEntry, "sessionType" | "ifactor">): string {
  const t = entrySessionType(entry);
  return t ? SESSION_TYPE_META[t].color : "#fdcaca";
}

export type ComplianceLevel = "good" | "warn" | "bad";

export function complianceLevel(value: number | undefined | null): ComplianceLevel | null {
  if (value == null) return null;
  if (value >= 80 && value <= 120) return "good";
  if (value >= 50 && value <= 140) return "warn";
  return "bad";
}
