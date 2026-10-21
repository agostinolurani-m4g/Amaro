import "uplot/dist/uPlot.min.css";
import uPlot from "uplot";
import { useEffect, useMemo, useRef } from "react";
import { SessionSeriesChart } from "./SessionSeriesChart";
import type { CoachChartData } from "../types";
import { chartTheme } from "../lib/chartTheme";

interface CoachChartProps {
  chart: CoachChartData;
  height?: number;
}

export function CoachChart({ chart, height = 240 }: CoachChartProps) {
  if (chart.kind === "session" && chart.sessionSeries?.length) {
    return (
      <div className="coach-chart coach-chart--session">
        <h4>{chart.title}</h4>
        <SessionSeriesChart series={chart.sessionSeries} height={height} />
      </div>
    );
  }

  if (!chart.x.length || !chart.series.length) {
    return (
      <div className="coach-chart coach-chart--empty">
        <h4>{chart.title}</h4>
        <p className="artifact__meta">Dati insufficienti per il grafico.</p>
      </div>
    );
  }

  return <CoachUPlotChart chart={chart} height={height} />;
}

function CoachUPlotChart({ chart, height }: { chart: CoachChartData; height: number }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);

  const chartData = useMemo(() => {
    const useIndex = chart.x.some((v) => typeof v === "string");
    const x = useIndex
      ? chart.x.map((_, i) => i)
      : chart.x.map((v) => (typeof v === "number" ? v : Number(v)));

    const seriesValues = chart.series.map((s) =>
      s.data.map((v) => (v == null || Number.isNaN(v) ? null : v)),
    );

    let yMax = 10;
    let yMin = 0;
    for (const row of seriesValues) {
      for (const v of row) {
        if (v != null && v > yMax) yMax = v;
        if (v != null && v < yMin) yMin = v;
      }
    }
    yMax = Math.ceil(yMax * 1.15);
    yMin = yMin < 0 ? Math.floor(yMin * 1.15) : 0;

    return { x, seriesValues, yMax, yMin, useIndex };
  }, [chart]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const buildPlot = () => {
      const width = container.clientWidth;
      if (width <= 0 || chartData.x.length === 0) return;

      if (plotRef.current) {
        plotRef.current.destroy();
        plotRef.current = null;
      }

      const colors = chart.series.map((s) => s.color ?? chartTheme.power);
      const opts: uPlot.Options = {
        width,
        height,
        series: [
          {},
          ...chart.series.map((s, i) => {
            const series: uPlot.Series = {
              label: s.label,
              stroke: colors[i],
              width: chartTheme.width.main,
            };
            if (i === 0) series.fill = chartTheme.powerFill;
            return series;
          }),
        ],
        axes: [
          {
            stroke: chartTheme.axis,
            grid: { stroke: chartTheme.grid },
            values: (_u, ticks) =>
              ticks.map((v) => {
                if (!chartData.useIndex) return String(Math.round(v));
                const raw = chart.x[Math.round(v)] ?? v;
                if (typeof raw === "string") {
                  return raw.includes("-") ? raw.slice(5) : raw;
                }
                return String(raw);
              }),
          },
          {
            stroke: chartTheme.axis,
            grid: { stroke: chartTheme.grid },
            label: chart.yLabel ?? "",
          },
        ],
        scales: {
          x: { time: false },
          y: { min: chartData.yMin, max: chartData.yMax },
        },
        legend: { show: true },
      };

      plotRef.current = new uPlot(
        opts,
        [chartData.x, ...chartData.seriesValues] as uPlot.AlignedData,
        container,
      );
    };

    buildPlot();

    const ro = new ResizeObserver(() => {
      if (!plotRef.current) {
        buildPlot();
        return;
      }
      const width = container.clientWidth;
      if (width > 0) {
        plotRef.current.setSize({ width, height });
      }
    });
    ro.observe(container);

    return () => {
      ro.disconnect();
      plotRef.current?.destroy();
      plotRef.current = null;
    };
  }, [chart, chartData, height]);

  return (
    <div className="coach-chart">
      <h4>{chart.title}</h4>
      <div className="coach-chart__plot" ref={containerRef} />
    </div>
  );
}
