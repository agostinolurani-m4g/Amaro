import type { CoachActivity, CoachChartData, CoachContext, CoachWorkoutDraft } from "../types";
import { computePmc as enginePmc } from "../../shared/engine/load.mjs";

function computePmc(activities: CoachActivity[], ftp: number, futureDays = 0, lthr?: number) {
  return enginePmc(activities, { ftp, lthr, days: 120, futureDays });
}

export function buildPmcChartArtifact(context: CoachContext, futureDays = 21): CoachChartData | null {
  const ftp = context.profile?.ftpWatts ?? 0;
  if (!ftp) return null;

  const pmc = computePmc(
    [...(context.activities ?? []), ...(context.planned ?? [])],
    ftp,
    futureDays,
    context.profile?.lthr,
  );
  const recent = pmc.slice(-(56 + futureDays));

  return {
    kind: "pmc",
    title: "Carico allenamento (CTL / ATL / TSB)",
    x: recent.map((p) => p.date),
    yLabel: "TSS / fitness",
    series: [
      {
        label: "CTL",
        data: recent.map((p) => Math.round(p.ctl * 10) / 10),
        color: "#4ade80",
      },
      {
        label: "ATL",
        data: recent.map((p) => Math.round(p.atl * 10) / 10),
        color: "#ff0a54",
      },
      {
        label: "TSB",
        data: recent.map((p) => Math.round(p.tsb * 10) / 10),
        color: "#60a5fa",
      },
    ],
  };
}

export function pmcSummaryText(context: CoachContext): string | null {
  const ftp = context.profile?.ftpWatts ?? 0;
  if (!ftp) return "FTP non impostato nel profilo.";
  const pmc = computePmc(context.activities ?? [], ftp, 0, context.profile?.lthr);
  const today = pmc[pmc.length - 1];
  const weekTss = pmc.slice(-7).reduce((s, p) => s + p.tss, 0);
  return `CTL: ${today.ctl.toFixed(1)} | ATL: ${today.atl.toFixed(1)} | TSB: ${today.tsb.toFixed(1)} · TSS 7g: ${weekTss.toFixed(0)}`;
}

export function detectDirectIntent(message: string): CoachDirectIntent | undefined {
  const m = message.toLowerCase();
  if (/grafico/.test(m) && /carico|ctl|atl|tsb|pmc/.test(m)) return "chart_pmc";
  if (/cerca in rete|ricerca web|internet/.test(m)) return "web_search";
  if (/piano/.test(m) && /settimana/.test(m)) return "plan_week";
  if (/crea|genera/.test(m) && /workout|allenamento/.test(m)) return "create_workout";
  if (/ultima sessione/.test(m) && /grafico|mostra/.test(m)) return "last_session";
  return undefined;
}

export type CoachDirectIntent =
  | "chart_pmc"
  | "web_search"
  | "plan_week"
  | "create_workout"
  | "last_session";

export function fallbackWorkoutFromMessage(message: string): CoachWorkoutDraft | null {
  const m = message.toLowerCase();
  if (/sweet spot/.test(m) && /3\s*[x×]\s*12|3x12/.test(m)) {
    return {
      name: "Sweet spot 3×12",
      description: "3×12 min al 88% FTP con recupero 5 min",
      blocks: [
        { type: "step", kind: "warmup", durationSecs: 600, targetPctFtp: 55 },
        {
          type: "repeat",
          count: 3,
          steps: [
            {
              kind: "interval",
              durationSecs: 720,
              targetPctFtp: 88,
              label: "Sweet spot",
            },
            { kind: "recovery", durationSecs: 300, targetPctFtp: 50 },
          ],
        },
        { type: "step", kind: "cooldown", durationSecs: 600, targetPctFtp: 45 },
      ],
    };
  }
  return null;
}
