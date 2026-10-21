import { FilesetResolver, PoseLandmarker } from "@mediapipe/tasks-vision";
import type { FrameLandmarks } from "./cycles";
import type { Point2 } from "./angles";
import { kneeFlexionDeg } from "./angles";

const WASM =
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm";
const MODEL =
  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task";

let landmarker: PoseLandmarker | null = null;

export async function initPoseLandmarker(
  onProgress?: (msg: string) => void,
): Promise<void> {
  onProgress?.("Caricamento modello pose…");
  if (landmarker) {
    await landmarker.setOptions({ runningMode: "IMAGE" });
    return;
  }
  const vision = await FilesetResolver.forVisionTasks(WASM);
  landmarker = await PoseLandmarker.createFromOptions(vision, {
    baseOptions: { modelAssetPath: MODEL },
    runningMode: "IMAGE",
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

type Landmark = { x: number; y: number; z?: number; visibility?: number };

function lm(landmarks: Landmark[], idx: number): Point2 & { visibility: number } {
  const p = landmarks[idx];
  if (!p) return { x: 0, y: 0, visibility: 0 };
  return { x: p.x, y: p.y, visibility: p.visibility ?? 1 };
}

const SIDE_INDEX = {
  left: { hip: 23, knee: 25, ankle: 27 },
  right: { hip: 24, knee: 26, ankle: 28 },
} as const;

/**
 * Il lato verso la camera è più vicino (z minore) e ha la gamba più lunga in immagine.
 * Si somma su tutto il video: il primo frame da solo cambia lato tra un'analisi e l'altra.
 */
export function scoreSide(landmarks: Landmark[], side: "left" | "right"): number {
  const idx = SIDE_INDEX[side];
  const hip = landmarks[idx.hip];
  const knee = landmarks[idx.knee];
  const ankle = landmarks[idx.ankle];
  if (!hip || !knee || !ankle) return 0;
  const vis =
    (hip.visibility ?? 0) + (knee.visibility ?? 0) + (ankle.visibility ?? 0);
  const len =
    Math.hypot(hip.x - knee.x, hip.y - knee.y) +
    Math.hypot(knee.x - ankle.x, knee.y - ankle.y);
  const z = ((hip.z ?? 0) + (knee.z ?? 0) + (ankle.z ?? 0)) / 3;
  const closeness = 1 / (1 + Math.exp(z * 4));
  return vis * len * (0.35 + closeness);
}

export function pickSide(landmarks: Landmark[]): "left" | "right" {
  return scoreSide(landmarks, "left") >= scoreSide(landmarks, "right") ? "left" : "right";
}

export function landmarksToFrame(
  landmarks: Landmark[],
  side: "left" | "right",
  timeSec: number,
): FrameLandmarks | null {
  const idx = SIDE_INDEX[side];
  const hip = lm(landmarks, idx.hip);
  const knee = lm(landmarks, idx.knee);
  const ankle = lm(landmarks, idx.ankle);
  const visibility = (hip.visibility + knee.visibility + ankle.visibility) / 3;
  if (visibility < 0.35) return null;
  return {
    timeSec,
    hip,
    knee,
    ankle,
    visibility,
    flexionDeg: kneeFlexionDeg(hip, knee, ankle),
    bdc: false,
  };
}

/**
 * Attende il frame davvero disegnato. `seeked` da solo arriva spesso prima dei pixel,
 * e leggere quel frame fa cambiare l'angolo tra un'analisi e l'altra dello stesso file.
 */
function presentFrame(video: HTMLVideoElement, timeSec: number): Promise<number> {
  const target = Math.min(Math.max(timeSec, 0), Math.max(0, video.duration - 0.001));
  return new Promise((resolve) => {
    let settled = false;
    const timers: number[] = [];
    const finish = (time: number) => {
      if (settled) return;
      settled = true;
      for (const id of timers) window.clearTimeout(id);
      video.removeEventListener("seeked", onSeeked);
      resolve(Number.isFinite(time) ? time : video.currentTime);
    };
    const watchPresented = () => {
      if (typeof video.requestVideoFrameCallback === "function") {
        video.requestVideoFrameCallback((_now, meta) => finish(meta.mediaTime));
      } else {
        requestAnimationFrame(() => requestAnimationFrame(() => finish(video.currentTime)));
      }
      timers.push(window.setTimeout(() => finish(video.currentTime), 150));
    };
    function onSeeked() {
      watchPresented();
    }

    timers.push(window.setTimeout(() => finish(video.currentTime), 2000));
    if (Math.abs(video.currentTime - target) <= 0.0005 && video.readyState >= 2) {
      watchPresented();
      return;
    }
    video.addEventListener("seeked", onSeeked);
    video.currentTime = target;
  });
}

export async function analyzeVideoFrames(
  video: HTMLVideoElement,
  onProgress?: (p: AnalyzeProgress) => void,
): Promise<{ frames: FrameLandmarks[]; side: "left" | "right"; sideContrast: number }> {
  if (!landmarker) await initPoseLandmarker();
  const lmInstance = landmarker!;

  if (video.readyState < 2) {
    await new Promise<void>((resolve, reject) => {
      const ok = () => {
        cleanup();
        resolve();
      };
      const bad = () => {
        cleanup();
        reject(new Error("Video non leggibile."));
      };
      const cleanup = () => {
        video.removeEventListener("loadeddata", ok);
        video.removeEventListener("error", bad);
      };
      video.addEventListener("loadeddata", ok);
      video.addEventListener("error", bad);
    });
  }

  const duration = video.duration;
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error("Durata del video non disponibile.");
  }

  const fps = 30;
  const step = 1 / fps;
  const total = Math.max(1, Math.floor(duration / step));
  const raw: { timeSec: number; landmarks: Landmark[] }[] = [];

  video.pause();
  let lastPresented = -1;
  for (let i = 0, t = 0; t < duration - 0.02; t += step, i++) {
    let presented = await presentFrame(video, t);
    if (Math.abs(presented - t) > step) {
      presented = await presentFrame(video, t);
    }
    if (presented < lastPresented + step * 0.45) {
      if (i % 5 === 0) onProgress?.({ phase: "pose", framesDone: i, framesTotal: total });
      continue;
    }
    lastPresented = presented;

    try {
      const result = lmInstance.detect(video);
      if (result.landmarks.length) {
        raw.push({ timeSec: presented, landmarks: result.landmarks[0] });
      }
    } catch {
      /* frame illeggibile: si salta, il punto morto si cerca sui frame rimasti */
    }
    if (i % 5 === 0) {
      onProgress?.({ phase: "pose", framesDone: i, framesTotal: total });
    }
  }

  let leftScore = 0;
  let rightScore = 0;
  for (const sample of raw) {
    leftScore += scoreSide(sample.landmarks, "left");
    rightScore += scoreSide(sample.landmarks, "right");
  }
  const side: "left" | "right" = leftScore >= rightScore ? "left" : "right";
  const hi = Math.max(leftScore, rightScore);
  const lo = Math.min(leftScore, rightScore);
  const sideContrast = hi > 0 ? (hi - lo) / hi : 0;

  const frames: FrameLandmarks[] = [];
  for (const sample of raw) {
    const frame = landmarksToFrame(sample.landmarks, side, sample.timeSec);
    if (frame) frames.push(frame);
  }

  onProgress?.({ phase: "done", framesDone: total, framesTotal: total });
  return { frames, side, sideContrast };
}
