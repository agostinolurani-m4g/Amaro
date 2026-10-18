interface MetricProps {
  label: string;
  value: string;
  unit: string;
  accent?: boolean;
}

export function Metric({ label, value, unit, accent }: MetricProps) {
  return (
    <div className={`metric ${accent ? "metric--accent" : ""}`}>
      <span className="metric__label">{label}</span>
      <div className="metric__row">
        <span className="metric__value">{value}</span>
        <span className="metric__unit">{unit}</span>
      </div>
    </div>
  );
}
