import "uplot/dist/uPlot.min.css";
import uPlot from "uplot";
import { useEffect, useMemo, useRef } from "react";
import { pctFtpToGrade } from "../lib/climbModel";
import type { TimelineStep } from "../types";
import { chartTheme } from "../lib/chartTheme";

interface WorkoutProfileChartProps {
  timeline: TimelineStep[];
  ftp?: number;
  height?: number;
  elapsedSecs?: number;
  showCursor?: boolean;
  /** Mostra pendenza % invece di FTP/watt (salite SIM) */
  showGrade?: boolean;
}

function stepY(step: TimelineStep, showGrade: boolean): number {
  if (showGrade) {
    if (step.gradePercent != null) return step.gradePercent;
    return pctFtpToGrade(step.targetPctFtp);
  }
  return step.targetPctFtp;
}

function buildStepData(
  timeline: TimelineStep[],
  showGrade: boolean,
  ftp?: number,
): { x: number[]; y: number[]; yMax: number; yLabel: string } {
  const x: number[] = [];
  const y: number[] = [];

  timeline.forEach((step) => {
    const value = showGrade ? stepY(step, true) : ftp
      ? Math.round((ftp * step.targetPctFtp) / 100)
      : step.targetPctFtp;
    x.push(step.startOffsetSecs);
    y.push(value);
    x.push(step.startOffsetSecs + step.durationSecs);
    y.push(value);
  });

  const yMax = showGrade
    ? Math.max(8, Math.ceil(Math.max(...y, 0) + 1))
    : Math.max(100, Math.ceil(Math.max(...y, 0) * 1.1));

  const yLabel = showGrade ? "% pendenza" : ftp ? "W" : "% FTP";

  return { x, y, yMax, yLabel };
}

export function WorkoutProfileChart({
  timeline,
  ftp,
  height = 180,
  elapsedSecs,
  showCursor = false,
  showGrade = false,
}: WorkoutProfileChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);
  const elapsedRef = useRef(elapsedSecs);
  elapsedRef.current = elapsedSecs;
  const chartData = useMemo(
    () => buildStepData(timeline, showGrade, ftp),
    [timeline, showGrade, ftp],
  );
  const total = timeline.reduce((s, t) => s + t.durationSecs, 0);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || timeline.length === 0) return;

    const buildPlot = () => {
      const width = container.clientWidth;
      if (width <= 0) return;

      if (plotRef.current) {
        plotRef.current.destroy();
        plotRef.current = null;
      }

      const opts: uPlot.Options = {
        width,
        height,
        series: [
          {},
          {
            label: showGrade ? "Pendenza" : ftp ? "Target W" : "Target %FTP",
            stroke: chartTheme.target,
            width: chartTheme.width.main,
            fill: chartTheme.elevationFill,
            paths: uPlot.paths.stepped!({ align: 1 }),
            points: { show: false },
          },
        ],
        axes: [
          {
            stroke: chartTheme.axis,
            grid: { stroke: chartTheme.grid },
            values: (_u, ticks) =>
              ticks.map((t) => {
                const m = Math.floor(t / 60);
                const s = Math.floor(t % 60);
                return `${m}:${s.toString().padStart(2, "0")}`;
              }),
          },
          {
            stroke: chartTheme.axis,
            grid: { stroke: chartTheme.grid },
            label: chartData.yLabel,
            values: (_u, ticks) =>
              ticks.map((v) => (showGrade ? v.toFixed(1) : String(Math.round(v)))),
          },
        ],
        scales: {
          x: { time: false, min: 0, max: Math.max(total, 60) },
          y: { min: 0, max: chartData.yMax },
        },
        legend: { show: false },
        hooks: {
          draw: showCursor
            ? [
                (u) => {
                  const elapsed = elapsedRef.current;
                  if (elapsed == null || elapsed <= 0) return;
                  const ctx = u.ctx;
                  const px = u.valToPos(elapsed, "x", true);
                  ctx.save();
                  ctx.strokeStyle = chartTheme.power;
                  ctx.lineWidth = 2;
                  ctx.setLineDash([4, 4]);
                  ctx.beginPath();
                  ctx.moveTo(px, u.bbox.top);
                  ctx.lineTo(px, u.bbox.top + u.bbox.height);
                  ctx.stroke();
                  ctx.restore();
                },
              ]
            : [],
        },
      };

      plotRef.current = new uPlot(
        opts,
        [chartData.x, chartData.y],
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
  }, [chartData, height, total, showCursor, showGrade, ftp, timeline.length]);

  useEffect(() => {
    plotRef.current?.redraw();
  }, [elapsedSecs]);

  useEffect(() => {
    if (!plotRef.current) return;
    plotRef.current.setScale("y", { min: 0, max: chartData.yMax });
    plotRef.current.setScale("x", { min: 0, max: Math.max(total, 60) });
    plotRef.current.setData([chartData.x, chartData.y]);
  }, [chartData, total]);

  if (timeline.length === 0) {
    return (
      <p className="muted-copy chart-empty">Aggiungi blocchi per vedere il profilo.</p>
    );
  }

  return (
    <div
      className="workout-profile-chart"
      ref={containerRef}
      style={{ minHeight: height, width: "100%" }}
    />
  );
}
