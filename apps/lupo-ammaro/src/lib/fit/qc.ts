import type { FrameLandmarks } from "./cycles";
import type { FitQcResult } from "./types";

const MIN_FRAMES = 60;
const MIN_CYCLES = 6;
const MIN_VISIBILITY = 0.5;

export function runVideoQc(
  frames: FrameLandmarks[],
  cycleCount: number,
  cadenceCv?: number,
): FitQcResult {
  const issues: string[] = [];
  if (frames.length < MIN_FRAMES) {
    issues.push(
      `Video troppo corto (${frames.length} frame analizzati). Servono almeno ~2 s a 30 fps.`,
    );
  }

  const vis = frames.map((f) => f.visibility);
  const meanVisibility =
    vis.length > 0 ? vis.reduce((a, b) => a + b, 0) / vis.length : 0;
  if (meanVisibility < MIN_VISIBILITY) {
    issues.push(
      "Visibilità articolazioni bassa: abbigliamento scuro, luce insufficiente o corpo tagliato.",
    );
  }

  if (cycleCount < MIN_CYCLES) {
    issues.push(
      `Pedalate stabili insufficienti (${cycleCount}). Pedala almeno 15–20 s con cadenza costante.`,
    );
  }

  if (cadenceCv !== undefined && cadenceCv > 0.25) {
    issues.push("Cadenza irregolare: mantieni un ritmo costante sul rullo.");
  }

  return {
    ok: issues.length === 0,
    issues,
    framesAnalyzed: frames.length,
    meanVisibility,
  };
}
