export interface Point2 {
  x: number;
  y: number;
}

/** Angolo interno al vertice `vertex` (gradi). */
export function internalAngleDeg(a: Point2, vertex: Point2, c: Point2): number {
  const v1x = a.x - vertex.x;
  const v1y = a.y - vertex.y;
  const v2x = c.x - vertex.x;
  const v2y = c.y - vertex.y;
  const dot = v1x * v2x + v1y * v2y;
  const m1 = Math.hypot(v1x, v1y);
  const m2 = Math.hypot(v2x, v2y);
  if (m1 < 1e-6 || m2 < 1e-6) return NaN;
  const cos = Math.min(1, Math.max(-1, dot / (m1 * m2)));
  return (Math.acos(cos) * 180) / Math.PI;
}

/** Flessione ginocchio = 180° − angolo interno anca-ginocchio-caviglia. */
export function kneeFlexionDeg(hip: Point2, knee: Point2, ankle: Point2): number {
  const internal = internalAngleDeg(hip, knee, ankle);
  if (!Number.isFinite(internal)) return NaN;
  return 180 - internal;
}

/**
 * Distanza anca–caviglia al BDC dal teorema del coseno (L1 femore, L2 tibia, θ angolo interno).
 */
export function hipAnkleDistanceMm(
  femurMm: number,
  tibiaMm: number,
  internalKneeAngleDeg: number,
): number {
  const θ = (internalKneeAngleDeg * Math.PI) / 180;
  const d = Math.sqrt(
    femurMm * femurMm + tibiaMm * tibiaMm - 2 * femurMm * tibiaMm * Math.cos(θ),
  );
  return d;
}

export function saddleDeltaMm(
  femurMm: number,
  tibiaMm: number,
  measuredFlexionDeg: number,
  targetFlexionDeg: number,
): number {
  const internalMeasured = 180 - measuredFlexionDeg;
  const internalTarget = 180 - targetFlexionDeg;
  const dMeas = hipAnkleDistanceMm(femurMm, tibiaMm, internalMeasured);
  const dTarget = hipAnkleDistanceMm(femurMm, tibiaMm, internalTarget);
  return dTarget - dMeas;
}

export function estimateLegSegmentsMm(heightCm: number, anthropometry: {
  inseamMm?: number;
  femurMm?: number;
  tibiaMm?: number;
}): { femurMm: number; tibiaMm: number; approximate: boolean } {
  if (anthropometry.femurMm && anthropometry.tibiaMm) {
    return {
      femurMm: anthropometry.femurMm,
      tibiaMm: anthropometry.tibiaMm,
      approximate: false,
    };
  }
  const inseam = anthropometry.inseamMm ?? heightCm * 10 * 0.47;
  const femurMm = anthropometry.femurMm ?? inseam * 0.53;
  const tibiaMm = anthropometry.tibiaMm ?? inseam * 0.47;
  return { femurMm, tibiaMm, approximate: true };
}
