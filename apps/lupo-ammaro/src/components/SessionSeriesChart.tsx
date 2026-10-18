import "uplot/dist/uPlot.min.css";
import uPlot from "uplot";
import { useEffect, useMemo, useRef } from "react";
import type { SessionSeriesPoint } from "../types";

interface SessionSeriesChartProps {
  series: SessionSeriesPoint[];
  height?: number;
}

export function SessionSeriesChart({
  series,
  height = 260,
}: SessionSeriesChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);

  const data = useMemo(() => {
    const t = series.map((p) => p.t);
    const power = series.map((p) => p.power ?? null);
    const target = series.map((p) => p.target ?? null);
    const hr = series.map((p) => p.hr ?? null);
    const cadence = series.map((p) => p.cadence ?? null);
    return [t, power, target, hr, cadence] as uPlot.AlignedData;
  }, [series]);

  useEffect(() => {
    if (!containerRef.current || series.length === 0) return;

    const opts: uPlot.Options = {
      width: containerRef.current.clientWidth,
      height,
      series: [
        {},
        { label: "Potenza", stroke: "#ff0a54", width: 2 },
        { label: "Target", stroke: "#fdcaca", width: 1, dash: [6, 4] },
        { label: "FC", stroke: "#ff4d6d", width: 1, scale: "hr" },
        { label: "Cadenza", stroke: "#4ade80", width: 1, scale: "cadence" },
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
          scale: "hr",
          side: 1,
          stroke: "#ff4d6d",
          grid: { show: false },
          label: "bpm",
        },
        {
          scale: "cadence",
          side: 1,
          stroke: "#4ade80",
          grid: { show: false },
          label: "rpm",
        },
      ],
      scales: {
        x: { time: false },
        hr: { auto: true },
        cadence: { auto: true },
      },
      legend: { show: true },
    };

    plotRef.current = new uPlot(opts, data, containerRef.current);

    const onResize = () => {
      if (plotRef.current && containerRef.current) {
        plotRef.current.setSize({
          width: containerRef.current.clientWidth,
          height,
        });
      }
    };
    window.addEventListener("resize", onResize);

    return () => {
      window.removeEventListener("resize", onResize);
      plotRef.current?.destroy();
      plotRef.current = null;
    };
  }, [height, series.length]);

  useEffect(() => {
    if (!plotRef.current || series.length === 0) return;
    plotRef.current.setData(data);
  }, [data, series.length]);

  if (series.length === 0) {
    return null;
  }

  return <div className="session-series-chart" ref={containerRef} />;
}
