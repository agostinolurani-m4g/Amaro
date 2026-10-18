import type { CalendarEntry, UserProfile } from "../types";
import { formatDuration } from "../lib/workoutEngine";
import { complianceLevel, entrySessionType, SESSION_TYPE_META } from "../lib/sessionTypes";
import { activityTss } from "../lib/activityLoad";
import { sportLabel } from "../lib/sportTypes";

function cell(label: string, value: string | number | null | undefined, accent = false) {
  if (value == null || value === "" || value === 0) return null;
  return (
    <div key={label} className={`metric${accent ? " metric--accent" : ""}`}>
      <span className="metric__label">{label}</span>
      <strong className="metric__value">{value}</strong>
    </div>
  );
}

export function EntryMetricsGrid({ entry, profile }: { entry: CalendarEntry; profile?: UserProfile | null }) {
  const type = entrySessionType(entry);
  const level = complianceLevel(entry.compliance);
  const planned = entry.entryType === "planned";
  const tss = Math.round(activityTss(entry, profile));
  return (
    <div className="metrics-grid metrics-grid--dense">
      {cell("Durata", entry.durationSecs ? formatDuration(entry.durationSecs) : null)}
      {cell(planned ? "TSS previsto" : "TSS", tss || null, true)}
      {!planned && cell("TSS pianificato", entry.plannedTss ? Math.round(entry.plannedTss) : null)}
      {cell("NP", entry.np ? `${entry.np} W` : null)}
      {cell("Media", entry.avgPower ? `${entry.avgPower} W` : null)}
      {cell("Max", entry.maxPower ? `${entry.maxPower} W` : null)}
      {cell("IF", entry.ifactor ? entry.ifactor.toFixed(2) : null)}
      {cell("Lavoro", entry.kj ? `${Math.round(entry.kj)} kJ` : null)}
      {cell("FC media", entry.avgHr ? `${entry.avgHr} bpm` : null)}
      {cell("FC max", entry.maxHr ? `${entry.maxHr} bpm` : null)}
      {cell("Cadenza", entry.avgCadence ? `${entry.avgCadence} rpm` : null)}
      {cell("Distanza", entry.distanceM ? `${(entry.distanceM / 1000).toFixed(1)} km` : null)}
      {cell("Disaccopp.", entry.decoupling != null ? `${entry.decoupling.toFixed(1)}%` : null)}
      {cell("RPE", entry.rpe ? `${entry.rpe}/10` : null)}
      {cell("Tipo", type ? SESSION_TYPE_META[type].label : entry.sport ? sportLabel(entry.sport) : null)}
      {entry.compliance != null && (
        <div className={`metric metric--compliance metric--${level}`}>
          <span className="metric__label">Compliance</span>
          <strong className="metric__value">{entry.compliance}%</strong>
        </div>
      )}
    </div>
  );
}
