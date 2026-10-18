import type { ZoneShare } from "../types";

interface ZoneBarsProps {
  title: string;
  zones: ZoneShare[];
}

export function ZoneBars({ title, zones }: ZoneBarsProps) {
  const hasData = zones.some((z) => z.seconds > 0);
  return (
    <div className="zone-panel">
      <h3>{title}</h3>
      {!hasData ? (
        <p className="artifact__meta">Nessun campione in queste zone.</p>
      ) : (
        <ul className="zone-list">
          {zones.map((z) => (
            <li key={z.id} className="zone-row">
              <span className="zone-row__label">{z.label}</span>
              <div className="zone-row__track">
                <div
                  className="zone-row__fill"
                  style={{ width: `${Math.min(100, z.percent)}%`, background: z.color }}
                />
              </div>
              <span className="zone-row__pct">{z.percent.toFixed(0)}%</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
