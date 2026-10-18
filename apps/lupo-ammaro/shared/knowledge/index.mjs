// Parser + retrieval per le schede di knowledge (shared/knowledge/*.md).
// Funzioni pure: il caricamento dei file avviene nel server (fs) o nel client (import.meta.glob).

/**
 * @typedef {{ id: string, title: string, source: string, tags: string[], body: string }} KnowledgeCard
 */

/** @param {string} raw @param {string} [fallbackId] @returns {KnowledgeCard | null} */
export function parseCard(raw, fallbackId = "") {
  const text = String(raw || "").replace(/\r\n/g, "\n").trim();
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return null;
  /** @type {Record<string, string>} */
  const meta = {};
  for (const line of m[1].split("\n")) {
    const i = line.indexOf(":");
    if (i <= 0) continue;
    meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  const id = meta.id || fallbackId;
  if (!id) return null;
  return {
    id,
    title: meta.title || id,
    source: meta.source || "",
    tags: (meta.tags || "")
      .split(",")
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean),
    body: m[2].trim(),
  };
}

/** @param {Record<string, string>} files path -> contenuto @returns {KnowledgeCard[]} */
export function parseCards(files) {
  /** @type {KnowledgeCard[]} */
  const out = [];
  for (const [path, raw] of Object.entries(files)) {
    const base = path.split(/[\\/]/).pop()?.replace(/\.md$/, "") ?? "";
    const card = parseCard(raw, base);
    if (card) out.push(card);
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

const STOP = new Set(
  "il lo la i gli le un una di da in con su per tra fra e o a al del della dei degli delle che come cosa quale quali mi ti si ci è sono ho hai the of and to".split(
    " ",
  ),
);

/** @param {string} s */
function tokens(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9'%/ ]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOP.has(t));
}

/** @param {string} s */
function norm(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

/**
 * Ricerca per tag (peso alto), titolo (medio) e corpo (basso).
 * @param {KnowledgeCard[]} cards
 * @param {string} query
 * @param {{ limit?: number, tags?: string[] }} [opts]
 * @returns {KnowledgeCard[]}
 */
export function searchCards(cards, query, { limit = 3, tags = [] } = {}) {
  const q = tokens(query);
  const wantTags = tags.map(norm);
  const scored = cards.map((c) => {
    const cardTags = c.tags.map(norm);
    const title = norm(c.title);
    const body = norm(c.body);
    let score = 0;
    for (const t of wantTags) if (cardTags.includes(t)) score += 6;
    for (const t of q) {
      if (cardTags.some((tag) => tag === t)) score += 5;
      else if (cardTags.some((tag) => tag.includes(t) || (t.length > 3 && t.includes(tag)))) score += 3;
      if (title.includes(t)) score += 2;
      if (t.length > 3 && body.includes(t)) score += 0.5;
    }
    return { c, score };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.c);
}

/** @param {KnowledgeCard[]} cards @param {string[]} ids */
export function cardsById(cards, ids) {
  return ids.map((id) => cards.find((c) => c.id === id)).filter(Boolean);
}

/** Schede rilevanti per focus di allenamento. */
export const FOCUS_CARDS = {
  ftp: ["sweet-spot", "soglia-mlss-cp", "test-ftp", "pmc"],
  vo2: ["vo2max-intervalli", "distribuzione-intensita", "cp-wprime-wbal", "recupero-sonno-hrv"],
  endurance: ["zona2", "distribuzione-intensita", "disaccoppiamento", "fatmax-substrati"],
  granfondo: ["durabilita", "pacing-granfondo", "alimentazione-carboidrati", "zona2"],
  climb: ["cadenza-forza", "composizione-wkg", "sweet-spot", "vo2max-intervalli"],
  recovery: ["recupero-sonno-hrv", "overreaching", "pmc", "zona2"],
  mixed: ["coggan-zones", "distribuzione-intensita", "periodizzazione", "pmc"],
};
