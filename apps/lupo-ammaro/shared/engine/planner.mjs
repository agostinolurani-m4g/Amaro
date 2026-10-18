import { addDaysIso, diffDays, mondayOfIso, todayLocal, weekdayIndex, WEEKDAYS } from "./dates.mjs";
import { generateWorkout, SESSION_TYPES, substituteType } from "./workoutGen.mjs";

const CTL_WEEK_GAIN = 1 - Math.exp(-7 / 42);

const RAMP_BY_EXPERIENCE = { principiante: 3, intermedio: 4, avanzato: 5, elite: 6 };
const TSS_H_CAP = { principiante: 50, intermedio: 58, avanzato: 65, elite: 72 };
const MAX_SESSIONS = { principiante: 4, intermedio: 5, avanzato: 6, elite: 7 };

const PHASE_LABEL = {
  base: "Base aerobica",
  build: "Costruzione",
  peak: "Specificità / picco",
  taper: "Scarico pre-gara",
  recovery: "Settimana di recupero",
  race: "Settimana gara",
};

/** Qualità per fase e focus (in ordine di priorità). */
const QUALITY = {
  ftp: { base: ["sst", "tempo"], build: ["sst", "threshold", "overunder"], peak: ["threshold", "vo2"] },
  vo2: { base: ["sst", "vo2_30_30"], build: ["vo2", "threshold", "vo2_30_30"], peak: ["vo2", "vo2_30_30"] },
  endurance: { base: ["tempo", "sst"], build: ["sst", "tempo"], peak: ["sst", "threshold"] },
  granfondo: { base: ["tempo", "sst"], build: ["sst", "threshold", "vo2"], peak: ["threshold", "vo2"] },
  climb: { base: ["lowcadence", "sst"], build: ["lowcadence", "threshold", "vo2"], peak: ["threshold", "vo2"] },
  recovery: { base: ["tempo"], build: ["tempo"], peak: ["tempo"] },
  mixed: { base: ["sst", "tempo"], build: ["threshold", "vo2", "sst"], peak: ["vo2", "threshold"] },
};

const EVENT_FOCUS = { granfondo: "granfondo", crono: "ftp", salita: "climb", criterium: "vo2", gara: "mixed", altro: "mixed" };

function nextAEvent(settings, startDate) {
  return (settings?.events ?? [])
    .filter((e) => e.date >= startDate)
    .sort((a, b) => (a.priority === b.priority ? a.date.localeCompare(b.date) : a.priority.localeCompare(b.priority)))[0];
}

/** Fasi settimana per settimana dal lunedì corrente all'evento (o rolling). */
export function buildMacrocycle({ settings, startDate = todayLocal(), weeks, tsb = 0 }) {
  const start = mondayOfIso(startDate);
  const event = nextAEvent(settings, startDate);
  const every = settings?.recoveryWeekEvery ?? (settings?.experience === "principiante" ? 3 : 4);
  const weeksToEvent = event ? Math.floor(diffDays(start, event.date) / 7) : null;
  const total = Math.max(1, Math.min(26, weeks ?? (weeksToEvent != null ? weeksToEvent + 1 : 4)));

  const phases = [];
  for (let w = 0; w < total; w++) {
    const weekStart = addDaysIso(start, w * 7);
    let phase = "build";
    if (weeksToEvent != null) {
      const toGo = weeksToEvent - w;
      if (toGo <= 0) phase = "race";
      else if (toGo === 1) phase = "taper";
      else if (toGo <= 3) phase = "peak";
      else if (toGo <= 9) phase = "build";
      else phase = "base";
    } else if (settings?.focus === "recovery") {
      phase = "recovery";
    } else if (settings?.focus === "endurance" || settings?.focus === "granfondo") {
      phase = w < 2 ? "base" : "build";
    }
    const cycleIdx = w % every;
    const isRecovery =
      phase === "recovery" ||
      ((phase === "base" || phase === "build") && cycleIdx === every - 1) ||
      (w === 0 && tsb < -25);
    phases.push({
      weekStart,
      phase: isRecovery && phase !== "recovery" ? "recovery" : phase,
      basePhase: phase,
      cycleIdx,
      recovery: isRecovery,
      event: event && event.date >= weekStart && event.date <= addDaysIso(weekStart, 6) ? event : null,
    });
  }
  return { event, phases };
}

function weekAvailability(settings) {
  const avail = settings?.availability ?? {};
  return WEEKDAYS.map((d) => Math.max(0, Number(avail[d] ?? 0)));
}

function combinations(items, k) {
  if (k === 0) return [[]];
  const out = [];
  items.forEach((item, idx) => {
    for (const rest of combinations(items.slice(idx + 1), k - 1)) out.push([item, ...rest]);
  });
  return out;
}

