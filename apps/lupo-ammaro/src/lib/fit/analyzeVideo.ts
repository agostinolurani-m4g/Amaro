import { buildCycles, type FrameLandmarks } from "./cycles";
import { runVideoQc } from "./qc";
import { analyzeVideoFrames, initPoseLandmarker } from "./pose";
import { evaluateSaddle } from "./rules";
import type { FitProfile, FitSession, FitVideoView } from "./types";
import { MEASUREMENT_UNCERTAINTY_DEG } from "./types";
import { newId } from "../../hooks/useStorage";

export interface FitAnalysisResult {
  session: FitSession;
  frames: FrameLandmarks[];
}

export async function runFitAnalysis(
  video: HTMLVideoElement,
  profile: FitProfile,
  heightCm: number,
  videoView: FitVideoView,
  videoLabel: string,
  onStatus?: (msg: string) => void,
): Promise<FitAnalysisResult> {
  onStatus?.("Inizializzazione…");
  await initPoseLandmarker(onStatus);

  const { frames: rawFrames, side, sideContrast } = await analyzeVideoFrames(video, (p) => {
    if (p.phase === "pose") {
      onStatus?.(`Analisi frame ${p.framesDone}/${p.framesTotal}…`);
    }
  });

  const { cycles, meanFlexion, stdFlexion, frames } = buildCycles(rawFrames);

  const cycleDurations = cycles.map(
    (c) => frames[c.endFrame].timeSec - frames[c.startFrame].timeSec,
  );
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

  if (rawFrames.length >= 30 && sideContrast < 0.2) {
    qc.issues.push(
      "Vista non abbastanza laterale: i due lati del corpo si confondono e la flessione può saltare di parecchi gradi. Riprendi di fianco, all'altezza della sella.",
    );
    qc.ok = false;
  }

  if (!qc.ok && !Number.isFinite(meanFlexion)) {
    session.saddle.summary =
      "Analisi incompleta: migliora il video secondo i controlli qualità e riprova.";
  }

  try {
    video.pause();
    video.currentTime = 0;
  } catch {
    /* il player di revisione riparte da zero in ogni caso */
  }

  return { session, frames };
}
