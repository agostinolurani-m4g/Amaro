import { saveDoc, getDoc, newId, todayIso } from "../hooks/useStorage";
import type { LifeBlock, LifeBlockKind, LifeSlot, Weekday } from "../types";
import { touchLifeBlock } from "./syncClient";
import { WEEKDAY_ORDER } from "./athleteStore";

const DOC = "life_blocks";

export async function listLifeBlocks(): Promise<LifeBlock[]> {
  const raw = await getDoc<LifeBlock[]>(DOC).catch(() => null);
  return Array.isArray(raw) ? raw : [];
}

export async function saveLifeBlock(block: LifeBlock): Promise<LifeBlock[]> {
  const list = await listLifeBlocks();
  const saved = touchLifeBlock({ ...block, id: block.id || newId() });
  const idx = list.findIndex((b) => b.id === saved.id);
  const next = [...list];
  if (idx >= 0) next[idx] = saved;
  else next.push(saved);
  await saveDoc(DOC, next);
  return next;
}

export async function deleteLifeBlock(id: string): Promise<LifeBlock[]> {
  const next = (await listLifeBlocks()).filter((b) => b.id !== id);
  await saveDoc(DOC, next);
  return next;
}

const WEEKDAY_RE: Record<string, Weekday> = {
  lun: "mon",
  mar: "tue",
  mer: "wed",
  gio: "thu",
  ven: "fri",
  sab: "sat",
  dom: "sun",
};

export function weekdayFromText(msg: string): Weekday | undefined {
  const m = msg.toLowerCase().match(/\b(lun|mar|mer|gio|ven|sab|dom)\w*/);
  if (!m) return undefined;
  return WEEKDAY_RE[m[1]];
}

export function slotFromText(msg: string): LifeSlot {
  const lower = msg.toLowerCase();
  if (/mattin/.test(lower)) return "morning";
  if (/pomerigg/.test(lower)) return "afternoon";
  if (/sera|serata/.test(lower)) return "evening";
  return "all";
}

export function kindFromText(msg: string): LifeBlockKind {
  if (/solo\s+(mattin|pomerigg|sera)/.test(msg.toLowerCase()) || /posso solo/.test(msg.toLowerCase())) {
    return "window";
  }
  return "busy";
}

export function lifeBlocksForDate(blocks: LifeBlock[], iso: string): LifeBlock[] {
  const d = new Date(`${iso}T12:00:00`);
  const wd = WEEKDAY_ORDER[(d.getDay() + 6) % 7];
  return blocks.filter((b) => b.date === iso || b.weekday === wd);
}

export function isDateFullyBusy(blocks: LifeBlock[], iso: string): boolean {
  return lifeBlocksForDate(blocks, iso).some((b) => b.kind === "busy" && b.slot === "all");
}

export async function upsertLifeBlockFromMessage(
  message: string,
  opts?: { date?: string; source?: LifeBlock["source"] },
): Promise<LifeBlock | null> {
  const trimmed = message.trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();
  if (!/(fuori|non posso|impegn|viagg|lavoro|cena|solo\s|posso solo|occupat)/.test(lower)) {
    return null;
  }
  const date = opts?.date;
  const weekday = date ? undefined : weekdayFromText(trimmed);
  const block: LifeBlock = {
    id: "",
    label: trimmed.slice(0, 120),
    date,
    weekday,
    slot: slotFromText(trimmed),
    kind: kindFromText(trimmed),
    source: opts?.source ?? "chat",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await saveLifeBlock(block);
  return block;
}

export function nextFreeTrainingDate(
  fromIso: string,
  occupied: Set<string>,
  blocks: LifeBlock[],
  maxDays = 14,
): string {
  const start = new Date(`${fromIso}T12:00:00`);
  for (let i = 1; i <= maxDays; i += 1) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    if (iso < todayIso()) continue;
    if (occupied.has(iso)) continue;
    if (isDateFullyBusy(blocks, iso)) continue;
    return iso;
  }
  const fallback = new Date(start);
  fallback.setDate(fallback.getDate() + 7);
  return `${fallback.getFullYear()}-${String(fallback.getMonth() + 1).padStart(2, "0")}-${String(fallback.getDate()).padStart(2, "0")}`;
}
