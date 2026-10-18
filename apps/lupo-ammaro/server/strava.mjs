import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  invalidateLists,
  markChanges,
  once,
  pruneAll,
  readActivity,
  readList,
  readProfile,
  takeChanges,
  writeActivity,
  writeList,
  writeProfile,
} from "./stravaCache.mjs";

const READ_SCOPE = "read,activity:read_all,profile:read_all,activity:write";

pruneAll();

const rateState = { shortUsed: 0, shortLimit: 100, longUsed: 0, longLimit: 1000 };
const syncStamp = new Map();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKENS_PATH = path.join(__dirname, "strava_tokens.json");
const OAUTH_STATES = new Map();

const STRAVA_AUTH = "https://www.strava.com/oauth/authorize";
const STRAVA_TOKEN = "https://www.strava.com/oauth/token";
const STRAVA_DEAUTH = "https://www.strava.com/oauth/deauthorize";
const STRAVA_API = "https://www.strava.com/api/v3";

function stravaConfigured() {
  return Boolean(process.env.STRAVA_CLIENT_ID && process.env.STRAVA_CLIENT_SECRET);
}

function redirectUri() {
  return (
    process.env.STRAVA_REDIRECT_URI ??
    `http://127.0.0.1:${process.env.PORT ?? 8000}/api/wattlab/strava/callback`
  );
}

