import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/data/climbs");

function recompute(samples) {
  let pts = samples.map((s) => ({ ...s }));
  if (pts.length < 2) return pts;
  const gain = pts[pts.length - 1].elevationM - pts[0].elevationM;
  if (gain < 0) pts = pts.reverse();

  const out = [];
  let dist = 0;
  for (let i = 0; i < pts.length; i += 1) {
    if (i > 0) {
      dist += Math.abs(pts[i].distanceM - pts[i - 1].distanceM);
    }
    out.push({
      distanceM: Math.round(dist),
      elevationM: pts[i].elevationM,
      gradePercent: 0,
    });
  }

  for (let i = 0; i < out.length; i += 1) {
    let j = i;
    while (j < out.length - 1 && out[j].distanceM - out[i].distanceM < 40) j += 1;
    const dx = Math.max(1, out[j].distanceM - out[i].distanceM);
    const dy = out[j].elevationM - out[i].elevationM;
    out[i].gradePercent = Math.round(Math.max(-8, Math.min(28, (dy / dx) * 100)) * 10) / 10;
  }
  out[out.length - 1].gradePercent = out[out.length - 2]?.gradePercent ?? 0;
  return out;
}

const files = fs.readdirSync(DIR).filter((f) => f.endsWith(".json") && f !== "index.json");
const index = [];
for (const file of files) {
  const full = path.join(DIR, file);
  const profile = JSON.parse(fs.readFileSync(full, "utf8"));
  profile.samples = recompute(profile.samples);
  const first = profile.samples[0];
  const last = profile.samples[profile.samples.length - 1];
  const gain = last.elevationM - first.elevationM;
  profile.lengthM = last.distanceM;
  profile.startElevationM = first.elevationM;
  profile.summitElevationM = last.elevationM;
  profile.avgGrade = last.distanceM > 0 ? Math.round((gain / last.distanceM) * 1000) / 10 : 0;
  fs.writeFileSync(full, JSON.stringify(profile));
  index.push({
    id: profile.id,
    name: profile.name,
    km: (profile.lengthM / 1000).toFixed(2),
    gain: Math.round(gain),
    avg: profile.avgGrade,
    points: profile.samples.length,
  });
  console.log(
    `${profile.id}: ${profile.lengthM} m, ${first.elevationM}→${last.elevationM} (+${Math.round(gain)} m), avg ${profile.avgGrade}%`,
  );
}
fs.writeFileSync(path.join(DIR, "index.json"), JSON.stringify(index, null, 2));
