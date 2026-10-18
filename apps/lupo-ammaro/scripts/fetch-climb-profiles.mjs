import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(__dirname, "../src/data/climbs");

/** lon,lat start -> lon,lat summit. Via points keep the route on the famous climb. */
const CLIMBS = [
  {
    id: "alpe-huez",
    name: "Alpe d'Huez",
    source: "OSRM bike + OpenTopoData DEM (D211 da Bourg-d'Oisans)",
    waypoints: [
      [6.0385, 45.0545],
      [6.0678, 45.0902],
    ],
  },
  {
    id: "stelvio",
    name: "Stelvio (da Prato)",
    source: "OSRM bike + OpenTopoData DEM (SS38 Prato allo Stelvio → passo)",
    waypoints: [
      [10.5912, 46.6194],
      [10.45308, 46.52863],
    ],
  },
  {
    id: "gavia",
    name: "Gavia (Ponte di Legno)",
    source: "OSRM bike + OpenTopoData DEM (Ponte di Legno → Passo Gavia)",
    waypoints: [
      [10.50866, 46.2586],
      [10.48733, 46.34348],
    ],
  },
  {
    id: "giau",
    name: "Passo Giau",
    source: "OSRM bike + OpenTopoData DEM (Selva di Cadore → Passo Giau)",
    waypoints: [
      [12.0345, 46.4514],
      [12.0535, 46.4828],
    ],
  },
  {
    id: "finestre",
    name: "Colle delle Finestre",
    source: "OSRM bike + OpenTopoData DEM (Susa/Meana → Colle delle Finestre)",
    waypoints: [
      [7.0505, 45.138],
      [7.05334, 45.07203],
    ],
  },
  {
    id: "nivolet",
    name: "Col del Nivolet",
    source: "OSRM bike + OpenTopoData DEM (Ceresole Reale → Colle del Nivolet)",
    waypoints: [
      [7.2324, 45.43248],
      [7.14232, 45.47921],
    ],
  },
  {
    id: "kwaremont",
    name: "Oude Kwaremont",
    source: "OSRM bike + OpenTopoData DEM (Kluisbergen, pavé)",
    waypoints: [
      [3.52604, 50.78195],
      [3.518, 50.765],
    ],
  },
  {
    id: "paterberg",
    name: "Paterberg",
    source: "OSRM bike + OpenTopoData eudem25m (Oude Paterbergstraat)",
    waypoints: [
      [3.54723, 50.78175],
      [3.5495, 50.779],
    ],
  },
  {
    id: "lesima",
    name: "Monte Lesima",
    source: "OSRM bike + OpenTopoData DEM (versante Organasco → Monte Lesima)",
    waypoints: [
      [9.272, 44.712],
      [9.2565, 44.6785],
    ],
  },
  {
    id: "pentema",
    name: "Passo Pentema",
    source: "OSRM bike + OpenTopoData DEM (Torriglia → Passo Pentema)",
    waypoints: [
      [9.15835, 44.5194],
      [9.14592, 44.54732],
    ],
  },
];

function haversineM(lon1, lat1, lon2, lat2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function densify(coords, stepM = 10) {
  const out = [];
  for (let i = 0; i < coords.length - 1; i += 1) {
    const [lon1, lat1] = coords[i];
    const [lon2, lat2] = coords[i + 1];
    const dist = haversineM(lon1, lat1, lon2, lat2);
    const n = Math.max(1, Math.round(dist / stepM));
    for (let k = 0; k < n; k += 1) {
      const t = k / n;
      out.push([lon1 + (lon2 - lon1) * t, lat1 + (lat2 - lat1) * t]);
    }
  }
  out.push(coords[coords.length - 1]);
  return out;
}

async function osrmRoute(waypoints) {
  const pathStr = waypoints.map(([lon, lat]) => `${lon},${lat}`).join(";");
  const url = `https://router.project-osrm.org/route/v1/bike/${pathStr}?overview=full&geometries=geojson`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`OSRM ${res.status} ${url}`);
  const json = await res.json();
  if (json.code !== "Ok" || !json.routes?.[0]) {
    throw new Error(`OSRM ${json.code}: ${json.message}`);
  }
  return json.routes[0];
}

