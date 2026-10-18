import cors from "cors";
import express from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chatWithCoach, coachAdjustPlan, coachBatchComments, coachSessionComment, coachWeeklyReview } from "./coach.mjs";
import { llmHealth } from "./llm.mjs";
import { searchWeb } from "./webSearch.mjs";
import { mountStravaRoutes } from "./strava.mjs";
import {
  createToken,
  isActiveMembership,
  publicMember,
  revokeToken,
  verifyToken,
} from "./auth.mjs";
import { getMemberSync, mergeMemberSync } from "./syncStore.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const raw of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

loadEnvFile(path.join(__dirname, ".env"));

const PORT = Number(process.env.PORT ?? 8000);
const RELEASES_DIR = path.resolve(
  process.env.WATTLAB_RELEASES_DIR ?? path.join(__dirname, "releases"),
);
const INSTALLER_FILENAME =
  process.env.WATTLAB_INSTALLER ?? "WattLab_0.1.1_x64-setup.exe";
const APP_VERSION = process.env.WATTLAB_VERSION ?? "0.1.1";

/** @type {{ id: number, email: string, password: string, firstName: string, lastName: string, membershipStatus: string }[]} */
const members = JSON.parse(
  fs.readFileSync(path.join(__dirname, "members.json"), "utf8"),
);

const app = express();
app.use(cors());
app.use(express.json({ limit: "20mb" }));

function findMemberByEmail(email) {
  return members.find(
    (member) => member.email.toLowerCase() === email.trim().toLowerCase(),
  );
}

function findMemberById(id) {
  return members.find((member) => member.id === id);
}

function bearerToken(req) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length).trim();
}

function requireAuth(req, res, next) {
  const token = bearerToken(req);
  if (!token) {
    res.status(401).json({ detail: "Accesso non autorizzato." });
    return;
  }

  const session = verifyToken(token);
  if (!session) {
    res.status(401).json({ detail: "Sessione scaduta. Accedi di nuovo." });
    return;
  }

  const member = findMemberById(session.memberId);
  if (!member) {
    res.status(401).json({ detail: "Tesserato non trovato." });
    return;
  }

  req.auth = { token, member };
  next();
}

function requireActiveMember(req, res, next) {
  if (!isActiveMembership(req.auth.member.membershipStatus)) {
    res.status(403).json({
      detail: "Tessera non attiva. Rinnova la quota per accedere a WattLab.",
    });
    return;
  }
  next();
}

function installerPath() {
  return path.join(RELEASES_DIR, INSTALLER_FILENAME);
}

function installerInfo() {
  const filePath = installerPath();
  const available = fs.existsSync(filePath);
  return {
    version: APP_VERSION,
    platform: "windows",
    filename: INSTALLER_FILENAME,
    sizeBytes: available ? fs.statSync(filePath).size : 0,
    available,
  };
}

app.post("/api/wattlab/login", (req, res) => {
  const email = String(req.body?.email ?? "");
  const password = String(req.body?.password ?? "");

  if (!email || !password) {
    res.status(400).json({ detail: "Email e password obbligatorie." });
    return;
  }

  const member = findMemberByEmail(email);
  if (!member || member.password !== password) {
    res.status(401).json({ detail: "Credenziali non valide." });
    return;
  }

  if (!isActiveMembership(member.membershipStatus)) {
    res.status(403).json({
      detail: "Tessera non attiva. Rinnova la quota per accedere a WattLab.",
    });
    return;
  }

  const { token, expiresAt } = createToken(member);
  res.json({
    token,
    expiresAt,
    member: publicMember(member),
  });
});

app.get("/api/wattlab/me", requireAuth, (req, res) => {
  if (!isActiveMembership(req.auth.member.membershipStatus)) {
    res.status(403).json({
      detail: "Tessera non attiva. Rinnova la quota per accedere a WattLab.",
    });
    return;
  }

  res.json({ member: publicMember(req.auth.member) });
});

