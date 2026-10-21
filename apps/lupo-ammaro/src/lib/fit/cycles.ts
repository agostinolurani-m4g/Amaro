import type { Point2 } from "./angles";
import { kneeFlexionDeg } from "./angles";

export interface FrameLandmarks {
  timeSec: number;
  hip: Point2;
  knee: Point2;
  ankle: Point2;
  visibility: number;
  flexionDeg: number;
  /** Punto morto basso incluso nella media. */
  bdc: boolean;
}

export interface PedalCycle {
  startFrame: number;
  bdcFrame: number;
  endFrame: number;
  kneeFlexionAtBdc: number;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? NaN;
}

/** Smussa i landmark di un frame con i vicini temporali, così un salto singolo non sposta l'angolo. */
export function smoothFrames(frames: FrameLandmarks[], radius = 1): FrameLandmarks[] {
  const maxGapSec = (radius + 0.5) / 30 + 0.02;
  return frames.map((frame, i) => {
    const window: FrameLandmarks[] = [];
    for (let j = i - radius; j <= i + radius; j++) {
      const other = frames[j];
      if (!other) continue;
      if (Math.abs(other.timeSec - frame.timeSec) <= maxGapSec) window.push(other);
    }
    const hip = {
      x: median(window.map((f) => f.hip.x)),
      y: median(window.map((f) => f.hip.y)),
    };
    const knee = {
      x: median(window.map((f) => f.knee.x)),
      y: median(window.map((f) => f.knee.y)),
    };
    const ankle = {
      x: median(window.map((f) => f.ankle.x)),
      y: median(window.map((f) => f.ankle.y)),
    };
    return {
      ...frame,
      hip,
      knee,
      ankle,
      flexionDeg: kneeFlexionDeg(hip, knee, ankle),
      bdc: false,
    };
  });
}

/**
 * Indici del punto morto basso: caviglia più bassa nell'immagine (y maggiore).
 * I picchi troppo vicini o troppo alti nel fotogramma (non è il fondo della pedalata) si scartano.
 */
export function findBdcIndices(
  ankleY: number[],
  times: number[],
  minGapSec = 0.45,
): number[] {
  const bdcs: number[] = [];
  for (let i = 1; i < ankleY.length - 1; i++) {
    if (ankleY[i] < ankleY[i - 1] || ankleY[i] < ankleY[i + 1]) continue;
    const last = bdcs[bdcs.length - 1];
    if (last === undefined || times[i] - times[last] >= minGapSec) {
      bdcs.push(i);
    } else if (ankleY[i] > ankleY[last]) {
      bdcs[bdcs.length - 1] = i;
    }
  }
  if (bdcs.length === 0) return bdcs;

  const finite = ankleY.filter((y) => Number.isFinite(y));
  const hi = Math.max(...bdcs.map((i) => ankleY[i]));
  const lo = Math.min(...finite);
  const range = hi - lo;
  if (range < 1e-4) return bdcs;
  const cutoff = hi - range * 0.4;
  return bdcs.filter((i) => ankleY[i] >= cutoff);
}

export function buildCycles(
  input: FrameLandmarks[],
  minCycles = 8,
): {
  cycles: PedalCycle[];
  meanFlexion: number;
  stdFlexion: number;
  frames: FrameLandmarks[];
} {
  const frames = smoothFrames(input);
  const ankleY = frames.map((f) => f.ankle.y);
  const times = frames.map((f) => f.timeSec);
  const bdcs = findBdcIndices(ankleY, times);
  const cycles: PedalCycle[] = [];

  for (let i = 0; i < bdcs.length - 1; i++) {
    const start = bdcs[i];
    const end = bdcs[i + 1];
    const flex = frames[start]?.flexionDeg;
    if (!Number.isFinite(flex)) continue;
    cycles.push({
      startFrame: start,
      bdcFrame: start,
      endFrame: end,
      kneeFlexionAtBdc: flex,
    });
  }

  const flexions = cycles.map((c) => c.kneeFlexionAtBdc);
  if (flexions.length === 0) {
    return { cycles: [], meanFlexion: NaN, stdFlexion: NaN, frames };
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
  for (const cycle of use) {
    const frame = frames[cycle.bdcFrame];
    if (frame) frame.bdc = true;
  }
  return { cycles: use, meanFlexion: m, stdFlexion: Math.sqrt(v), frames };
}
