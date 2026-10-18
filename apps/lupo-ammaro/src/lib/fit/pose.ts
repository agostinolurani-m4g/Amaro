import { FilesetResolver, PoseLandmarker } from "@mediapipe/tasks-vision";
import type { FrameLandmarks } from "./cycles";
import type { Point2 } from "./angles";

const WASM =
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm";
const MODEL =
  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task";

let landmarker: PoseLandmarker | null = null;

export async function initPoseLandmarker(
  onProgress?: (msg: string) => void,
): Promise<void> {
  if (landmarker) return;
  onProgress?.("Caricamento modello pose…");
  const vision = await FilesetResolver.forVisionTasks(WASM);
  landmarker = await PoseLandmarker.createFromOptions(vision, {
    baseOptions: { modelAssetPath: MODEL },
    runningMode: "VIDEO",
    numPoses: 1,
    minPoseDetectionConfidence: 0.5,
    minPosePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });
}

export type AnalyzeProgress = {
  phase: "pose" | "done";
  framesDone: number;
  framesTotal: number;
};

function lm(
  landmarks: { x: number; y: number; visibility?: number }[],
  idx: number,
): Point2 & { visibility: number } {
  const p = landmarks[idx];
  return { x: p.x, y: p.y, visibility: p.visibility ?? 1 };
}

/** Sceglie il lato con visibilità media maggiore (vista laterale). */
export function pickSide(
  landmarks: { x: number; y: number; visibility?: number }[],
): "left" | "right" {
  const leftVis =
    (landmarks[23].visibility ?? 0) +
    (landmarks[25].visibility ?? 0) +
    (landmarks[27].visibility ?? 0);
  const rightVis =
    (landmarks[24].visibility ?? 0) +
    (landmarks[26].visibility ?? 0) +
    (landmarks[28].visibility ?? 0);
  return leftVis >= rightVis ? "left" : "right";
}

export function landmarksToFrame(
  landmarks: { x: number; y: number; visibility?: number }[],
  side: "left" | "right",
): FrameLandmarks | null {
  const hipIdx = side === "left" ? 23 : 24;
  const kneeIdx = side === "left" ? 25 : 26;
  const ankleIdx = side === "left" ? 27 : 28;
  const hip = lm(landmarks, hipIdx);
  const knee = lm(landmarks, kneeIdx);
  const ankle = lm(landmarks, ankleIdx);
  const visibility = (hip.visibility + knee.visibility + ankle.visibility) / 3;
  if (visibility < 0.35) return null;
  return { hip, knee, ankle, visibility };
}

export async function analyzeVideoFrames(
  video: HTMLVideoElement,
  onProgress?: (p: AnalyzeProgress) => void,
): Promise<{ frames: FrameLandmarks[]; side: "left" | "right" }> {
  if (!landmarker) await initPoseLandmarker();
  const lmInstance = landmarker!;

  const duration = video.duration;
  const fps = 30;
  const step = 1 / fps;
  const frames: FrameLandmarks[] = [];
  let side: "left" | "right" = "left";
  const total = Math.floor(duration / step);

  video.pause();
  for (let i = 0, t = 0; t < duration; t += step, i++) {
    video.currentTime = t;
    await new Promise<void>((resolve) => {
      const onSeeked = () => {
        video.removeEventListener("seeked", onSeeked);
        resolve();
      };
      video.addEventListener("seeked", onSeeked);
    });

    const result = lmInstance.detectForVideo(video, performance.now());
    if (!result.landmarks.length) continue;
    const lms = result.landmarks[0];
    if (i === 0) side = pickSide(lms);
    const frame = landmarksToFrame(lms, side);
    if (frame) frames.push(frame);
    if (i % 5 === 0) {
      onProgress?.({ phase: "pose", framesDone: i, framesTotal: total });
    }
  }

  onProgress?.({ phase: "done", framesDone: total, framesTotal: total });
  return { frames, side };
}
