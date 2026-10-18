import { adaptSession, readinessScore } from "../../shared/engine/planner.mjs";
import { addDaysIso } from "../../shared/engine/dates.mjs";
import type {
  CalendarEntry,
  CoachPlanSession,
  CoachProposal,
  DailyCheckin,
  LifeBlock,
  LoadSnapshot,
} from "../types";
import {
  isDateFullyBusy,
  lifeBlocksForDate,
  nextFreeTrainingDate,
} from "./lifeBlockStore";
import { calendarToPlanSessions } from "./coachPlanAdjust";
import { newId, todayIso } from "../hooks/useStorage";

export interface ProposalInput {
  calendar: CalendarEntry[];
  lifeBlocks: LifeBlock[];
  checkin: DailyCheckin | null;
  load: LoadSnapshot | null;
  today: string;
}

function plannedSession(entry: CalendarEntry): CoachPlanSession {
  return {
    date: entry.date,
    name: entry.title,
    durationMin: Math.max(1, Math.round((entry.durationSecs ?? 3600) / 60)),
    description: entry.notes,
    plannedTss: entry.plannedTss,
    sessionType: entry.sessionType as CoachPlanSession["sessionType"],
    workoutId: entry.workoutId,
  };
}

export function computeCoachProposals(input: ProposalInput): CoachProposal[] {
  const { calendar, lifeBlocks, checkin, load, today } = input;
  const proposals: CoachProposal[] = [];
  const planned = calendar.filter((e) => e.entryType === "planned" && e.date >= today);
  const occupied = new Set(planned.map((p) => p.date));

  for (const entry of planned) {
    const blocks = lifeBlocksForDate(lifeBlocks, entry.date);
    const busy = blocks.some((b) => b.kind === "busy");
    if (!busy) continue;
    const target = nextFreeTrainingDate(entry.date, occupied, lifeBlocks);
    proposals.push({
      id: newId(),
      kind: "move",
      title: `Sposta "${entry.title}" al ${formatShort(target)}`,
      reason: blocks.map((b) => b.label).slice(0, 1)[0] ?? "Hai un impegno quel giorno.",
      planPatch: [{ ...plannedSession(entry), date: target, fromDate: entry.date }],
      createdAt: new Date().toISOString(),
    });
    break;
  }

  const todayEntry = planned.find((e) => e.date === today);
  if (todayEntry && load) {
    const readiness = readinessScore(checkin, load.tsb);
    const session = plannedSession(todayEntry);
    const res = adaptSession(session, { readiness, model: null });
    if (res.changed) {
      proposals.push({
        id: newId(),
        kind: "lighten",
        title: `Oggi: ${res.session.name}`,
        reason: res.reason,
        planPatch: [{ ...res.session, fromDate: session.date }],
        workouts: res.draft ? [res.draft as import("../types").CoachWorkoutDraft] : undefined,
        createdAt: new Date().toISOString(),
      });
    }
  }

  const weekEnd = addDaysIso(today, 6);
  const weekPlanned = planned.filter((e) => e.date <= weekEnd);
  const weekTss = weekPlanned.reduce((a, e) => a + (e.plannedTss ?? 0), 0);
  if (weekTss < 180 && weekPlanned.length < 3) {
    for (let i = 0; i <= 6; i += 1) {
      const d = addDaysIso(today, i);
      if (occupied.has(d) || isDateFullyBusy(lifeBlocks, d)) continue;
      proposals.push({
        id: newId(),
        kind: "insert",
        title: `Inserisci endurance Z2 il ${formatShort(d)}`,
        reason: "Settimana leggera: un’ora in Z2 recupera il carico senza stress.",
        planPatch: [
          {
            date: d,
            name: "Endurance Z2",
            durationMin: 60,
            description: "Proposta automatica per bilanciare la settimana",
            sessionType: "z2",
            plannedTss: 45,
          },
        ],
        createdAt: new Date().toISOString(),
      });
      break;
    }
  }

  return proposals.slice(0, 1);
}

export function proposalFromDayComment(
  comment: string,
  date: string,
  calendar: CalendarEntry[],
  lifeBlocks: LifeBlock[],
): CoachProposal | null {
  const lower = comment.toLowerCase();
  const from = todayIso();
  const sessions = calendarToPlanSessions(calendar, from);
  const onDay = sessions.find((s) => s.date === date);
  if (/spost|domani|posticip|anticip/.test(lower) && onDay) {
    const occupied = new Set(sessions.map((s) => s.date));
    const target = /domani/.test(lower)
      ? addDaysIso(date, 1)
      : nextFreeTrainingDate(date, occupied, lifeBlocks);
    return {
      id: newId(),
      kind: "move",
      title: `Sposta "${onDay.name}" al ${formatShort(target)}`,
      reason: comment.trim(),
      planPatch: [{ ...onDay, date: target, fromDate: date }],
      createdAt: new Date().toISOString(),
    };
  }
  if (/stanc|legger|45|poco tempo|allegger/.test(lower) && onDay) {
    return {
      id: newId(),
      kind: "lighten",
      title: "Alleggerisci la sessione",
      reason: comment.trim(),
      planPatch: [
        {
          ...onDay,
          name: "Recupero attivo",
          durationMin: /45/.test(lower) ? 45 : 40,
          description: "Adattato dal commento sul giorno",
          workoutName: undefined,
        },
      ],
      createdAt: new Date().toISOString(),
    };
  }
  return null;
}

function formatShort(iso: string): string {
  const [, m, d] = iso.split("-");
  return `${d}/${m}`;
}
