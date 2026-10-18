/**
 * Ricerca web leggera via DuckDuckGo HTML (nessuna API key).
 */

function decodeHtml(text) {
  return String(text ?? "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function stripTags(html) {
  return decodeHtml(String(html ?? "").replace(/<[^>]+>/g, " "));
}

function parseResults(html, limit) {
  const results = [];
  const blockRe =
    /<a[^>]+class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>|<td[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/td>)/gi;

  let match;
  while ((match = blockRe.exec(html)) && results.length < limit) {
    let url = decodeHtml(match[1]);
    if (url.startsWith("//")) url = `https:${url}`;
    const title = stripTags(match[2]);
    const snippet = stripTags(match[3] || match[4] || "");
    if (!url || !title) continue;
    if (url.includes("duckduckgo.com/y.js")) continue;
    results.push({ title, url, snippet });
  }

  if (results.length === 0) {
    const linkRe =
      /<a[^>]+class="[^"]*result__url[^"]*"[^>]*href="([^"]+)"[^>]*>[\s\S]*?<a[^>]+class="[^"]*result__a[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
    while ((match = linkRe.exec(html)) && results.length < limit) {
      let url = decodeHtml(match[1]);
      if (url.startsWith("//")) url = `https:${url}`;
      const title = stripTags(match[2]);
      if (!url || !title) continue;
      results.push({ title, url, snippet: "" });
    }
  }

  return results;
}

export async function searchWeb(query, { limit = 5, timeoutMs = 8000 } = {}) {
  const q = String(query ?? "").trim();
  if (!q) {
    return { ok: false, error: "Query vuota.", results: [] };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(
      `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "WattLabCoach/1.0 (training app)",
        },
        body: `q=${encodeURIComponent(q)}`,
        signal: controller.signal,
      },
    );

    if (!res.ok) {
      return {
        ok: false,
        error: `Ricerca non disponibile (${res.status}).`,
        results: [],
      };
    }

    const html = await res.text();
    const results = parseResults(html, limit);
    if (results.length === 0) {
      return {
        ok: false,
        error: "Nessun risultato trovato.",
        results: [],
      };
    }

    return { ok: true, results, query: q };
  } catch (error) {
    const aborted = error?.name === "AbortError";
    return {
      ok: false,
      error: aborted
        ? "Ricerca web scaduta (timeout)."
        : "Ricerca web non disponibile (rete?).",
      results: [],
    };
  } finally {
    clearTimeout(timer);
  }
}