/** Assegna giorni: lungo, qualità distanziate (ricerca combinatoria), resto facile. */
function assignDays(availMin, nQuality, wantLong, longDayIdx, maxSessions, experience) {
  const days = availMin.map((m, i) => ({ i, m })).filter((d) => d.m >= 30);
  const roles = new Array(7).fill(null);
  let longIdx = -1;
  if (wantLong && days.length) {
    const preferred = longDayIdx != null && availMin[longDayIdx] >= 75 ? longDayIdx : null;
    longIdx = preferred ?? [...days].sort((a, b) => b.m - a.m || b.i - a.i)[0].i;
    roles[longIdx] = "long";
  }
  const candidates = days.filter((d) => roles[d.i] == null && d.m >= 45).map((d) => d.i);
  const k = Math.min(nQuality, candidates.length);
  let best = null;
  for (const combo of combinations(candidates, k)) {
    let score = 0;
    const set = new Set(combo);
    for (const i of combo) {
      score += Math.min(availMin[i], 90) / 30;
      const near = [(i + 6) % 7, (i + 1) % 7];
      for (const n of near) {
        if (set.has(n)) score -= 10;
        if (n === longIdx) score -= 4;
      }
    }
    if (!best || score > best.score) best = { combo, score };
  }
  for (const i of best?.combo ?? []) roles[i] = "quality";

  let count = roles.filter(Boolean).length;
  const gentleAfterQuality = experience === "principiante" || experience === "intermedio";
  for (const d of [...days].sort((a, b) => b.m - a.m)) {
    if (count >= maxSessions) break;
    if (roles[d.i] != null) continue;
    const prev = roles[(d.i + 6) % 7];
    roles[d.i] = prev === "quality" && gentleAfterQuality && d.m < 75 ? "recovery" : "easy";
    count++;
  }
  return roles;
}

function levelFor(phaseInfo, experience) {
  const expOffset = { principiante: 0, intermedio: 1, avanzato: 1, elite: 2 }[experience] ?? 1;
  if (phaseInfo.recovery) return 1;
  if (phaseInfo.phase === "taper" || phaseInfo.phase === "race") return 2;
  return Math.min(5, 1 + phaseInfo.cycleIdx + expOffset);
}

/**
 * Piano concreto (sessioni datate + workout) per le prossime settimane.
 * @param {{settings:any, model:any, load:{ctl:number, atl:number, tsb:number}, startDate?:string, weeks?:number, compliance?:number|null, readiness?:number|null}} opts
 */
