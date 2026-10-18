/** Bike + rider physics: estimated watts at a typical climbing speed (UI only). */

export const BIKE_KG = 8;
const G = 9.80665;
const CRR = 0.0045;
const CDA = 0.32;
const RHO = 1.18;

/**
 * Canonical climbing speed from grade, same for every rider.
 * Heavier riders therefore produce more watts (user requirement).
 * ~18 km/h @ 4%, ~12 km/h @ 8%, ~9 km/h @ 11%, ~6.5 km/h @ 15%.
 */
export function speedKmhFromGrade(gradePercent: number): number {
  const g = Math.max(0, gradePercent);
  return Math.max(5.5, 22 * Math.exp(-0.085 * g));
}

export function wattsForClimb(
  riderKg: number,
  gradePercent: number,
  speedKmh?: number,
): number {
  const mass = Math.max(40, riderKg) + BIKE_KG;
  const grade = gradePercent / 100;
  const theta = Math.atan(grade);
  const v = ((speedKmh ?? speedKmhFromGrade(gradePercent)) / 3.6);

  const climb = mass * G * v * Math.sin(theta);
  const roll = CRR * mass * G * v * Math.cos(theta);
  const aero = 0.5 * CDA * RHO * v * v * v;
  return Math.max(0, Math.round(climb + roll + aero));
}

export function secondsForMeters(distanceM: number, gradePercent: number): number {
  const v = speedKmhFromGrade(gradePercent) / 3.6;
  return distanceM / v;
}
