import type { CoachPlanSession } from "../types";
import { addDays, isoDate } from "./coachStore";

function isLongSession(name: string): boolean {
  const n = name.toLowerCase();
  return n.includes("lungo") || n.includes("durabilit") || n.includes("2h");
}

function nextFreeDate(from: Date, occupied: Set<string>, maxDays = 14): string {
  for (let i = 1; i <= maxDays; i += 1) {
    const d = isoDate(addDays(from, i));
    if (!occupied.has(d)) return d;
  }
  return isoDate(addDays(from, 7));
}

export function adjustPlanByRules(
  message: string,
  sessions: CoachPlanSession[],
  todayIso: string,
): { reply: string; plan: CoachPlanSession[]; persistentConstraint?: string } {
  const msg = message.toLowerCase().trim();
  const plan = sessions.map((s) => ({ ...s }));
  const occupied = new Set(plan.map((s) => s.date));
  const todayIdx = plan.findIndex((s) => s.date === todayIso);

  if (/non posso|non mi alleno|salt(o|are)|oggi no/.test(msg) && todayIdx >= 0) {
    const moved = { ...plan[todayIdx] };
    occupied.delete(moved.date);
    const next = nextFreeDate(new Date(`${todayIso}T12:00:00`), occupied);
    moved.date = next;
    occupied.add(next);
    plan[todayIdx] = moved;
    return {
      reply: `Ok: "${sessions[todayIdx].name}" spostato al ${next}.`,
      plan,
    };
  }

  if (/niente lungo|no lungo|senza lungo/.test(msg) && todayIdx >= 0) {
    const original = plan[todayIdx];
    if (isLongSession(original.name)) {
      plan[todayIdx] = {
        ...original,
        name: "Endurance Z2",
        durationMin: 60,
        description: "Sostituzione: niente lungo oggi",
        workoutName: undefined,
      };
      const longCopy = { ...original, date: nextFreeDate(new Date(`${todayIso}T12:00:00`), occupied) };
      plan.push(longCopy);
      return {
        reply: "Oggi endurance 60' al posto del lungo; il lungo è spostato più avanti.",
        plan,
      };
    }
  }

  if (/stanco|affaticat|poco tempo|45/.test(msg) && todayIdx >= 0) {
    plan[todayIdx] = {
      ...plan[todayIdx],
      name: "Recupero attivo",
      durationMin: msg.includes("45") ? 45 : 40,
      description: "Adattato: recupero per vincolo atleta",
      workoutName: undefined,
    };
    return { reply: "Sessione di oggi alleggerita in recupero.", plan };
  }

  if (/fuori|non ho il rullo|sono fuori/.test(msg)) {
    return {
      reply: "Segnato: quando non hai il rullo, preferisci uscite brevi o recupero. Piano invariato salvo indicazioni specifiche.",
      plan,
      persistentConstraint: message.slice(0, 240),
    };
  }

  if (/solo\s+(lun|mar|mer|gio|ven|sab|dom)/.test(msg) || /posso solo/.test(msg)) {
    return {
      reply: "Vincolo registrato. Chiedi al coach di rigenerare il piano settimanale per applicarlo.",
      plan,
      persistentConstraint: message.slice(0, 240),
    };
  }

  return {
    reply: "Non ho capito il vincolo. Prova un tasto rapido o descrivi cosa cambiare oggi.",
    plan,
  };
}

export function mergePlanSessions(
  base: CoachPlanSession[],
  updates: CoachPlanSession[],
): CoachPlanSession[] {
  const byDate = new Map(base.map((s) => [s.date, s]));
  for (const update of updates) {
    byDate.set(update.date, update);
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export function calendarToPlanSessions(
  entries: { date: string; title: string; durationSecs?: number; notes?: string; entryType: string }[],
  fromDate: string,
): CoachPlanSession[] {
  return entries
    .filter((e) => e.entryType === "planned" && e.date >= fromDate)
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((e) => ({
      date: e.date,
      name: e.title,
      durationMin: Math.max(1, Math.round((e.durationSecs ?? 3600) / 60)),
      description: e.notes,
    }));
}
