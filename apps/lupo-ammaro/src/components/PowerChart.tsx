import "uplot/dist/uPlot.min.css";
import uPlot from "uplot";
import { useEffect, useRef, useState } from "react";
import type { Telemetry, TimelineStep } from "../types";

interface PowerChartProps {
  telemetry: Telemetry | null;
  targetPower?: number;
  timeline?: TimelineStep[];
  elapsedSecs?: number;
}

const WINDOW_SECS = 300;

type ChartWindow = "rolling" | "full";

interface SeriesToggle {
  power: boolean;
  target: boolean;
  cadence: boolean;
  hr: boolean;
}

export function PowerChart({
  telemetry,
  targetPower,
  timeline = [],
  elapsedSecs = 0,
}: PowerChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);
  const dataRef = useRef({
    t: [] as number[],
    power: [] as number[],
    target: [] as number[],
    cadence: [] as number[],
    hr: [] as number[],
  });
  const startRef = useRef<number | null>(null);
  const timelineRef = useRef(timeline);
  const elapsedRef = useRef(elapsedSecs);
  const [windowMode, setWindowMode] = useState<ChartWindow>("rolling");
  const [series, setSeries] = useState<SeriesToggle>({
    power: true,
    target: true,
    cadence: true,
    hr: true,
  });
  timelineRef.current = timeline;
  elapsedRef.current = elapsedSecs;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const build = () => {
      if (plotRef.current) return;
      const width = container.clientWidth;
      if (width <= 0) return;

      const opts: uPlot.Options = {
        width,
        height: 280,
      series: [
        {},
        { label: "Potenza", stroke: "#ff0a54", width: 2 },
        { label: "Target", stroke: "#fdcaca", width: 1, dash: [6, 4] },
        { label: "Cadenza", stroke: "#4ade80", width: 1, scale: "cadence" },
        { label: "FC", stroke: "#ff4d6d", width: 1, scale: "hr" },
      ],
      axes: [
        {
          stroke: "#8a93a8",
          grid: { stroke: "rgba(255,255,255,0.06)" },
          values: (_u, ticks) =>
            ticks.map((v) => {
              const m = Math.floor(v / 60);
              const s = Math.floor(v % 60);
              return `${m}:${s.toString().padStart(2, "0")}`;
            }),
        },
        {
          stroke: "#8a93a8",
          grid: { stroke: "rgba(255,255,255,0.06)" },
          label: "W",
        },
        {
          scale: "cadence",
          side: 1,
          stroke: "#4ade80",
          grid: { show: false },
          label: "rpm",
        },
        {
          scale: "hr",
          side: 1,
          stroke: "#ff4d6d",
          grid: { show: false },
          label: "bpm",
        },
      ],
      scales: {
        x: { time: false },
        cadence: { auto: true },
        hr: { auto: true },
      },
      legend: { show: true },
      hooks: {
        draw: [
          (u) => {
            if (timelineRef.current.length === 0 || elapsedRef.current <= 0) return;
            const ctx = u.ctx;
            const x = u.valToPos(elapsedRef.current, "x", true);
            ctx.save();
            ctx.strokeStyle = "rgba(255, 107, 44, 0.7)";
            ctx.lineWidth = 1.5;
            ctx.setLineDash([4, 4]);
            ctx.beginPath();
            ctx.moveTo(x, u.bbox.top);
            ctx.lineTo(x, u.bbox.top + u.bbox.height);
            ctx.stroke();
            ctx.restore();
          },
        ],
      },
    };

    plotRef.current = new uPlot(opts, [[], [], [], [], []], container);
    if (dataRef.current.t.length > 0) {
      plotRef.current.setData([
        dataRef.current.t,
        dataRef.current.power,
        dataRef.current.target,
        dataRef.current.cadence,
        dataRef.current.hr,
      ]);
    }
    };

    build();

    const ro = new ResizeObserver(() => {
      if (!plotRef.current) {
        build();
        return;
      }
      const width = container.clientWidth;
      if (width > 0) {
        plotRef.current.setSize({ width, height: 280 });
      }
    });
    ro.observe(container);

    return () => {
      ro.disconnect();
      plotRef.current?.destroy();
      plotRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!plotRef.current) return;
    plotRef.current.setSeries(1, { show: series.power });
    plotRef.current.setSeries(2, { show: series.target });
    plotRef.current.setSeries(3, { show: series.cadence });
    plotRef.current.setSeries(4, { show: series.hr });
  }, [series]);

  useEffect(() => {
    plotRef.current?.redraw();
  }, [elapsedSecs]);

  useEffect(() => {
    if (!telemetry || !plotRef.current) return;

    if (startRef.current === null) {
      startRef.current = telemetry.timestampMs;
    }

    const elapsed = (telemetry.timestampMs - startRef.current) / 1000;
    const power = telemetry.power ?? 0;
    const target = targetPower ?? telemetry.targetPower ?? 0;
    const cadence = telemetry.cadence ?? 0;
    const hr = telemetry.heartRate ?? 0;

    dataRef.current.t.push(elapsed);
    dataRef.current.power.push(power);
    dataRef.current.target.push(target);
    dataRef.current.cadence.push(cadence);
    dataRef.current.hr.push(hr);

    if (windowMode === "rolling") {
      const minT = Math.max(0, elapsed - WINDOW_SECS);
      while (dataRef.current.t.length > 0 && dataRef.current.t[0] < minT) {
        dataRef.current.t.shift();
        dataRef.current.power.shift();
        dataRef.current.target.shift();
        dataRef.current.cadence.shift();
        dataRef.current.hr.shift();
      }
    } else if (dataRef.current.t.length > 7200) {
      const keepEvery = Math.ceil(dataRef.current.t.length / 7200);
      if (keepEvery > 1 && dataRef.current.t.length % keepEvery !== 0) {
        dataRef.current.t.pop();
        dataRef.current.power.pop();
        dataRef.current.target.pop();
        dataRef.current.cadence.pop();
        dataRef.current.hr.pop();
      }
    }

    const xMin =
      windowMode === "rolling" ? Math.max(0, elapsed - WINDOW_SECS) : 0;
    const xMax =
      windowMode === "rolling" ? Math.max(WINDOW_SECS, elapsed) : Math.max(elapsed, 60);

    plotRef.current.setScale("x", { min: xMin, max: xMax });
    plotRef.current.setData([
      dataRef.current.t,
      dataRef.current.power,
      dataRef.current.target,
      dataRef.current.cadence,
      dataRef.current.hr,
    ]);
  }, [telemetry, targetPower, windowMode]);

  return (
    <div className="power-chart-wrap">
      <div className="chart-toolbar">
        <div className="chart-toolbar__group">
          <button
            type="button"
            className={`btn btn--ghost btn--small ${windowMode === "rolling" ? "btn--active" : ""}`}
            onClick={() => setWindowMode("rolling")}
          >
            Ultimi 5 min
          </button>
          <button
            type="button"
            className={`btn btn--ghost btn--small ${windowMode === "full" ? "btn--active" : ""}`}
            onClick={() => setWindowMode("full")}
          >
            Tutta la sessione
          </button>
        </div>
        <div className="chart-toolbar__group">
          {(
            [
              ["power", "Potenza"],
              ["target", "Target"],
              ["cadence", "Cadenza"],
              ["hr", "FC"],
            ] as const
          ).map(([key, label]) => (
            <label key={key} className="chart-toggle">
              <input
                type="checkbox"
                checked={series[key]}
                onChange={(e) =>
                  setSeries((prev) => ({ ...prev, [key]: e.target.checked }))
                }
              />
              {label}
            </label>
          ))}
        </div>
      </div>
      <div className="power-chart" ref={containerRef} />
    </div>
  );
}
