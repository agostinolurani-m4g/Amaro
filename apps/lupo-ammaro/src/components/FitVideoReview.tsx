import { useEffect, useRef } from "react";
import type { FrameLandmarks } from "../lib/fit/cycles";

interface FitVideoReviewProps {
  src: string;
  frames: FrameLandmarks[];
  meanFlexionDeg: number;
}

function nearestFrame(frames: FrameLandmarks[], time: number): FrameLandmarks | null {
  if (frames.length === 0) return null;
  let lo = 0;
  let hi = frames.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (frames[mid].timeSec < time) lo = mid + 1;
    else hi = mid;
  }
  const next = frames[lo];
  const prev = frames[Math.max(0, lo - 1)];
  const best = Math.abs(prev.timeSec - time) <= Math.abs(next.timeSec - time) ? prev : next;
  return Math.abs(best.timeSec - time) <= 0.08 ? best : null;
}

function contentRect(video: HTMLVideoElement) {
  const cw = video.clientWidth;
  const ch = video.clientHeight;
  const vw = video.videoWidth || cw;
  const vh = video.videoHeight || ch;
  if (cw <= 0 || ch <= 0 || vw <= 0 || vh <= 0) return null;
  const scale = Math.min(cw / vw, ch / vh);
  const w = vw * scale;
  const h = vh * scale;
  return { x: (cw - w) / 2, y: (ch - h) / 2, w, h };
}

function drawOverlay(
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
  frames: FrameLandmarks[],
  flexionEl: HTMLElement | null,
  badgeEl: HTMLElement | null,
) {
  const rect = contentRect(video);
  const dpr = window.devicePixelRatio || 1;
  const width = video.clientWidth;
  const height = video.clientHeight;
  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
  }
  const ctx = canvas.getContext("2d");
  if (!ctx || !rect) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const frame = nearestFrame(frames, video.currentTime);
  if (!frame || !Number.isFinite(frame.flexionDeg)) {
    if (flexionEl) flexionEl.textContent = "—";
    if (badgeEl) badgeEl.hidden = true;
    return;
  }

  const px = (p: { x: number; y: number }) => ({
    x: rect.x + p.x * rect.w,
    y: rect.y + p.y * rect.h,
  });
  const hip = px(frame.hip);
  const knee = px(frame.knee);
  const ankle = px(frame.ankle);
  const color = frame.bdc ? "#fbbf24" : "#7dd3fc";
  const line = Math.max(2, rect.w / 220);

  ctx.lineWidth = line;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.strokeStyle = color;
  ctx.beginPath();
  ctx.moveTo(hip.x, hip.y);
  ctx.lineTo(knee.x, knee.y);
  ctx.lineTo(ankle.x, ankle.y);
  ctx.stroke();

  const dots: { p: { x: number; y: number }; fill: string }[] = [
    { p: hip, fill: "#38bdf8" },
    { p: knee, fill: frame.bdc ? "#fbbf24" : "#f8fafc" },
    { p: ankle, fill: "#34d399" },
  ];
  for (const dot of dots) {
    ctx.beginPath();
    ctx.fillStyle = dot.fill;
    ctx.arc(dot.p.x, dot.p.y, line * 2.4, 0, Math.PI * 2);
    ctx.fill();
  }

  const label = `${frame.flexionDeg.toFixed(1)}°`;
  ctx.font = `600 ${Math.max(14, rect.w / 28)}px "Space Grotesk", sans-serif`;
  const pad = 6;
  const textW = ctx.measureText(label).width;
  const boxX = knee.x + 10;
  const boxY = knee.y - 28;
  ctx.fillStyle = "rgba(0, 0, 0, 0.72)";
  ctx.fillRect(boxX, boxY, textW + pad * 2, 26);
  ctx.fillStyle = frame.bdc ? "#fbbf24" : "#f8fafc";
  ctx.fillText(label, boxX + pad, boxY + 19);

  if (flexionEl) flexionEl.textContent = label;
  if (badgeEl) badgeEl.hidden = !frame.bdc;
}

export function FitVideoReview({ src, frames, meanFlexionDeg }: FitVideoReviewProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const flexionRef = useRef<HTMLSpanElement>(null);
  const badgeRef = useRef<HTMLSpanElement>(null);
  const framesRef = useRef(frames);
  framesRef.current = frames;

  useEffect(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;
    let raf = 0;
    const tick = () => {
      drawOverlay(video, canvas, framesRef.current, flexionRef.current, badgeRef.current);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [src]);

  function jumpBdc(direction: 1 | -1) {
    const video = videoRef.current;
    if (!video) return;
    const marks = frames.filter((f) => f.bdc).map((f) => f.timeSec);
    if (marks.length === 0) return;
    const t = video.currentTime;
    const target =
      direction > 0
        ? (marks.find((time) => time > t + 0.04) ?? marks[0])
        : ([...marks].reverse().find((time) => time < t - 0.04) ?? marks[marks.length - 1]);
    video.pause();
    video.currentTime = target;
  }

  const bdcValues = frames.filter((f) => f.bdc && Number.isFinite(f.flexionDeg));

  return (
    <div className="fit-review">
      <h3>Punti sul video</h3>
      <p className="muted-copy">
        Azzurro anca, bianco ginocchio, verde caviglia. Il numero è la flessione di quel frame.
        In giallo sono i punti morti bassi che entrano nella media
        {Number.isFinite(meanFlexionDeg) ? ` (${meanFlexionDeg.toFixed(1)}°)` : ""}.
      </p>
      <div className="fit-review__stage">
        <video
          ref={videoRef}
          src={src}
          className="fit-review__video"
          controls
          playsInline
          preload="auto"
        />
        <canvas ref={canvasRef} className="fit-review__canvas" aria-hidden="true" />
        <div className="fit-review__hud">
          <span ref={flexionRef}>—</span>
          <span ref={badgeRef} className="fit-review__bdc" hidden>
            BDC
          </span>
        </div>
      </div>
      <div className="fit-review__nav">
        <button type="button" className="btn btn--ghost btn--small" onClick={() => jumpBdc(-1)}>
          BDC precedente
        </button>
        <button type="button" className="btn btn--ghost btn--small" onClick={() => jumpBdc(1)}>
          BDC successivo
        </button>
      </div>
      {bdcValues.length > 0 && (
        <p className="muted-copy">
          Flessione ai BDC:{" "}
          {bdcValues.map((f) => `${f.flexionDeg.toFixed(1)}°`).join(" · ")}
        </p>
      )}
    </div>
  );
}
