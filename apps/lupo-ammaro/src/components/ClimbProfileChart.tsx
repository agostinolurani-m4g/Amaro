import "uplot/dist/uPlot.min.css";
import uPlot from "uplot";
import { useEffect, useMemo, useRef } from "react";
import { wattsForClimb } from "../lib/climbPhysics";
import { chartPoints, type ClimbProfile } from "../lib/climbProfiles";

interface ClimbProfileChartProps {
  profile: ClimbProfile;
  riderKg: number;
  height?: number;
  distanceM?: number;
}

export function ClimbProfileChart({
  profile,
  riderKg,
  height = 220,
  distanceM,
}: ClimbProfileChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);
  const distanceRef = useRef(distanceM);
  distanceRef.current = distanceM;

  const data = useMemo(() => {
    const samples = chartPoints(profile, 20);
    return {
      x: samples.map((s) => s.distanceM / 1000),
      elev: samples.map((s) => s.elevationM),
      grade: samples.map((s) => s.gradePercent),
      watts: samples.map((s) => wattsForClimb(riderKg, s.gradePercent)),
    };
  }, [profile, riderKg]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const build = () => {
      const width = container.clientWidth;
      if (width <= 0) return;
      plotRef.current?.destroy();

      const elevMax = Math.max(...data.elev) + 40;
      const elevMin = Math.min(...data.elev) - 20;
      const wattMax = Math.max(...data.watts) * 1.12;

      const opts: uPlot.Options = {
        width,
        height,
        series: [
          {},
          {
            label: "Quota",
            stroke: "#fdcaca",
            width: 2,
            fill: "rgba(253, 202, 202, 0.18)",
            scale: "elev",
            points: { show: false },
          },
          {
            label: "Stima W",
            stroke: "#ff0a54",
            width: 2,
            scale: "w",
            points: { show: false },
          },
        ],
        axes: [
          {
            stroke: "#8a93a8",
            grid: { stroke: "rgba(255,255,255,0.06)" },
            values: (_u, ticks) => ticks.map((t) => `${t.toFixed(1)} km`),
          },
          {
            scale: "elev",
            stroke: "#fdcaca",
            grid: { stroke: "rgba(255,255,255,0.06)" },
            label: "m",
          },
          {
            scale: "w",
            side: 1,
            stroke: "#ff0a54",
            grid: { show: false },
            label: "W",
          },
        ],
        scales: {
          x: { time: false, min: 0, max: profile.lengthM / 1000 },
          elev: { min: elevMin, max: elevMax },
          w: { min: 0, max: wattMax },
        },
        legend: { show: true },
        hooks: {
          draw: [
            (u) => {
              const d = distanceRef.current;
              if (d == null) return;
              const x = u.valToPos(d / 1000, "x", true);
              const ctx = u.ctx;
              ctx.save();
              ctx.strokeStyle = "#ff0a54";
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

      plotRef.current = new uPlot(opts, [data.x, data.elev, data.watts], container);
    };

    build();
    const ro = new ResizeObserver(() => {
      if (!plotRef.current) {
        build();
        return;
      }
      const width = container.clientWidth;
      if (width > 0) plotRef.current.setSize({ width, height });
    });
    ro.observe(container);
    return () => {
      ro.disconnect();
      plotRef.current?.destroy();
      plotRef.current = null;
    };
  }, [data, height, profile.lengthM]);

  useEffect(() => {
    plotRef.current?.redraw();
  }, [distanceM]);

  return (
    <div
      className="workout-profile-chart"
      ref={containerRef}
      style={{ minHeight: height, width: "100%" }}
    />
  );
}
