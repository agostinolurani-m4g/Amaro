import { amaroJson } from "../lib/amaroAuth";
import type {
  LeaderboardPeriod,
  LeaderboardResponse,
  SessionStats,
} from "../types";

export interface SessionSubmitPayload {
  title: string;
  durationSecs: number;
  distanceM: number;
  workKj: number;
  avgPower?: number;
  maxPower?: number;
  bests: { windowSecs: number; watts: number }[];
}

export async function submitClubSession(stats: SessionStats, title: string): Promise<void> {
  const payload: SessionSubmitPayload = {
    title,
    durationSecs: stats.durationSecs,
    distanceM: stats.distanceM,
    workKj: stats.workKj,
    avgPower: stats.avgPower,
    maxPower: stats.maxPower,
    bests: stats.bests.map((best) => ({
      windowSecs: best.windowSecs,
      watts: best.watts,
    })),
  };
  await amaroJson("/api/wattlab/sessions", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function fetchLeaderboard(
  period: LeaderboardPeriod = "month",
): Promise<LeaderboardResponse> {
  return amaroJson<LeaderboardResponse>(
    `/api/wattlab/leaderboard?period=${encodeURIComponent(period)}`,
  );
}