export function generatePlan({ settings, model, load, startDate = todayLocal(), weeks = 4, compliance = null }) {
  const experience = settings?.experience ?? "intermedio";
  const focus = settings?.focus ?? "mixed";
  const macro = buildMacrocycle({ settings, startDate, tsb: load?.tsb ?? 0 });
  const horizon = macro.phases.slice(0, Math.max(1, weeks));
  const eventFocus = macro.event ? EVENT_FOCUS[macro.event.type] ?? focus : focus;
  const qualityTable = QUALITY[eventFocus] ?? QUALITY.mixed;
  const avoid = settings?.avoid ?? [];
  const likes = settings?.likes ?? [];
  const availMin = weekAvailability(settings);
  const outdoor = new Set(settings?.outdoorDays ?? []);
  const maxWeekMin = Math.max(60, (settings?.maxHoursWeek ?? 8) * 60);
  const longDayIdx = settings?.preferredLongDay ? WEEKDAYS.indexOf(settings.preferredLongDay) : null;

  let ctl = Math.max(0, load?.ctl ?? 0);
  const ramp = RAMP_BY_EXPERIENCE[experience] ?? 4;
  const compScale = compliance != null && compliance < 70 ? 0.9 : 1;

  const sessions = [];
  const drafts = new Map();
  const phaseWeeks = [];
  let prevTarget = Math.max(150, ctl * 7);

  for (const info of horizon) {
    const availThisWeek = availMin.reduce((a, b) => a + b, 0);
    const capMin = Math.min(maxWeekMin, availThisWeek);
    const capTss = (capMin / 60) * (TSS_H_CAP[experience] ?? 58);

    let target;
    if (info.recovery) target = prevTarget * 0.6;
    else if (info.phase === "taper") target = prevTarget * 0.55;
    else if (info.phase === "race") target = prevTarget * 0.45;
    else if (info.phase === "peak") target = Math.max(prevTarget * 0.92, ctl * 7);
    else target = 7 * (ctl + ramp / CTL_WEEK_GAIN) * 0.97;
    target = Math.min(capTss, Math.max(120, target)) * compScale;

    const phaseKey = info.basePhase === "race" || info.basePhase === "taper" ? "peak" : info.basePhase === "peak" ? "peak" : info.basePhase === "base" ? "base" : "build";
    let qualityTypes = [...(qualityTable[phaseKey] ?? qualityTable.build)];
    if (likes.length) qualityTypes.sort((a, b) => Number(likes.includes(b)) - Number(likes.includes(a)));
    let nQuality = info.recovery ? 1 : info.phase === "taper" || info.phase === "race" ? 1 : phaseKey === "base" ? 1 : 2;
    if (experience === "principiante" && phaseKey !== "build") nQuality = 1;
    if (focus === "recovery") nQuality = 0;
    const wantLong = !info.recovery && info.phase !== "race";
    const roles = assignDays(availMin, nQuality, wantLong, longDayIdx, MAX_SESSIONS[experience] ?? 5, experience);
    const remainingDays = Math.max(0, Math.min(7, 7 - diffDays(info.weekStart, startDate)));
    if (remainingDays < 7) {
      const remainingMin = availMin.slice(7 - remainingDays).reduce((a, b) => a + b, 0);
      target = Math.min(target, (remainingMin / 60) * (TSS_H_CAP[experience] ?? 58));
    }

    const weekSessions = [];
    let q = 0;
    for (let d = 0; d < 7; d++) {
      const role = roles[d];
      if (!role) continue;
      const date = addDaysIso(info.weekStart, d);
      if (date < startDate) continue;
      if (info.event && date === info.event.date) continue;
      const avail = availMin[d];
      let type;
      let minutes;
      if (role === "long") {
        const longType = (eventFocus === "granfondo" || focus === "endurance") && phaseKey !== "base" ? "durability" : "z2";
        type = longType;
        const longMax = { base: 150, build: 180, peak: 150 }[phaseKey] ?? 120;
        minutes = Math.min(avail, longMax, macro.event?.durationH ? macro.event.durationH * 60 : 300);
      } else if (role === "quality") {
        type = info.recovery ? "tempo" : qualityTypes[q % qualityTypes.length];
        if (info.phase === "taper" || info.phase === "race") type = q === 0 ? "openers" : "vo2_30_30";
        q++;
        minutes = Math.min(avail, info.recovery ? 50 : 75);
      } else if (role === "recovery") {
        type = "recovery";
        minutes = Math.min(avail, 45);
      } else {
        type = "z2";
        minutes = Math.min(avail, info.recovery ? 50 : 75);
      }
      type = substituteType(type, avoid);
      weekSessions.push({ date, d, role, type, minutes: Math.max(30, Math.round(minutes / 5) * 5), avail });
    }

    if (info.event && info.event.date >= startDate) {
      const di = weekdayIndex(info.event.date);
      const dayBefore = addDaysIso(info.event.date, -1);
      for (const s of weekSessions) {
        if (s.date === dayBefore) {
          s.type = "openers";
          s.minutes = Math.min(s.avail, 45);
        }
        if (s.d > di) s.type = "recovery";
      }
    }

    const estTss = (s) => (s.minutes / 60) * (SESSION_TYPES[s.type]?.tssH ?? 50);
    for (let iter = 0; iter < 12; iter++) {
      const total = weekSessions.reduce((sum, s) => sum + estTss(s), 0);
      const totalMin = weekSessions.reduce((sum, s) => sum + s.minutes, 0);
      if (Math.abs(total - target) < target * 0.06) break;
      const grow = total < target && totalMin < capMin;
      let changed = false;
      for (const s of weekSessions) {
        if (s.type === "recovery" || s.type === "openers") continue;
        const flexible = s.role === "long" || s.role === "easy";
        if (!flexible && grow) continue;
        const step = grow ? 15 : -15;
        const minM = s.role === "long" ? 75 : 40;
        const next = Math.max(minM, Math.min(s.avail, s.minutes + step));
        if (next !== s.minutes) {
          s.minutes = next;
          changed = true;
        }
      }
      if (!changed) break;
    }

    let weekPlanned = 0;
    for (const s of weekSessions) {
      const level = levelFor(info, experience);
      const draft = generateWorkout({ type: s.type, durationMin: s.minutes, level: s.type === "z2" || s.type === "recovery" ? 1 : level, model });
      const key = draft.name.toLowerCase();
      if (!drafts.has(key)) drafts.set(key, draft);
      const isOutdoor = outdoor.has(WEEKDAYS[s.d]);
      weekPlanned += draft.prediction.tss;
      sessions.push({
        date: s.date,
        name: `${SESSION_TYPES[s.type].label}${isOutdoor ? " (outdoor)" : ""}`,
        durationMin: Math.round(draft.prediction.durationSecs / 60),
        description: `${PHASE_LABEL[info.phase]} · ${draft.description}`.slice(0, 400),
        workoutName: draft.name,
        plannedTss: draft.prediction.tss,
        sessionType: s.type,
        phase: info.phase,
        outdoor: isOutdoor || undefined,
      });
    }

    phaseWeeks.push({
      weekStart: info.weekStart,
      phase: info.phase,
      label: PHASE_LABEL[info.phase],
      targetTss: Math.round(target),
      plannedTss: Math.round(weekPlanned),
      recovery: info.recovery,
      focusNote: info.event ? `Evento: ${info.event.name} (${info.event.date})` : info.recovery ? "Assorbi il carico: volume −40%, niente Z5+." : `Qualità: ${qualityTypes.slice(0, nQuality).map((t) => SESSION_TYPES[t]?.label).join(", ")}`,
    });

    ctl = ctl + (weekPlanned / 7 - ctl) * CTL_WEEK_GAIN;
    if (!info.recovery && remainingDays === 7) prevTarget = Math.max(target, weekPlanned);
  }

  const fullMacro = macro.phases.map((p) => ({
    weekStart: p.weekStart,
    phase: p.phase,
    label: PHASE_LABEL[p.phase],
    recovery: p.recovery,
  }));

  const summary = [
    macro.event
      ? `Obiettivo ${macro.event.name} il ${macro.event.date}: ${macro.phases.length} settimane di macrociclo.`
      : `Blocco rolling di ${horizon.length} settimane (nessun evento A in calendario).`,
    `CTL attuale ${Math.round(load?.ctl ?? 0)} → previsto ${Math.round(ctl)} a fine blocco.`,
    compScale < 1 ? "Compliance recente bassa: carico ridotto del 10%." : "",
  ]
    .filter(Boolean)
    .join(" ");

  return {
    sessions: sessions.sort((a, b) => a.date.localeCompare(b.date)),
    workouts: [...drafts.values()],
    phases: phaseWeeks,
    macro: fullMacro,
    event: macro.event ?? null,
    projectedCtl: Math.round(ctl * 10) / 10,
    summary,
  };
}

