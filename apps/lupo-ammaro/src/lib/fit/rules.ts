import { saddleDeltaMm, estimateLegSegmentsMm } from "./angles";
import type {
  FitPainEntry,
  FitProfile,
  FitRedFlagAnswers,
  FitSaddleRecommendation,
} from "./types";
import {
  KNEE_FLEXION_DYNAMIC_MAX,
  KNEE_FLEXION_DYNAMIC_MIN,
  MEASUREMENT_UNCERTAINTY_DEG,
} from "./types";

export function hasActiveRedFlags(flags: FitRedFlagAnswers): boolean {
  return (
    flags.acuteOrWorseningPain ||
    flags.persistentNumbness ||
    flags.swelling ||
    flags.nightPain ||
    flags.recentSurgery
  );
}

function targetFlexionBand(profile: FitProfile): { min: number; max: number; target: number } {
  let min = KNEE_FLEXION_DYNAMIC_MIN;
  let max = KNEE_FLEXION_DYNAMIC_MAX;
  const anteriorKnee = profile.pains.some(
    (p) => p.site === "knee_anterior" && p.intensity >= 3,
  );
  if (profile.level === "beginner" || anteriorKnee) {
    min = 35;
    max = 43;
  }
  const target = (min + max) / 2;
  return { min, max, target };
}

export function evaluateSaddle(
  profile: FitProfile,
  measuredFlexionDeg: number,
  heightCm: number,
): FitSaddleRecommendation {
  const blocked = hasActiveRedFlags(profile.redFlags);
  const { min, max, target } = targetFlexionBand(profile);
  const uncertainty = MEASUREMENT_UNCERTAINTY_DEG;

  if (blocked) {
    return {
      status: "ok",
      measuredFlexionDeg,
      targetMinDeg: min,
      targetMaxDeg: max,
      adjustmentMmMin: 0,
      adjustmentMmMax: 0,
      direction: "none",
      summary:
        "Segnali di allarme attivi: non modifichiamo la posizione. Consulta un medico prima di proseguire.",
      blockedByRedFlags: true,
    };
  }

  const { femurMm, tibiaMm, approximate } = estimateLegSegmentsMm(
    heightCm,
    profile.anthropometry,
  );

  let status: "ok" | "high" | "low" = "ok";
  let direction: "raise" | "lower" | "none" = "none";

  if (measuredFlexionDeg > max + uncertainty * 0.5) {
    status = "low";
    direction = "raise";
  } else if (measuredFlexionDeg < min - uncertainty * 0.5) {
    status = "high";
    direction = "lower";
  }

  const deltaToTarget = saddleDeltaMm(femurMm, tibiaMm, measuredFlexionDeg, target);
  const deltaLow = saddleDeltaMm(femurMm, tibiaMm, measuredFlexionDeg, max);
  const deltaHigh = saddleDeltaMm(femurMm, tibiaMm, measuredFlexionDeg, min);

  let adjMin = 0;
  let adjMax = 0;
  if (direction === "raise") {
    adjMin = Math.max(2, Math.round(Math.abs(deltaLow) - uncertainty * 2));
    adjMax = Math.max(adjMin, Math.round(Math.abs(deltaToTarget) + uncertainty * 2));
  } else if (direction === "lower") {
    adjMin = Math.max(2, Math.round(Math.abs(deltaHigh) - uncertainty * 2));
    adjMax = Math.max(adjMin, Math.round(Math.abs(deltaToTarget) + uncertainty * 2));
  }

  adjMin = Math.min(adjMin, 15);
  adjMax = Math.min(Math.max(adjMax, adjMin), 20);

  let summary: string;
  if (status === "ok") {
    summary = `Ginocchio a ${measuredFlexionDeg.toFixed(0)}°±${uncertainty}° al BDC: nella fascia dinamica ${min}–${max}°. Nessuna modifica sella suggerita ora.`;
  } else if (direction === "raise") {
    summary = `Ginocchio troppo flesso (${measuredFlexionDeg.toFixed(0)}°±${uncertainty}°): alza la sella di circa ${adjMin}–${adjMax} mm, una modifica alla volta, poi ri-filma.${
      approximate ? " Stima gamba da altezza: conferma con metro." : ""
    }`;
  } else {
    summary = `Ginocchio troppo esteso (${measuredFlexionDeg.toFixed(0)}°±${uncertainty}°): abbassa la sella di circa ${adjMin}–${adjMax} mm, una modifica alla volta, poi ri-filma.${
      approximate ? " Stima gamba da altezza: conferma con metro." : ""
    }`;
  }

  const posteriorPain = profile.pains.some((p) => p.site === "knee_posterior" && p.intensity >= 3);
  if (posteriorPain && status === "low") {
    summary += " Dolore posteriore al ginocchio: verifica anche sella alta o troppo arretrata.";
  }

  return {
    status,
    measuredFlexionDeg,
    targetMinDeg: min,
    targetMaxDeg: max,
    adjustmentMmMin: direction === "none" ? 0 : adjMin,
    adjustmentMmMax: direction === "none" ? 0 : adjMax,
    direction,
    summary,
    blockedByRedFlags: false,
  };
}

export function painHints(pains: FitPainEntry[]): string[] {
  const hints: string[] = [];
  for (const p of pains) {
    if (p.intensity < 2) continue;
    switch (p.site) {
      case "knee_anterior":
        hints.push("Ginocchio anteriore: spesso sella bassa o troppo avanzata.");
        break;
      case "knee_posterior":
        hints.push("Ginocchio posteriore: spesso sella alta o troppo arretrata.");
        break;
      case "knee_lateral":
        hints.push("Ginocchio laterale: controlla tacchette e altezza sella.");
        break;
      case "low_back":
        hints.push("Schiena bassa: sella alta, reach lungo o drop eccessivo.");
        break;
      case "neck_shoulders":
        hints.push("Collo/spalle: reach lungo o manubrio troppo basso.");
        break;
      case "hands_wrists":
        hints.push("Mani/polsi: troppo peso sulle mani (reach, inclinazione sella).");
        break;
      case "feet":
        hints.push("Piedi: tacchette, scarpe o sella alta.");
        break;
      case "saddle_area":
        hints.push("Zona sella: altezza, inclinazione o reach.");
        break;
      default:
        break;
    }
  }
  return [...new Set(hints)];
}

export function trafficLight(
  flexion: number,
  min: number,
  max: number,
): "good" | "warn" | "bad" {
  if (flexion >= min && flexion <= max) return "good";
  if (flexion >= min - 4 && flexion <= max + 4) return "warn";
  return "bad";
}
