import type { Workout, WorkoutBlock } from "../types";
import { climbDurationSecs, getClimbProfile } from "./climbProfiles";

function blockStep(
  id: string,
  kind: "warmup" | "steady" | "interval" | "recovery" | "cooldown",
  durationSecs: number,
  targetPctFtp: number,
  label?: string,
): WorkoutBlock {
  return {
    type: "step",
    id,
    kind,
    durationSecs,
    targetPctFtp,
    label,
  };
}

function climbPreset(
  presetId: string,
  climbProfileId: string,
  name: string,
  description: string,
): Workout {
  const profile = getClimbProfile(climbProfileId);
  const climbSecs = profile ? climbDurationSecs(profile) : 3600;
  return {
    ...preset(presetId, name, description, "climb", [
      blockStep(`${climbProfileId}-wu`, "warmup", 8 * 60, 55, "Riscaldamento"),
      blockStep(`${climbProfileId}-main`, "steady", climbSecs, 80, name),
      blockStep(`${climbProfileId}-cd`, "cooldown", 6 * 60, 45, "Defaticamento"),
    ]),
    executionMode: "climb",
    climbProfileId,
  };
}

function preset(
  presetId: string,
  name: string,
  description: string,
  category: "classic" | "climb",
  blocks: WorkoutBlock[],
): Workout {
  const now = new Date().toISOString();
  return {
    id: presetId,
    presetId,
    name,
    description,
    category,
    blocks,
    createdAt: now,
    updatedAt: now,
  };
}

const CLASSIC_PRESETS: Workout[] = [
  preset(
    "classic-recovery",
    "Recupero attivo",
    "45 minuti leggeri per favorire il recupero.",
    "classic",
    [blockStep("r-main", "steady", 45 * 60, 50, "Recupero attivo")],
  ),
  preset(
    "classic-endurance",
    "Endurance",
    "Lavoro aerobico continuo ~90 minuti.",
    "classic",
    [
      blockStep("e-wu", "warmup", 10 * 60, 55),
      blockStep("e-main", "steady", 70 * 60, 65, "Endurance"),
      blockStep("e-cd", "cooldown", 10 * 60, 45),
    ],
  ),
  preset(
    "classic-tempo-3x15",
    "Tempo 3×15",
    "10 min riscaldamento + 3×15 min @ 80% FTP / 5 min recupero + defaticamento.",
    "classic",
    [
      blockStep("t-wu", "warmup", 10 * 60, 55),
      {
        type: "repeat",
        id: "t-rep",
        count: 3,
        steps: [
          { id: "t-on", kind: "steady", durationSecs: 15 * 60, targetPctFtp: 80, label: "Tempo" },
          { id: "t-off", kind: "recovery", durationSecs: 5 * 60, targetPctFtp: 50 },
        ],
      },
      blockStep("t-cd", "cooldown", 10 * 60, 45),
    ],
  ),
  preset(
    "classic-sweet-spot",
    "Sweet spot 2×20",
    "2×20 minuti nel sweet spot (~90% FTP).",
    "classic",
    [
      blockStep("ss-wu", "warmup", 10 * 60, 55),
      {
        type: "repeat",
        id: "ss-rep",
        count: 2,
        steps: [
          { id: "ss-on", kind: "steady", durationSecs: 20 * 60, targetPctFtp: 90, label: "Sweet spot" },
          { id: "ss-off", kind: "recovery", durationSecs: 5 * 60, targetPctFtp: 50 },
        ],
      },
      blockStep("ss-cd", "cooldown", 10 * 60, 45),
    ],
  ),
  preset(
    "classic-threshold",
    "Soglia 3×12",
    "3×12 minuti a soglia FTP.",
    "classic",
    [
      blockStep("th-wu", "warmup", 10 * 60, 55),
      {
        type: "repeat",
        id: "th-rep",
        count: 3,
        steps: [
          { id: "th-on", kind: "interval", durationSecs: 12 * 60, targetPctFtp: 100, label: "Soglia" },
          { id: "th-off", kind: "recovery", durationSecs: 4 * 60, targetPctFtp: 50 },
        ],
      },
      blockStep("th-cd", "cooldown", 10 * 60, 45),
    ],
  ),
  preset(
    "classic-over-under",
    "Over-under 4×8",
    "4×8' alternando sotto e sopra soglia.",
    "classic",
    [
      blockStep("ou-wu", "warmup", 10 * 60, 55),
      {
        type: "repeat",
        id: "ou-rep",
        count: 4,
        steps: [
          { id: "ou-under", kind: "steady", durationSecs: 4 * 60, targetPctFtp: 95, label: "Under" },
          { id: "ou-over", kind: "interval", durationSecs: 4 * 60, targetPctFtp: 105, label: "Over" },
          { id: "ou-off", kind: "recovery", durationSecs: 4 * 60, targetPctFtp: 50 },
        ],
      },
      blockStep("ou-cd", "cooldown", 10 * 60, 45),
    ],
  ),
  preset(
    "classic-vo2",
    "VO2 5×5",
    "5×5 minuti sopra soglia (~120% FTP).",
    "classic",
    [
      blockStep("v-wu", "warmup", 10 * 60, 55),
      {
        type: "repeat",
        id: "v-rep",
        count: 5,
        steps: [
          { id: "v-on", kind: "interval", durationSecs: 5 * 60, targetPctFtp: 120, label: "VO2" },
          { id: "v-off", kind: "recovery", durationSecs: 4 * 60, targetPctFtp: 50 },
        ],
      },
      blockStep("v-cd", "cooldown", 10 * 60, 45),
    ],
  ),
  preset(
    "classic-40-20",
    "40/20",
    "24×40 s @ 130% / 20s recupero (~3 serie da 8).",
    "classic",
    [
      blockStep("4020-wu", "warmup", 10 * 60, 55),
      {
        type: "repeat",
        id: "4020-rep",
        count: 24,
        steps: [
          { id: "4020-on", kind: "interval", durationSecs: 40, targetPctFtp: 130, label: "40s" },
          { id: "4020-off", kind: "recovery", durationSecs: 20, targetPctFtp: 40 },
        ],
      },
      blockStep("4020-cd", "cooldown", 10 * 60, 45),
    ],
  ),
  preset(
    "classic-ftp-test",
    "FTP test 20'",
    "Protocollo test: 20' leggero, 5' progressivo, 20' all-out.",
    "classic",
    [
      blockStep("ft-wu", "warmup", 20 * 60, 50, "Riscaldamento leggero"),
      blockStep("ft-build", "steady", 5 * 60, 80, "Progressivo"),
      blockStep("ft-test", "interval", 20 * 60, 105, "Test 20'"),
      blockStep("ft-cd", "cooldown", 10 * 60, 45),
    ],
  ),
  preset(
    "classic-sprint",
    "Sprint neuromuscolare",
    "8×15s massimali con recupero lungo.",
    "classic",
    [
      blockStep("sp-wu", "warmup", 10 * 60, 55),
      {
        type: "repeat",
        id: "sp-rep",
        count: 8,
        steps: [
          { id: "sp-on", kind: "interval", durationSecs: 15, targetPctFtp: 150, label: "Sprint" },
          { id: "sp-off", kind: "recovery", durationSecs: 165, targetPctFtp: 40 },
        ],
      },
      blockStep("sp-cd", "cooldown", 10 * 60, 45),
    ],
  ),
];

