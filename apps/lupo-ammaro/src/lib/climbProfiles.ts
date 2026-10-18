import { secondsForMeters, wattsForClimb } from "./climbPhysics";
import alpeHuez from "../data/climbs/alpe-huez.json";
import finestre from "../data/climbs/finestre.json";
import gavia from "../data/climbs/gavia.json";
import giau from "../data/climbs/giau.json";
import kwaremont from "../data/climbs/kwaremont.json";
import lesima from "../data/climbs/lesima.json";
import nivolet from "../data/climbs/nivolet.json";
import paterberg from "../data/climbs/paterberg.json";
import pentema from "../data/climbs/pentema.json";
import stelvio from "../data/climbs/stelvio.json";

export interface ClimbSample {
  distanceM: number;
  elevationM: number;
  gradePercent: number;
}

export interface ClimbProfile {
  id: string;
  name: string;
  source: string;
  lengthM: number;
  startElevationM: number;
  summitElevationM: number;
  avgGrade: number;
  samples: ClimbSample[];
}

function asProfile(raw: unknown): ClimbProfile {
  return raw as ClimbProfile;
}

/** OSM bike route + OpenTopoData DEM, sampled ~every 10 m (not interpolated km keypoints). */
export const CLIMB_PROFILES: ClimbProfile[] = [
  asProfile(lesima),
  asProfile(finestre),
  asProfile(nivolet),
  asProfile(alpeHuez),
  asProfile(giau),
  asProfile(kwaremont),
  asProfile(pentema),
  asProfile(stelvio),
  asProfile(gavia),
  asProfile(paterberg),
];

const BY_ID = new Map(CLIMB_PROFILES.map((p) => [p.id, p]));

export function getClimbProfile(id: string | undefined): ClimbProfile | undefined {
  if (!id) return undefined;
  return BY_ID.get(id);
}

export function sampleAtDistance(profile: ClimbProfile, distanceM: number): ClimbSample {
  const samples = profile.samples;
  const first = samples[0];
  const last = samples[samples.length - 1];
  if (!first || !last) {
    return { distanceM: 0, elevationM: 0, gradePercent: 0 };
  }
  const clamped = Math.max(0, Math.min(distanceM, profile.lengthM));
  let lo = 0;
  let hi = samples.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (samples[mid].distanceM <= clamped) lo = mid;
    else hi = mid - 1;
  }
  const a = samples[lo];
  const b = samples[Math.min(lo + 1, samples.length - 1)];
  if (a.distanceM === b.distanceM) return a;
  const t = (clamped - a.distanceM) / (b.distanceM - a.distanceM);
  return {
    distanceM: clamped,
    elevationM: a.elevationM + (b.elevationM - a.elevationM) * t,
    gradePercent: a.gradePercent + (b.gradePercent - a.gradePercent) * t,
  };
}

export function climbDurationSecs(profile: ClimbProfile): number {
  let secs = 0;
  for (let i = 1; i < profile.samples.length; i += 1) {
    const dx = profile.samples[i].distanceM - profile.samples[i - 1].distanceM;
    secs += secondsForMeters(dx, profile.samples[i].gradePercent);
  }
  return Math.round(secs);
}

export function estimatedWattsAt(
  profile: ClimbProfile,
  distanceM: number,
  riderKg: number,
): number {
  const sample = sampleAtDistance(profile, distanceM);
  return wattsForClimb(riderKg, sample.gradePercent);
}

export function chartPoints(profile: ClimbProfile, everyM = 20): ClimbSample[] {
  const out: ClimbSample[] = [];
  let last = -everyM;
  for (const s of profile.samples) {
    if (s.distanceM - last >= everyM) {
      out.push(s);
      last = s.distanceM;
    }
  }
  const tail = profile.samples[profile.samples.length - 1];
  if (tail && out[out.length - 1] !== tail) out.push(tail);
  return out;
}
