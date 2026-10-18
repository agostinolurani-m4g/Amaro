import type { TrainingDoc, TrainingFocus } from "../types";
import { FOCUS_CARDS, parseCards, searchCards } from "../../shared/knowledge/index.mjs";

const RAW = import.meta.glob("../../shared/knowledge/*.md", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const CARDS = parseCards(RAW);

export const TRAINING_DOCS: TrainingDoc[] = CARDS.map((c) => ({
  id: c.id,
  title: c.title,
  source: c.source,
  body: c.body,
}));

function toDocs(ids: string[]): TrainingDoc[] {
  return ids
    .map((id) => TRAINING_DOCS.find((d) => d.id === id))
    .filter((d): d is TrainingDoc => Boolean(d));
}

export function searchDocs(query: string, limit = 3): TrainingDoc[] {
  return toDocs(searchCards(CARDS, query, { limit }).map((c) => c.id));
}

export function docsForFocus(focus: TrainingFocus): TrainingDoc[] {
  const ids = (FOCUS_CARDS as Record<string, string[]>)[focus] ?? FOCUS_CARDS.mixed;
  return toDocs(ids);
}

export function docsForSessionVerdict(
  verdict: "easy" | "on_target" | "hard" | "fatigue",
  hasHr: boolean,
): TrainingDoc[] {
  const ids =
    verdict === "fatigue"
      ? ["recupero-sonno-hrv", "overreaching", "pmc"]
      : verdict === "hard"
        ? ["cp-wprime-wbal", "coggan-zones", "recupero-sonno-hrv"]
        : verdict === "easy"
          ? ["zona2", "distribuzione-intensita"]
          : ["coggan-zones", "pmc"];
  if (hasHr && !ids.includes("disaccoppiamento")) ids.push("disaccoppiamento");
  return toDocs(ids);
}

export function detectFocus(goal: string): TrainingFocus {
  const g = goal.toLowerCase();
  if (/recupero|deload|riposo|overtrain/.test(g)) return "recovery";
  if (/vo2|vo2max|soglia alta|cinque per quattro/.test(g)) return "vo2";
  if (/granfondo|gran fondo|fondo lungo|marathon|endurance event/.test(g)) return "granfondo";
  if (/salita|climb|collina|gpm|force/.test(g)) return "climb";
  if (/ftp|soglia|threshold|sweet.?spot|test 20/.test(g)) return "ftp";
  if (/endurance|base|z2|aerobic|fondo/.test(g)) return "endurance";
  return "mixed";
}

export function webQueryForFocus(focus: TrainingFocus, goal: string): string {
  const queries: Record<TrainingFocus, string> = {
    ftp: "Coggan FTP sweet spot training indoor cycling protocol",
    vo2: "Seiler Billat VO2max 30-30 cycling intervals",
    endurance: "polarized 80/20 endurance cycling zone 2",
    granfondo: "gran fondo cycling periodization durability carbohydrate",
    climb: "low cadence hill climbing strength cycling Ronnestad",
    recovery: "active recovery deload week cycling CTL TSB",
    mixed: "indoor cycling periodization Coggan Friel power zones",
  };
  const extra = goal.trim().slice(0, 40);
  return `${queries[focus]} ${extra}`.trim();
}