/** Prontezza 0–100 da check-in + TSB. */
export function readinessScore(checkin, tsb = 0) {
  let score = 70;
  if (checkin) {
    score = 50;
    score += (checkin.sleep - 3) * 9;
    score -= (checkin.fatigue - 3) * 10;
    score -= (checkin.soreness - 3) * 6;
    score -= (checkin.stress - 3) * 5;
    score += ((checkin.motivation ?? 3) - 3) * 4;
  }
  if (tsb < -25) score -= 15;
  else if (tsb < -15) score -= 8;
  else if (tsb > 10) score += 5;
  return Math.max(0, Math.min(100, Math.round(score)));
}

/** Adatta la sessione di oggi alla prontezza. */
export function adaptSession(session, { readiness, model }) {
  if (!session) return { session: null, draft: null, reason: "Nessuna sessione pianificata oggi.", readiness };
  const type = session.sessionType ?? "z2";
  const hard = SESSION_TYPES[type]?.hard;
  let nextType = type;
  let minutes = session.durationMin;
  let reason = "Prontezza buona: sessione confermata.";
  if (readiness < 35) {
    nextType = "recovery";
    minutes = Math.min(40, minutes);
    reason = `Prontezza ${readiness}/100: oggi solo recupero attivo (o riposo completo).`;
  } else if (readiness < 55) {
    if (hard) {
      nextType = "z2";
      minutes = Math.min(60, minutes);
      reason = `Prontezza ${readiness}/100: qualità sostituita con Z2 corto, la riprogrammiamo.`;
    } else {
      minutes = Math.round(minutes * 0.8);
      reason = `Prontezza ${readiness}/100: volume ridotto del 20%.`;
    }
  }
  if (nextType === type && minutes === session.durationMin) return { session, draft: null, reason, readiness, changed: false };
  const draft = generateWorkout({ type: nextType, durationMin: minutes, level: 1, model });
  return {
    session: {
      ...session,
      name: `${SESSION_TYPES[nextType].label} (adattato)`,
      durationMin: Math.round(draft.prediction.durationSecs / 60),
      description: `${reason} ${draft.description}`.slice(0, 400),
      workoutName: draft.name,
      plannedTss: draft.prediction.tss,
      sessionType: nextType,
    },
    draft,
    reason,
    readiness,
    changed: true,
    originalType: type,
  };
}
