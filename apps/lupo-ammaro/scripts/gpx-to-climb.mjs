/**
 * Crea un profilo salita/percorso da un GPX registrato (es. un giro del club).
 * Uso: node scripts/gpx-to-climb.mjs <file.gpx> <id> "<Nome>"
 * Scrive src/data/climbs/<id>.json e aggiorna index.json.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const OUT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/data/climbs");
const STEP_M = 10;

function haversineM(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function parseGpx(xml) {
  const pts = [];
  const re = /<trkpt\b[^>]*?lat="([-\d.]+)"[^>]*?lon="([-\d.]+)"[^>]*>([\s\S]*?)<\/trkpt>/g;
  for (const m of xml.matchAll(re)) {
    const ele = /<ele>([-\d.]+)<\/ele>/.exec(m[3]);
    if (ele) pts.push({ lat: Number(m[1]), lon: Number(m[2]), ele: Number(ele[1]) });
  }
  return pts;
}

/** Ricampiona ogni STEP_M metri interpolando la quota. */
function resample(pts) {
  const dist = [0];
  for (let i = 1; i < pts.length; i += 1) {
    dist.push(dist[i - 1] + haversineM(pts[i - 1].lat, pts[i - 1].lon, pts[i].lat, pts[i].lon));
  }
  const total = dist[dist.length - 1];
  const out = [];
  let j = 0;
  for (let d = 0; d <= total; d += STEP_M) {
    while (j < dist.length - 2 && dist[j + 1] < d) j += 1;
    const span = dist[j + 1] - dist[j] || 1;
    const t = Math.min(1, Math.max(0, (d - dist[j]) / span));
    out.push({ distanceM: d, elevationM: pts[j].ele + (pts[j + 1].ele - pts[j].ele) * t });
  }
  return out;
}

/** La quota GPS è rumorosa: media mobile su ~150 m. */
function smooth(values, window = 15) {
  const half = Math.floor(window / 2);
  return values.map((_, i) => {
    let s = 0;
    let n = 0;
    for (let k = Math.max(0, i - half); k <= Math.min(values.length - 1, i + half); k += 1) {
      s += values[k];
      n += 1;
    }
    return s / n;
  });
}

const [gpxPath, id, name] = process.argv.slice(2);
if (!gpxPath || !id || !name) {
  console.error('Uso: node scripts/gpx-to-climb.mjs <file.gpx> <id> "<Nome>"');
  process.exit(1);
}

const pts = parseGpx(fs.readFileSync(gpxPath, "utf8"));
if (pts.length < 2) {
  console.error("GPX senza punti con quota.");
  process.exit(1);
}

const raw = resample(pts);
const elev = smooth(raw.map((s) => s.elevationM));
const samples = raw.map((s, i) => {
  const look = Math.min(raw.length - 1, i + 4);
  const dx = Math.max(1, raw[look].distanceM - s.distanceM);
  const grade = ((elev[look] - elev[i]) / dx) * 100;
  return {
    distanceM: Math.round(s.distanceM),
    elevationM: Math.round(elev[i] * 10) / 10,
    gradePercent: Math.round(Math.max(-8, Math.min(28, grade)) * 10) / 10,
  };
});
if (samples.length > 1) samples[samples.length - 1].gradePercent = samples[samples.length - 2].gradePercent;

const first = samples[0];
const last = samples[samples.length - 1];
let gain = 0;
for (let i = 1; i < samples.length; i += 1) {
  gain += Math.max(0, samples[i].elevationM - samples[i - 1].elevationM);
}
const profile = {
  id,
  name,
  source: `GPX registrato (${path.basename(gpxPath)})`,
  lengthM: last.distanceM,
  startElevationM: first.elevationM,
  summitElevationM: Math.max(...samples.map((s) => s.elevationM)),
  avgGrade: last.distanceM > 0 ? Math.round((gain / last.distanceM) * 1000) / 10 : 0,
  samples,
};
fs.writeFileSync(path.join(OUT_DIR, `${id}.json`), JSON.stringify(profile));

const indexPath = path.join(OUT_DIR, "index.json");
const index = JSON.parse(fs.readFileSync(indexPath, "utf8")).filter((e) => e.id !== id);
index.push({
  id,
  name,
  km: (profile.lengthM / 1000).toFixed(2),
  gain: Math.round(gain),
  avg: profile.avgGrade,
  points: samples.length,
});
index.sort((a, b) => a.id.localeCompare(b.id));
fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));
console.log(`${id}: ${(profile.lengthM / 1000).toFixed(2)} km, +${Math.round(gain)} m, ${samples.length} punti`);
