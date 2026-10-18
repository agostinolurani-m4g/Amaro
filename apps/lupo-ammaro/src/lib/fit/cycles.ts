import type { Point2 } from "./angles";
import { kneeFlexionDeg } from "./angles";

export interface FrameLandmarks {
  hip: Point2;
  knee: Point2;
  ankle: Point2;
  visibility: number;
}

export interface PedalCycle {
  startFrame: number;
  bdcFrame: number;
  endFrame: number;
  kneeFlexionAtBdc: number;
}

/** Trova indici BDC (massimo y caviglia = punto più basso in immagine). */
export function findBdcIndices(ankleY: number[], minDistanceFrames = 8): number[] {
  const bdcs: number[] = [];
  for (let i = 1; i < ankleY.length - 1; i++) {
    if (ankleY[i] >= ankleY[i - 1] && ankleY[i] >= ankleY[i + 1]) {
      if (bdcs.length === 0 || i - bdcs[bdcs.length - 1] >= minDistanceFrames) {
        bdcs.push(i);
      } else if (ankleY[i] > ankleY[bdcs[bdcs.length - 1]]) {
        bdcs[bdcs.length - 1] = i;
      }
    }
  }
  return bdcs;
}

export function buildCycles(
  frames: FrameLandmarks[],
  minCycles = 8,
): { cycles: PedalCycle[]; meanFlexion: number; stdFlexion: number } {
  const ankleY = frames.map((f) => f.ankle.y);
  const bdcs = findBdcIndices(ankleY);
  const cycles: PedalCycle[] = [];

  for (let i = 0; i < bdcs.length - 1; i++) {
    const start = bdcs[i];
    const end = bdcs[i + 1];
    const bdc = start;
    const f = frames[bdc];
    const flex = kneeFlexionDeg(f.hip, f.knee, f.ankle);
    if (!Number.isFinite(flex)) continue;
    cycles.push({
      startFrame: start,
      bdcFrame: bdc,
      endFrame: end,
      kneeFlexionAtBdc: flex,
    });
  }

  const flexions = cycles.map((c) => c.kneeFlexionAtBdc);
  if (flexions.length === 0) {
    return { cycles: [], meanFlexion: NaN, stdFlexion: NaN };
  }

  const mean = flexions.reduce((a, b) => a + b, 0) / flexions.length;
  const variance =
    flexions.reduce((s, v) => s + (v - mean) ** 2, 0) / flexions.length;
  const std = Math.sqrt(variance);

  const filtered = cycles.filter(
    (c) => Math.abs(c.kneeFlexionAtBdc - mean) <= 2 * std || std < 1,
  );

  const use = filtered.length >= minCycles ? filtered : cycles;
  const vals = use.map((c) => c.kneeFlexionAtBdc);
  const m = vals.reduce((a, b) => a + b, 0) / vals.length;
  const v =
    vals.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, vals.length - 1);
  return { cycles: use, meanFlexion: m, stdFlexion: Math.sqrt(v) };
}