function loadTokens() {
  if (!fs.existsSync(TOKENS_PATH)) return {};
  try {
    const data = JSON.parse(fs.readFileSync(TOKENS_PATH, "utf8"));
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}

function saveTokens(store) {
  fs.writeFileSync(TOKENS_PATH, JSON.stringify(store, null, 2), "utf8");
}

function tokenForMember(memberId) {
  const key = String(memberId);
  return loadTokens()[key] ?? null;
}

function setTokenForMember(memberId, token) {
  const store = loadTokens();
  store[String(memberId)] = token;
  saveTokens(store);
}

function deleteTokenForMember(memberId) {
  const store = loadTokens();
  delete store[String(memberId)];
  saveTokens(store);
}

function canReadScope(scope) {
  const s = String(scope ?? "");
  return s.includes("activity:read");
}

function connectedStatus(memberId) {
  const configured = stravaConfigured();
  const token = tokenForMember(memberId);
  const near = rateState.shortLimit > 0 && rateState.shortUsed / rateState.shortLimit >= 0.85;
  const stamp = syncStamp.get(String(memberId));
  return {
    configured,
    connected: !!(configured && token?.accessToken),
    athleteId: token?.athleteId ?? null,
    canRead: !!(token && canReadScope(token.scope)),
    scope: token?.scope ?? null,
    rateUsage: { ...rateState, nearLimit: near },
    lastSyncAt: stamp?.at ?? null,
    imported: stamp?.imported ?? null,
  };
}

function memberIdForAthlete(athleteId) {
  const store = loadTokens();
  for (const [id, token] of Object.entries(store)) {
    if (String(token?.athleteId) === String(athleteId)) return id;
  }
  return null;
}

function noteRate(res) {
  const usage = res.headers.get("x-ratelimit-usage");
  const limit = res.headers.get("x-ratelimit-limit");
  if (!usage || !limit) return;
  const [shortUsed, longUsed] = usage.split(",").map(Number);
  const [shortLimit, longLimit] = limit.split(",").map(Number);
  if (Number.isFinite(shortUsed)) rateState.shortUsed = shortUsed;
  if (Number.isFinite(longUsed)) rateState.longUsed = longUsed;
  if (Number.isFinite(shortLimit)) rateState.shortLimit = shortLimit;
  if (Number.isFinite(longLimit)) rateState.longLimit = longLimit;
}

function nearLimit() {
  return rateState.shortLimit > 0 && rateState.shortUsed / rateState.shortLimit >= 0.85;
}

export async function stravaGet(memberId, apiPath, query = {}, { allowNear = false } = {}) {
  if (!allowNear && nearLimit()) {
    const err = new Error("Limite API Strava vicino: uso i dati già in cache.");
    err.code = "rate_near";
    throw err;
  }
  const token = await getValidAccessToken(memberId);
  const url = new URL(`${STRAVA_API}${apiPath}`);
  for (const [k, v] of Object.entries(query)) {
    if (v != null && v !== "") url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  noteRate(res);
  if (res.status === 429) {
    const err = new Error("Strava ha limitato le richieste. Riprova tra qualche minuto.");
    err.code = "rate_429";
    throw err;
  }
  if (!res.ok) {
    const detail = await res.text();
    const err = new Error(`Strava ${res.status}: ${detail.slice(0, 180)}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

const NOT_LINKED =
  "Strava non è collegato in lettura. Vai su Profilo → Strava → Ricollega per autorizzare la lettura.";

function assertRead(memberId) {
  const st = connectedStatus(memberId);
  if (!st.connected) throw new Error(NOT_LINKED);
  if (!st.canRead) throw new Error(NOT_LINKED);
}

export async function listActivities(memberId, { after, before, page = 1, perPage = 30, force = false } = {}) {
  assertRead(memberId);
  const key = `${after ?? 0}_${before ?? 0}_${page}_${perPage}`;
  const cached = readList(memberId, key, { force });
  if (cached) return { activities: cached, cached: true, nearLimit: nearLimit() };
  return once(`list:${memberId}:${key}`, async () => {
    try {
      const activities = await stravaGet(memberId, "/athlete/activities", { after, before, page, per_page: perPage });
      writeList(memberId, key, activities);
      return { activities, cached: false, nearLimit: nearLimit() };
    } catch (error) {
      const stale = readList(memberId, key, { maxAgeMs: 7 * 86400000, force: false });
      if (stale && (error.code === "rate_near" || error.code === "rate_429")) {
        return { activities: stale, cached: true, nearLimit: true, note: error.message };
      }
      throw error;
    }
  });
}

function streamsToSeries(streams) {
  const byType = Object.fromEntries((streams ?? []).map((s) => [s.type, s.data]));
  const time = byType.time ?? [];
  const watts = byType.watts ?? [];
  const hr = byType.heartrate ?? [];
  const cad = byType.cadence ?? [];
  const series = [];
  let last = -1;
  for (let i = 0; i < time.length; i++) {
    const t = Math.round(time[i]);
    if (t <= last) continue;
    last = t;
    series.push({
      t,
      power: watts[i] > 0 ? Math.round(watts[i]) : undefined,
      hr: hr[i] > 0 ? Math.round(hr[i]) : undefined,
      cadence: cad[i] > 0 ? Math.round(cad[i]) : undefined,
    });
  }
  return series;
}

export async function activityBundle(memberId, id, { updatedAt, movingTime, force = false } = {}) {
  assertRead(memberId);
  const stamp = `${updatedAt ?? ""}|${movingTime ?? ""}`;
  if (!force) {
    const hit = readActivity(memberId, id, stamp || undefined);
    if (hit) return { ...hit, cached: true, nearLimit: nearLimit() };
  }
  return once(`act:${memberId}:${id}`, async () => {
    const activity = await stravaGet(memberId, `/activities/${id}`);
    let streams = [];
    let laps = activity.laps ?? [];
    try {
      streams = await stravaGet(memberId, `/activities/${id}/streams`, {
        keys: "time,watts,heartrate,cadence,velocity_smooth,altitude,distance",
        key_by_type: true,
      });
    } catch {
      streams = [];
    }
    if (!laps.length) {
      try {
        laps = await stravaGet(memberId, `/activities/${id}/laps`);
      } catch {
        laps = [];
      }
    }
    const data = {
      activity,
      series: streamsToSeries(streams),
      laps: (laps ?? []).slice(0, 40).map((l) => ({
        name: l.name,
        min: Math.round((l.moving_time ?? l.elapsed_time ?? 0) / 60),
        watts: l.average_watts ?? null,
        hr: l.average_heartrate ?? null,
      })),
      segments: (activity.segment_efforts ?? []).slice(0, 8).map((s) => ({
        name: s.name,
        min: Math.round((s.elapsed_time ?? 0) / 60),
      })),
    };
    writeActivity(memberId, id, `${activity.updated_at ?? ""}|${activity.moving_time ?? ""}`, data);
    return { ...data, cached: false, nearLimit: nearLimit() };
  });
}

export async function athleteProfile(memberId, { force = false } = {}) {
  assertRead(memberId);
  const cached = readProfile(memberId, "athlete", { force });
  if (cached) return { ...cached, cached: true };
  return once(`ath:${memberId}`, async () => {
    const athlete = await stravaGet(memberId, "/athlete");
    let zones = null;
    let stats = null;
    try {
      zones = await stravaGet(memberId, "/athlete/zones");
    } catch {
      zones = null;
    }
    try {
      stats = await stravaGet(memberId, `/athletes/${athlete.id}/stats`);
    } catch {
      stats = null;
    }
    const data = { athlete, zones, stats };
    writeProfile(memberId, "athlete", data);
    return { ...data, cached: false };
  });
}

export { NOT_LINKED, nearLimit, connectedStatus as stravaStatus };

async function refreshAccessToken(memberId, token) {
  const clientId = process.env.STRAVA_CLIENT_ID;
  const clientSecret = process.env.STRAVA_CLIENT_SECRET;
  if (!clientId || !clientSecret || !token?.refreshToken) {
    throw new Error("Token Strava non valido. Ricollega Strava dal profilo.");
  }

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "refresh_token",
    refresh_token: token.refreshToken,
  });

  const res = await fetch(STRAVA_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) {
    deleteTokenForMember(memberId);
    throw new Error("Sessione Strava scaduta. Ricollega dal profilo.");
  }

  const data = await res.json();
  const next = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? token.refreshToken,
    expiresAt: data.expires_at,
    athleteId: data.athlete?.id ?? token.athleteId,
    scope: token.scope,
  };
  setTokenForMember(memberId, next);
  return next;
}

async function getValidAccessToken(memberId) {
  let token = tokenForMember(memberId);
  if (!token?.accessToken) {
    throw new Error("Strava non collegato.");
  }
  const now = Math.floor(Date.now() / 1000);
  if (token.expiresAt && token.expiresAt <= now + 120) {
    token = await refreshAccessToken(memberId, token);
  }
  return token.accessToken;
}

function callbackHtml(title, message) {
  return `<!DOCTYPE html>
<html lang="it">
<head><meta charset="utf-8"><title>${title}</title></head>
<body style="font-family:system-ui,sans-serif;padding:2rem;max-width:32rem;margin:auto;">
  <h1>${title}</h1>
  <p>${message}</p>
  <p>Puoi chiudere questa finestra e tornare a WattLab.</p>
</body>
</html>`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function mountStravaRoutes(app, { requireAuth, requireActiveMember }) {
  app.get(
    "/api/wattlab/strava/status",
    requireAuth,
    requireActiveMember,
    (req, res) => {
      res.json(connectedStatus(req.auth.member.id));
    },
  );

  app.post(
    "/api/wattlab/strava/connect",
    requireAuth,
    requireActiveMember,
    (req, res) => {
      if (!stravaConfigured()) {
        res.status(503).json({
          detail: "Strava non configurato sul server (STRAVA_CLIENT_ID/SECRET).",
        });
        return;
      }

      const state = crypto.randomBytes(16).toString("hex");
      OAUTH_STATES.set(state, {
        memberId: req.auth.member.id,
        expiresAt: Date.now() + 10 * 60 * 1000,
      });

      const params = new URLSearchParams({
        client_id: process.env.STRAVA_CLIENT_ID,
        response_type: "code",
        redirect_uri: redirectUri(),
        approval_prompt: "auto",
        scope: READ_SCOPE,
        state,
      });

      res.json({ authorizeUrl: `${STRAVA_AUTH}?${params.toString()}` });
    },
  );

  app.get("/api/wattlab/strava/callback", async (req, res) => {
    const error = req.query.error ? String(req.query.error) : null;
    if (error) {
      res
        .status(400)
        .send(callbackHtml("Strava", `Autorizzazione annullata: ${error}`));
      return;
    }

    const code = String(req.query.code ?? "");
    const state = String(req.query.state ?? "");
    const pending = OAUTH_STATES.get(state);
    OAUTH_STATES.delete(state);

    if (!pending || pending.expiresAt < Date.now()) {
      res.status(400).send(callbackHtml("Strava", "Link scaduto o non valido. Riprova da WattLab."));
      return;
    }

    if (!stravaConfigured()) {
      res.status(503).send(callbackHtml("Strava", "Server non configurato."));
      return;
    }

    try {
      const body = new URLSearchParams({
        client_id: process.env.STRAVA_CLIENT_ID,
        client_secret: process.env.STRAVA_CLIENT_SECRET,
        code,
        grant_type: "authorization_code",
      });

      const tokenRes = await fetch(STRAVA_TOKEN, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });

      if (!tokenRes.ok) {
        const detail = await tokenRes.text();
        res
          .status(502)
          .send(callbackHtml("Strava", `Scambio token fallito: ${detail.slice(0, 120)}`));
        return;
      }

      const data = await tokenRes.json();
      setTokenForMember(pending.memberId, {
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresAt: data.expires_at,
        athleteId: data.athlete?.id ?? null,
        scope: data.scope ?? READ_SCOPE,
      });

      res.send(callbackHtml("Strava collegato", "Account collegato con successo."));
    } catch (e) {
      res.status(500).send(callbackHtml("Errore", String(e.message ?? e)));
    }
  });

  app.post(
    "/api/wattlab/strava/disconnect",
    requireAuth,
    requireActiveMember,
    async (req, res) => {
      const memberId = req.auth.member.id;
      const token = tokenForMember(memberId);
      if (token?.accessToken) {
        try {
          const access = await getValidAccessToken(memberId);
          await fetch(`${STRAVA_DEAUTH}?access_token=${encodeURIComponent(access)}`, {
            method: "POST",
          });
        } catch {
          // ignore remote deauth errors
        }
      }
      deleteTokenForMember(memberId);
      res.json(connectedStatus(memberId));
    },
  );

  app.get("/api/wattlab/strava/activities", requireAuth, requireActiveMember, async (req, res) => {
    try {
      const after = req.query.after ? Number(req.query.after) : undefined;
      const page = req.query.page ? Number(req.query.page) : 1;
      const force = req.query.force === "1";
      const out = await listActivities(req.auth.member.id, { after, page, perPage: 30, force });
      res.json(out);
    } catch (e) {
      res.status(e.code === "rate_429" ? 429 : 400).json({ detail: e.message });
    }
  });

  app.get("/api/wattlab/strava/activities/:id", requireAuth, requireActiveMember, async (req, res) => {
    try {
      const out = await activityBundle(req.auth.member.id, req.params.id, {
        updatedAt: req.query.updatedAt ? String(req.query.updatedAt) : undefined,
        movingTime: req.query.movingTime ? Number(req.query.movingTime) : undefined,
      });
      res.json(out);
    } catch (e) {
      res.status(400).json({ detail: e.message });
    }
  });

  app.get("/api/wattlab/strava/athlete", requireAuth, requireActiveMember, async (req, res) => {
    try {
      res.json(await athleteProfile(req.auth.member.id, { force: req.query.force === "1" }));
    } catch (e) {
      res.status(400).json({ detail: e.message });
    }
  });

  app.post("/api/wattlab/strava/synced", requireAuth, requireActiveMember, (req, res) => {
    syncStamp.set(String(req.auth.member.id), {
      at: new Date().toISOString(),
      imported: Number(req.body?.imported ?? 0),
    });
    res.json(connectedStatus(req.auth.member.id));
  });

  app.post("/api/wattlab/strava/invalidate", requireAuth, requireActiveMember, (req, res) => {
    invalidateLists(req.auth.member.id);
    res.json({ ok: true });
  });

  app.get("/api/wattlab/strava/changes", requireAuth, requireActiveMember, (req, res) => {
    const st = connectedStatus(req.auth.member.id);
    const at = st.athleteId ? takeChanges(st.athleteId) : null;
    res.json({ pending: Boolean(at), at });
  });

  app.get("/api/wattlab/strava/webhook", (req, res) => {
    const token = process.env.STRAVA_WEBHOOK_VERIFY_TOKEN;
    if (token && req.query["hub.verify_token"] === token) {
      res.json({ "hub.challenge": req.query["hub.challenge"] });
      return;
    }
    res.status(403).json({ detail: "verify token" });
  });

  app.post("/api/wattlab/strava/webhook", (req, res) => {
    const owner = req.body?.owner_id;
    if (owner) {
      markChanges(owner);
      const memberId = memberIdForAthlete(owner);
      if (memberId) invalidateLists(memberId);
    }
    res.status(200).json({ ok: true });
  });

  app.post(
    "/api/wattlab/strava/upload",
    requireAuth,
    requireActiveMember,
    async (req, res) => {
      const memberId = req.auth.member.id;
      const fitBase64 = String(req.body?.fitBase64 ?? "");
      const name = String(req.body?.name ?? "WattLab indoor").slice(0, 80);
      const description = req.body?.description
        ? String(req.body.description).slice(0, 1000)
        : undefined;

      if (!fitBase64) {
        res.status(400).json({ detail: "fitBase64 obbligatorio." });
        return;
      }

      if (!connectedStatus(memberId).connected) {
        res.status(400).json({ detail: "Collega Strava dal profilo WattLab." });
        return;
      }

      try {
        const accessToken = await getValidAccessToken(memberId);
        const binary = Buffer.from(fitBase64, "base64");
        const form = new FormData();
        form.append(
          "file",
          new Blob([binary], { type: "application/octet-stream" }),
          "wattlab.fit",
        );
        form.append("data_type", "fit");
        form.append("name", name);
        form.append("trainer", "1");
        if (description) form.append("description", description);

        const uploadRes = await fetch(`${STRAVA_API}/uploads`, {
          method: "POST",
          headers: { Authorization: `Bearer ${accessToken}` },
          body: form,
        });

        if (!uploadRes.ok) {
          const detail = await uploadRes.text();
          res.status(502).json({
            detail: `Upload Strava fallito: ${detail.slice(0, 280)}`,
          });
          return;
        }

        const upload = await uploadRes.json();
        const uploadId = upload.id;
        if (!uploadId) {
          res.status(502).json({ detail: "Risposta upload Strava non valida." });
          return;
        }

        const deadline = Date.now() + 120_000;
        while (Date.now() < deadline) {
          const statusRes = await fetch(`${STRAVA_API}/uploads/${uploadId}`, {
            headers: { Authorization: `Bearer ${accessToken}` },
          });
          if (!statusRes.ok) {
            const detail = await statusRes.text();
            res.status(502).json({
              detail: `Stato upload Strava: ${detail.slice(0, 280)}`,
            });
            return;
          }
          const status = await statusRes.json();
          if (status.error) {
            res.status(502).json({ detail: String(status.error) });
            return;
          }
          if (status.activity_id) {
            res.json({ activityId: status.activity_id, uploadId });
            return;
          }
          await sleep(2000);
        }

        res.status(504).json({
          detail: "Upload Strava in elaborazione. Controlla Strava tra qualche minuto.",
          uploadId,
        });
      } catch (e) {
        res.status(500).json({ detail: e.message ?? "Upload Strava non riuscito." });
      }
    },
  );
}
