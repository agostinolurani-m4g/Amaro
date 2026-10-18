import { buildCycles } from "./cycles";
import { runVideoQc } from "./qc";
import { analyzeVideoFrames, initPoseLandmarker } from "./pose";
import { evaluateSaddle } from "./rules";
import type { FitProfile, FitSession, FitVideoView } from "./types";
import { MEASUREMENT_UNCERTAINTY_DEG } from "./types";
import { newId } from "../../hooks/useStorage";

export async function runFitAnalysis(
  video: HTMLVideoElement,
  profile: FitProfile,
  heightCm: number,
  videoView: FitVideoView,
  videoLabel: string,
  onStatus?: (msg: string) => void,
): Promise<FitSession> {
  onStatus?.("Inizializzazione…");
  await initPoseLandmarker(onStatus);

  const { frames, side } = await analyzeVideoFrames(video, (p) => {
    if (p.phase === "pose") {
      onStatus?.(`Analisi frame ${p.framesDone}/${p.framesTotal}…`);
    }
  });

  const { cycles, meanFlexion, stdFlexion } = buildCycles(frames);

  const cycleDurations = cycles.map((c) => c.endFrame - c.startFrame);
  const meanDur =
    cycleDurations.length > 0
      ? cycleDurations.reduce((a, b) => a + b, 0) / cycleDurations.length
      : 0;
  const durVar =
    cycleDurations.length > 1
      ? cycleDurations.reduce((s, d) => s + (d - meanDur) ** 2, 0) /
        cycleDurations.length
      : 0;
  const cadenceCv = meanDur > 0 ? Math.sqrt(durVar) / meanDur : undefined;

  const qc = runVideoQc(frames, cycles.length, cadenceCv);
  const saddle = evaluateSaddle(profile, meanFlexion, heightCm);

  const session: FitSession = {
    id: newId(),
    createdAt: new Date().toISOString(),
    videoView,
    videoLabel,
    metrics: {
      kneeFlexionBdcDeg: meanFlexion,
      kneeFlexionUncertaintyDeg: MEASUREMENT_UNCERTAINTY_DEG,
      cyclesUsed: cycles.length,
      side,
      kneeRangeDeg: stdFlexion * 2,
    },
    qc,
    saddle,
  };

  if (!qc.ok && !Number.isFinite(meanFlexion)) {
    session.saddle.summary =
      "Analisi incompleta: migliora il video secondo i controlli qualità e riprova.";
  }

  return session;
}