const CLIMB_PRESETS: Workout[] = [
  climbPreset("climb-lesima", "lesima", "Monte Lesima", "Tracciato OSM + DEM: 15.5 km, +766 m, 5.0% medio. Il rullo simula la pendenza; i watt li scegli tu."),
  climbPreset("climb-finestre", "finestre", "Colle delle Finestre", "Tracciato OSM + DEM: 19.8 km, +1675 m, 8.5% medio. Sterrato dopo ~8 km."),
  climbPreset("climb-nivolet", "nivolet", "Col del Nivolet", "Ceresole Reale -> colle, OSM + DEM: 18.0 km, +1004 m, 5.6% medio."),
  climbPreset("climb-alpe-huez", "alpe-huez", "Alpe d'Huez", "D211 da Bourg-d'Oisans, OSM + DEM: 14.4 km, +1096 m, 7.6% medio."),
  climbPreset("climb-giau", "giau", "Passo Giau", "Selva di Cadore -> passo, OSM + DEM: 10.4 km, +894 m, 8.6% medio."),
  climbPreset("climb-kwaremont", "kwaremont", "Oude Kwaremont", "Pave da Kluisbergen, OSM + DEM: 3.0 km, +97 m, 3.2% medio."),
  climbPreset("climb-pentema", "pentema", "Passo Pentema", "Torriglia -> Colletto, OSM + DEM: 9.7 km, +340 m, 3.5% medio."),
  climbPreset("climb-stelvio", "stelvio", "Stelvio (da Prato)", "SS38 Prato -> passo, OSM + DEM: 25.4 km, +1849 m, 7.3% medio."),
  climbPreset("climb-gavia", "gavia", "Gavia (Ponte di Legno)", "Ponte di Legno -> passo, OSM + DEM: 18.2 km, +1377 m, 7.6% medio."),
  climbPreset("climb-petersberg", "paterberg", "Paterberg", "Oude Paterbergstraat, OSM + DEM (risoluzione limitata sul muro)."),
];

export const PRESET_WORKOUTS: Workout[] = [...CLASSIC_PRESETS, ...CLIMB_PRESETS];

export function getPresetById(presetId: string): Workout | undefined {
  return PRESET_WORKOUTS.find((p) => p.presetId === presetId);
}

export function presetsByCategory(category: "classic" | "climb"): Workout[] {
  return PRESET_WORKOUTS.filter((p) => p.category === category);
}