async function elevations(points) {
  const elev = new Array(points.length);
  const BATCH = 80;
  for (let i = 0; i < points.length; i += BATCH) {
    const slice = points.slice(i, i + BATCH);
    const locations = slice.map((p) => `${p[1].toFixed(5)},${p[0].toFixed(5)}`).join("|");
    const dataset = process.env.CLIMB_DEM || "mapzen";
    const url = `https://api.opentopodata.org/v1/${dataset}?locations=${locations}`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Elevation ${res.status} ${await res.text()}`);
    }
    const json = await res.json();
    if (json.status !== "OK" || !Array.isArray(json.results)) {
      throw new Error(`Elevation status ${json.status}`);
    }
    if (json.results.length !== slice.length) {
      throw new Error("Elevation batch size mismatch");
    }
    for (let k = 0; k < json.results.length; k += 1) {
      elev[i + k] = json.results[k].elevation;
    }
    await new Promise((r) => setTimeout(r, 1100));
  }
  return elev;
}

function smooth(values, window = 5) {
  const half = Math.floor(window / 2);
  return values.map((_, i) => {
    let s = 0;
    let n = 0;
    for (let j = i - half; j <= i + half; j += 1) {
      if (j >= 0 && j < values.length && Number.isFinite(values[j])) {
        s += values[j];
        n += 1;
      }
    }
    return s / n;
  });
}

function buildSamples(coords, elevRaw) {
  const elev = smooth(elevRaw, 7);
  const samples = [];
  let dist = 0;
  for (let i = 0; i < coords.length; i += 1) {
    if (i > 0) dist += haversineM(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1]);
    const look = Math.min(coords.length - 1, i + 5);
    const dx = Math.max(1, distLookahead(coords, i, look));
    const dy = elev[look] - elev[i];
    const grade = (dy / dx) * 100;
    samples.push({
      distanceM: Math.round(dist),
      elevationM: Math.round(elev[i] * 10) / 10,
      gradePercent: Math.round(Math.max(-8, Math.min(28, grade)) * 10) / 10,
    });
  }
  const decimated = [];
  let last = -10;
  for (const s of samples) {
    if (s.distanceM - last >= 10 || s === samples[samples.length - 1]) {
      decimated.push(s);
      last = s.distanceM;
    }
  }
  return decimated;
}

function distLookahead(coords, i, j) {
  let d = 0;
  for (let k = i; k < j; k += 1) {
    d += haversineM(coords[k][0], coords[k][1], coords[k + 1][0], coords[k + 1][1]);
  }
  return d;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const only = new Set(process.argv.slice(2).filter((a) => !a.startsWith("-")));
  for (const climb of CLIMBS) {
    if (only.size > 0 && !only.has(climb.id)) continue;
    console.log(`Routing ${climb.id}...`);
    const route = await osrmRoute(climb.waypoints);
    const raw = route.geometry.coordinates;
    const dense = densify(raw, 10);
    console.log(`  ${raw.length} vertices → ${dense.length} pts, OSRM ${(route.distance / 1000).toFixed(2)} km`);
    const elev = await elevations(dense);
    const samples = buildSamples(dense, elev);
    const first = samples[0];
    const last = samples[samples.length - 1];
    const gain = last.elevationM - first.elevationM;
    const profile = {
      id: climb.id,
      name: climb.name,
      source: climb.source,
      lengthM: last.distanceM,
      startElevationM: first.elevationM,
      summitElevationM: last.elevationM,
      avgGrade: Math.round((gain / last.distanceM) * 1000) / 10,
      samples,
    };
    const file = path.join(OUT_DIR, `${climb.id}.json`);
    fs.writeFileSync(file, JSON.stringify(profile));
    console.log(
      `  saved ${samples.length} samples, ${profile.lengthM} m, +${Math.round(gain)} m, avg ${profile.avgGrade}%`,
    );
  }
  const index = [];
  for (const climb of CLIMBS) {
    const file = path.join(OUT_DIR, `${climb.id}.json`);
    if (!fs.existsSync(file)) continue;
    const profile = JSON.parse(fs.readFileSync(file, "utf8"));
    const first = profile.samples[0];
    const last = profile.samples[profile.samples.length - 1];
    index.push({
      id: profile.id,
      name: profile.name,
      km: (profile.lengthM / 1000).toFixed(2),
      gain: Math.round(last.elevationM - first.elevationM),
      avg: profile.avgGrade,
      points: profile.samples.length,
    });
  }
  fs.writeFileSync(path.join(OUT_DIR, "index.json"), JSON.stringify(index, null, 2));
  console.log("done", index);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