app.post("/api/wattlab/logout", requireAuth, (req, res) => {
  revokeToken(req.auth.token);
  res.json({ ok: true });
});

app.get(
  "/api/wattlab/download/info",
  requireAuth,
  requireActiveMember,
  (_req, res) => {
    res.json(installerInfo());
  },
);

app.get(
  "/api/wattlab/download/windows",
  requireAuth,
  requireActiveMember,
  (_req, res) => {
    const filePath = installerPath();
    if (!fs.existsSync(filePath)) {
      res.status(503).json({
        detail:
          "Installer non ancora disponibile. Contatta la segreteria Amaro.",
      });
      return;
    }

    res.download(filePath, INSTALLER_FILENAME);
  },
);

const SESSIONS_PATH = path.join(__dirname, "sessions.json");

function loadSessions() {
  if (!fs.existsSync(SESSIONS_PATH)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(SESSIONS_PATH, "utf8"));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function saveSessions(sessions) {
  fs.writeFileSync(SESSIONS_PATH, JSON.stringify(sessions, null, 2), "utf8");
}

function periodCutoffMs(period) {
  const now = Date.now();
  if (period === "week") return now - 7 * 24 * 60 * 60 * 1000;
  if (period === "month") return now - 30 * 24 * 60 * 60 * 1000;
  return 0;
}

app.post(
  "/api/wattlab/sessions",
  requireAuth,
  requireActiveMember,
  (req, res) => {
    const durationSecs = Math.max(0, Number(req.body?.durationSecs ?? 0));
    const distanceM = Math.max(0, Number(req.body?.distanceM ?? 0));
    const workKj = Math.max(0, Number(req.body?.workKj ?? 0));
    const avgPower =
      req.body?.avgPower == null ? undefined : Number(req.body.avgPower);
    const maxPower =
      req.body?.maxPower == null ? undefined : Number(req.body.maxPower);
    const title = String(req.body?.title ?? "Sessione").slice(0, 120);
    const bests = Array.isArray(req.body?.bests)
      ? req.body.bests
          .map((best) => ({
            windowSecs: Number(best?.windowSecs),
            watts: Number(best?.watts),
          }))
          .filter(
            (best) =>
              Number.isFinite(best.windowSecs) &&
              Number.isFinite(best.watts) &&
              best.windowSecs > 0 &&
              best.watts >= 0,
          )
      : [];

    const sessions = loadSessions();
    const entry = {
      id: crypto.randomUUID(),
      memberId: req.auth.member.id,
      submittedAt: new Date().toISOString(),
      title,
      durationSecs,
      distanceM,
      workKj,
      avgPower: Number.isFinite(avgPower) ? avgPower : undefined,
      maxPower: Number.isFinite(maxPower) ? maxPower : undefined,
      bests,
    };
    sessions.push(entry);
    saveSessions(sessions);
    res.json({ ok: true, id: entry.id });
  },
);

app.get(
  "/api/wattlab/leaderboard",
  requireAuth,
  requireActiveMember,
  (req, res) => {
    const periodRaw = String(req.query.period ?? "month");
    const period = ["week", "month", "all"].includes(periodRaw)
      ? periodRaw
      : "month";
    const cutoff = periodCutoffMs(period);
    const sessions = loadSessions().filter((session) => {
      const at = Date.parse(session.submittedAt ?? "");
      return Number.isFinite(at) && at >= cutoff;
    });

    /** @type {Map<number, { memberId: number, firstName: string, lastName: string, sessions: number, durationSecs: number, distanceM: number, workKj: number, maxPower?: number, best20min?: number }>} */
    const byMember = new Map();

    for (const session of sessions) {
      const member = findMemberById(session.memberId);
      if (!member || !isActiveMembership(member.membershipStatus)) continue;

      const row = byMember.get(member.id) ?? {
        memberId: member.id,
        firstName: member.firstName,
        lastName: member.lastName,
        sessions: 0,
        durationSecs: 0,
        distanceM: 0,
        workKj: 0,
        maxPower: undefined,
        best20min: undefined,
      };

      row.sessions += 1;
      row.durationSecs += Number(session.durationSecs ?? 0);
      row.distanceM += Number(session.distanceM ?? 0);
      row.workKj += Number(session.workKj ?? 0);
      if (session.maxPower != null) {
        row.maxPower = Math.max(row.maxPower ?? 0, Number(session.maxPower));
      }
      const best20 = (session.bests ?? []).find((best) => best.windowSecs === 1200);
      if (best20?.watts != null) {
        row.best20min = Math.max(row.best20min ?? 0, Number(best20.watts));
      }
      byMember.set(member.id, row);
    }

    const entries = [...byMember.values()].sort((a, b) => b.distanceM - a.distanceM);
    res.json({ period, entries });
  },
);

app.get(
  "/api/wattlab/sync",
  requireAuth,
  requireActiveMember,
  (req, res) => {
    res.json(getMemberSync(req.auth.member.id));
  },
);

app.put(
  "/api/wattlab/sync",
  requireAuth,
  requireActiveMember,
  (req, res) => {
    try {
      const body = req.body ?? {};
      const merged = mergeMemberSync(req.auth.member.id, {
        calendar: Array.isArray(body.calendar) ? body.calendar : undefined,
        lifeBlocks: Array.isArray(body.lifeBlocks) ? body.lifeBlocks : undefined,
        chat: Array.isArray(body.chat) ? body.chat : undefined,
        checkins: Array.isArray(body.checkins) ? body.checkins : undefined,
        athleteSettings: body.athleteSettings ?? undefined,
        profile: body.profile ?? undefined,
        workouts: Array.isArray(body.workouts) ? body.workouts : undefined,
      });
      res.json(merged);
    } catch (error) {
      res.status(500).json({ detail: error.message ?? "Sync non riuscita." });
    }
  },
);

app.get("/api/wattlab/coach/health", requireAuth, async (_req, res) => {
  res.json(await llmHealth());
});

app.post(
  "/api/wattlab/coach/chat/stream",
  requireAuth,
  requireActiveMember,
  async (req, res) => {
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();
    const beat = setInterval(() => {
      if (!res.writableEnded) res.write(": ping\n\n");
    }, 15000);
    const emit = (event) => {
      if (!res.writableEnded) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    };
    req.on("close", () => clearInterval(beat));
    try {
      const result = await chatWithCoach({
        message: String(req.body?.message ?? ""),
        history: Array.isArray(req.body?.history) ? req.body.history : [],
        context: req.body?.context ?? {},
        directIntent: req.body?.directIntent ? String(req.body.directIntent) : undefined,
        memberId: req.auth.member.id,
        emit,
      });
      emit({ type: "done", response: result });
    } catch (error) {
      emit({ type: "error", message: error.message ?? "Coach non disponibile." });
    } finally {
      clearInterval(beat);
      res.end();
    }
  },
);

app.post(
  "/api/wattlab/coach/chat",
  requireAuth,
  requireActiveMember,
  async (req, res) => {
    try {
      const result = await chatWithCoach({
        message: String(req.body?.message ?? ""),
        history: Array.isArray(req.body?.history) ? req.body.history : [],
        context: req.body?.context ?? {},
        directIntent: req.body?.directIntent ? String(req.body.directIntent) : undefined,
        memberId: req.auth.member.id,
      });
      res.json(result);
    } catch (error) {
      const status = Number(error.status ?? 500);
      res.status(status).json({
        detail: error.message ?? "Coach non disponibile.",
      });
    }
  },
);

app.post(
  "/api/wattlab/coach/comment",
  requireAuth,
  requireActiveMember,
  async (req, res) => {
    try {
      const result = await coachSessionComment({
        context: req.body?.context ?? {},
        session: req.body?.session ?? {},
        planned: req.body?.planned ?? null,
        evaluation: req.body?.evaluation ?? null,
        athleteProfile: req.body?.athleteProfile ?? null,
      });
      res.json(result);
    } catch (error) {
      const status = Number(error.status ?? 500);
      res.status(status).json({ detail: error.message ?? "Commento coach non disponibile." });
    }
  },
);

app.post(
  "/api/wattlab/coach/weekly",
  requireAuth,
  requireActiveMember,
  async (req, res) => {
    try {
      const result = await coachWeeklyReview({
        context: req.body?.context ?? {},
        constraints: Array.isArray(req.body?.constraints) ? req.body.constraints : [],
      });
      res.json(result);
    } catch (error) {
      const status = Number(error.status ?? 500);
      res.status(status).json({ detail: error.message ?? "Revisione settimanale non disponibile." });
    }
  },
);

app.post(
  "/api/wattlab/coach/adjust",
  requireAuth,
  requireActiveMember,
  async (req, res) => {
    try {
      const result = await coachAdjustPlan({
        message: String(req.body?.message ?? ""),
        context: req.body?.context ?? {},
        constraints: Array.isArray(req.body?.constraints) ? req.body.constraints : [],
      });
      res.json(result);
    } catch (error) {
      const status = Number(error.status ?? 500);
      res.status(status).json({ detail: error.message ?? "Aggiornamento piano non disponibile." });
    }
  },
);

app.post(
  "/api/wattlab/coach/batch-comments",
  requireAuth,
  requireActiveMember,
  async (req, res) => {
    try {
      const result = await coachBatchComments({
        context: req.body?.context ?? {},
        sessions: Array.isArray(req.body?.sessions) ? req.body.sessions : [],
        athleteProfile: req.body?.athleteProfile ?? null,
      });
      res.json(result);
    } catch (error) {
      const status = Number(error.status ?? 500);
      res.status(status).json({ detail: error.message ?? "Commenti batch non disponibili." });
    }
  },
);

mountStravaRoutes(app, { requireAuth, requireActiveMember });

app.post(
  "/api/wattlab/coach/docs",
  requireAuth,
  requireActiveMember,
  async (req, res) => {
    try {
      const query = String(req.body?.query ?? req.body?.goal ?? "").trim();
      if (!query) {
        res.json({ query: "", results: [] });
        return;
      }
      const result = await searchWeb(query);
      res.json({
        query,
        results: result.results ?? [],
        error: result.ok ? undefined : result.error,
      });
    } catch (error) {
      res.status(200).json({
        query: String(req.body?.query ?? ""),
        results: [],
        error: error.message ?? "Ricerca non disponibile.",
      });
    }
  },
);

app.use(
  "/tesserati/wattlab",
  express.static(path.join(__dirname, "public"), { index: "index.html" }),
);

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "wattlab-amaro-api" });
});

const server = app.listen(PORT, "0.0.0.0", (listenError) => {
  if (listenError) return;
  const stravaReady = Boolean(
    process.env.STRAVA_CLIENT_ID && process.env.STRAVA_CLIENT_SECRET,
  );
  console.log(`Amaro WattLab API listening on http://127.0.0.1:${PORT}`);
  console.log(
    `Download portal: http://127.0.0.1:${PORT}/tesserati/wattlab/`,
  );
  console.log(
    stravaReady
      ? "Strava: configurato (client id presente)."
      : "Strava: NON configurato. Imposta STRAVA_CLIENT_ID e STRAVA_CLIENT_SECRET in server/.env e riavvia.",
  );
  const info = installerInfo();
  if (!info.available) {
    console.warn(
      `Installer missing at ${installerPath()} — run npm run release:copy after tauri:build`,
    );
  }
});

server.on("error", (error) => {
  if (error?.code === "EADDRINUSE") {
    console.error(
      `Porta ${PORT} già in uso. Un WattLab precedente è ancora acceso: chiudi quel processo (Gestione attività → node.exe) oppure esegui: Get-NetTCPConnection -LocalPort ${PORT} | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }`,
    );
  } else {
    console.error(error);
  }
  process.exit(1);
});
