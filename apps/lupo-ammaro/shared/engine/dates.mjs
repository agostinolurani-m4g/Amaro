/** Date helpers su stringhe YYYY-MM-DD in ora locale. */

export function isoLocal(date) {
  const d = date instanceof Date ? date : new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function parseIso(iso) {
  const [y, m, d] = String(iso).slice(0, 10).split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

export function addDaysIso(iso, days) {
  const d = parseIso(iso);
  d.setDate(d.getDate() + days);
  return isoLocal(d);
}

export function diffDays(fromIso, toIso) {
  return Math.round((parseIso(toIso).getTime() - parseIso(fromIso).getTime()) / 86400000);
}

/** 0 = lunedì … 6 = domenica */
export function weekdayIndex(iso) {
  return (parseIso(iso).getDay() + 6) % 7;
}

export function mondayOfIso(iso) {
  return addDaysIso(iso, -weekdayIndex(iso));
}

export const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
export const WEEKDAY_LABELS = ["Lun", "Mar", "Mer", "Gio", "Ven", "Sab", "Dom"];

export function todayLocal() {
  return isoLocal(new Date());
}
