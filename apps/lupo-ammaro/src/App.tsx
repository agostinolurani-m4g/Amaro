import { useEffect, useState } from "react";
import { logout, restoreSession } from "./lib/amaroAuth";
import { getLastSessionSamples } from "./hooks/useBle";
import { MembershipBlockedPage } from "./pages/MembershipBlockedPage";
import { useBleEvents } from "./hooks/useBle";
import { buildCoachContext, fetchCoachComment } from "./hooks/useCoach";
import {
  getPersonalRecords,
  getProfile,
  listCalendar,
  saveCalendarEntry,
  savePersonalRecords,
  saveProfile,
  todayIso,
} from "./hooks/useStorage";
import { applyPersonalRecords, computeSessionStats, emptyPersonalRecords } from "./lib/sessionStats";
import {
  evaluateSession,
  metricsFromPoints,
  plannedCompliance,
  pointsFromSamples,
  storageSeries,
  type EntryMetrics,
} from "./lib/sessionEvaluation";
import { loadAthleteProfile, loadCoachGoal, saveLastEval } from "./lib/coachStore";
import { ensureWeeklyReview } from "./lib/coachBriefing";
import { submitClubSession } from "./hooks/useLeaderboard";
import { AppNav } from "./components/AppNav";
import { ConnectPage } from "./pages/ConnectPage";
import { LiveRidePage } from "./pages/LiveRidePage";
import { LoginPage } from "./pages/LoginPage";
import { SessionEndPage } from "./pages/SessionEndPage";
import { ProfilePage } from "./pages/ProfilePage";
import { WorkoutBuilderPage } from "./pages/WorkoutBuilderPage";
import { CalendarPage } from "./pages/CalendarPage";
import { HistoryPage } from "./pages/HistoryPage";
import { LabPage } from "./pages/LabPage";
import { LeaderboardPage } from "./pages/LeaderboardPage";
import { CoachPage } from "./pages/CoachPage";
import { FitPage } from "./pages/FitPage";
import { TodayPage } from "./pages/TodayPage";
import { MobileCalendarPage } from "./pages/MobileCalendarPage";
import { useMobileShell } from "./hooks/useMobileShell";
import { pullMemberSync } from "./lib/syncClient";
import { isTauri } from "./lib/runtime";
import type {
  AuthSession,
  CalendarEntry,
  PersonalRecordHit,
  Screen,
  SessionSeriesPoint,
  SessionStats,
  SessionSummary,
  SessionEvaluation,
  UserProfile,
  Workout,
} from "./types";
import "./styles/global.css";
import "./styles/training.css";
import "./styles/login.css";

function App() {
  const mobileShell = useMobileShell();
  const { scanResults, connection, telemetry, setScanResults } = useBleEvents();
  const [auth, setAuth] = useState<AuthSession | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [membershipError, setMembershipError] = useState<string | null>(null);
  const [screen, setScreen] = useState<Screen>(() =>
    typeof window !== "undefined" &&
    window.matchMedia("(max-width: 720px)").matches &&
    !isTauri()
      ? "today"
      : "connect",
  );
  const [summary, setSummary] = useState<SessionSummary | null>(null);
  const [sessionStats, setSessionStats] = useState<SessionStats | null>(null);
  const [newRecords, setNewRecords] = useState<PersonalRecordHit[]>([]);
  const [profile, setProfile] = useState<UserProfile>({
    name: "",
    heightCm: 175,
    weightKg: 70,
    ftpWatts: 200,
  });
  const [activeWorkout, setActiveWorkout] = useState<Workout | null>(null);
  const [sessionEval, setSessionEval] = useState<SessionEvaluation | null>(null);
  const [coachComment, setCoachComment] = useState<string | null>(null);
  const [coachCommentPending, setCoachCommentPending] = useState(false);
  const [lastSavedEntry, setLastSavedEntry] = useState<CalendarEntry | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const session = await restoreSession();
        setAuth(session);
      } finally {
        setAuthLoading(false);
      }
    })();
  }, []);

  useEffect(() => {
    if (!auth) return;
    void pullMemberSync().catch(() => undefined);
    if (!mobileShell || isTauri()) {
      void ensureWeeklyReview().catch(() => undefined);
      void import("./lib/stravaSync").then((m) => m.maybeAutoSync()).catch(() => undefined);
    }
  }, [auth, mobileShell]);

  useEffect(() => {
    if (!auth || !mobileShell || isTauri()) return;
    if (screen === "connect" || screen === "workouts" || screen === "history") {
      setScreen("today");
    }
  }, [auth, mobileShell, screen]);

  useEffect(() => {
    if (!auth) return;
    void getProfile().then((stored) => {
      const fullName = `${auth.member.firstName} ${auth.member.lastName}`.trim();
      if (!stored.name && fullName) {
        const next = { ...stored, name: fullName };
        setProfile(next);
        void saveProfile(next);
        return;
      }
      setProfile(stored);
    });
  }, [auth]);

  async function handleLogin(session: AuthSession) {
    setMembershipError(null);
    setAuth(session);
    const fullName = `${session.member.firstName} ${session.member.lastName}`.trim();
    if (fullName) {
      const stored = await getProfile();
      if (!stored.name) {
        const next = { ...stored, name: fullName };
        setProfile(next);
        await saveProfile(next);
      }
    }
  }

  async function handleLogout() {
    await logout();
    setAuth(null);
    setScreen("connect");
  }

  async function handleSessionEnd(s: SessionSummary) {
    setSummary(s);
    setSessionStats(null);
    setNewRecords([]);
    setSessionEval(null);
    setCoachComment(null);
    setCoachCommentPending(false);
    setLastSavedEntry(null);
    setScreen("summary");
    let series: SessionSeriesPoint[] | undefined;
    let stats: SessionStats | null = null;
    let evaluation: SessionEvaluation | null = null;
    let metrics: EntryMetrics | null = null;
    const today = todayIso();
    const calendarBefore = await listCalendar().catch(() => []);
    const plannedToday =
      calendarBefore.find(
        (e) =>
          e.entryType === "planned" &&
          e.date === today &&
          (!!activeWorkout?.id && e.workoutId === activeWorkout.id),
      ) ?? calendarBefore.find((e) => e.entryType === "planned" && e.date === today);
    try {
      const samples = await getLastSessionSamples();
      const points = pointsFromSamples(samples);
      metrics = metricsFromPoints(points, profile);
      const downsampled = storageSeries(points);
      if (downsampled.length > 0) series = downsampled;
      stats = computeSessionStats(samples, s);
      setSessionStats(stats);
      const stored = await getPersonalRecords().catch(() => emptyPersonalRecords());
      const { records, hits } = applyPersonalRecords(stored, stats);
      setNewRecords(hits);
      await savePersonalRecords(records);
      await submitClubSession(stats, activeWorkout?.name ?? "Sessione libera").catch(
        () => undefined,
      );
      evaluation = evaluateSession({
        title: activeWorkout?.name ?? "Sessione libera",
        samples,
        stats,
        ftp: profile.ftpWatts,
        profile,
        workout: activeWorkout,
        plannedTss: plannedToday?.plannedTss,
      });
      setSessionEval(evaluation);
      saveLastEval(evaluation);
    } catch {
      // non-blocking
    }
    try {
      const done = {
        durationSecs: metrics?.durationSecs ?? s.durationSecs,
        tss: metrics?.tss,
      };
      const saved = await saveCalendarEntry({
        id: "",
        date: today,
        entryType: "completed",
        title: activeWorkout?.name ?? "Sessione libera",
        workoutId: activeWorkout?.id,
        ...metrics,
        durationSecs: done.durationSecs,
        avgPower: metrics?.avgPower ?? s.avgPower,
        maxPower: metrics?.maxPower ?? s.maxPower,
        distanceM: stats?.distanceM,
        series,
        plannedEntryId: plannedToday?.id,
        plannedTss: plannedToday?.plannedTss,
        sessionType: plannedToday?.sessionType,
        compliance: plannedCompliance(done, plannedToday),
      });
      setLastSavedEntry(saved);

      setCoachCommentPending(true);
      void (async () => {
        try {
          const goal = loadCoachGoal();
          const context = await buildCoachContext(goal);
          const planned = plannedToday;
          const { comment } = await fetchCoachComment({
            context,
            session: {
              id: saved.id,
              date: saved.date,
              title: saved.title,
              durationSecs: saved.durationSecs,
              avgPower: saved.avgPower,
              maxPower: saved.maxPower,
              np: saved.np,
              tss: saved.tss,
              ifactor: saved.ifactor,
              kj: saved.kj,
              avgHr: saved.avgHr,
              decoupling: saved.decoupling,
              compliance: saved.compliance,
            },
            planned: planned
              ? {
                  id: planned.id,
                  date: planned.date,
                  title: planned.title,
                  entryType: planned.entryType,
                  durationSecs: planned.durationSecs,
                  avgPower: planned.avgPower,
                  hasSeries: false,
                  plannedTss: planned.plannedTss,
                  sessionType: planned.sessionType,
                  notes: planned.notes,
                }
              : null,
            evaluation,
            athleteProfile: loadAthleteProfile(),
          });
          setCoachComment(comment);
          const latest = (await listCalendar().catch(() => [])).find((e) => e.id === saved.id);
          const next = { ...(latest ?? saved), coachComment: comment };
          await saveCalendarEntry(next);
          setLastSavedEntry(next);
        } catch {
          // rules eval only
        } finally {
          setCoachCommentPending(false);
        }
      })();
    } catch {
      // non-blocking
    }
  }

  async function handleSessionFeedback(rpe: number, feel: string) {
    if (!lastSavedEntry) return;
    const latest = (await listCalendar().catch(() => [])).find((e) => e.id === lastSavedEntry.id);
    const next = { ...(latest ?? lastSavedEntry), rpe, feel: feel || undefined };
    await saveCalendarEntry(next);
    setLastSavedEntry(next);
  }

  if (authLoading) {
    return (
      <div className="login-shell">
        <section className="page login-page">
          <p className="muted-copy">Caricamento...</p>
        </section>
      </div>
    );
  }

  if (!auth) {
    if (membershipError) {
      return (
        <MembershipBlockedPage
          message={membershipError}
          onBackToLogin={() => setMembershipError(null)}
        />
      );
    }

    return (
      <LoginPage
        onLogin={(session) => void handleLogin(session)}
        onMembershipBlocked={(message) => setMembershipError(message)}
      />
    );
  }

  const navScreen: Screen =
    screen === "live" || screen === "summary" ? "connect" : screen;

  return (
    <div className={`app-shell${mobileShell ? " app-shell--mobile" : ""}`}>
      <AppNav
        current={navScreen}
        connected={connection.status === "connected"}
        mobile={mobileShell}
        onNavigate={(next) => {
          if (next === "live" && connection.status === "connected") {
            setScreen("live");
          } else if (next !== "live") {
            setScreen(next);
          }
        }}
      />

      <main className="app-main">
        {screen === "connect" && (
          <ConnectPage
            scanResults={scanResults}
            connection={connection}
            onClearScan={() => setScanResults([])}
            onConnected={() => setScreen("live")}
          />
        )}

        {screen === "live" && (
          <LiveRidePage
            connection={connection}
            telemetry={telemetry}
            profile={profile}
            activeWorkout={activeWorkout}
            onClearWorkout={() => setActiveWorkout(null)}
            onBack={() => setScreen("connect")}
            onSessionEnd={(s) => void handleSessionEnd(s)}
          />
        )}

        {screen === "summary" && summary && (
          <SessionEndPage
            summary={summary}
            stats={sessionStats}
            records={newRecords}
            evaluation={sessionEval}
            coachComment={coachComment}
            coachCommentPending={coachCommentPending}
            savedEntry={lastSavedEntry}
            onSaveFeedback={handleSessionFeedback}
            onOpenLeaderboard={() => setScreen("leaderboard")}
            onDone={() => {
              setSummary(null);
              setSessionStats(null);
              setNewRecords([]);
              setSessionEval(null);
              setCoachComment(null);
              setCoachCommentPending(false);
              setScreen(connection.status === "connected" ? "live" : "connect");
            }}
          />
        )}

        {screen === "profile" && (
          <ProfilePage member={auth.member} onLogout={() => void handleLogout()} />
        )}

        {screen === "workouts" && (
          <WorkoutBuilderPage
            onStartWorkout={(workout) => {
              setActiveWorkout(workout);
              setScreen(connection.status === "connected" ? "live" : "connect");
            }}
          />
        )}

        {screen === "today" && <TodayPage />}

        {screen === "calendar" &&
          (mobileShell ? (
            <MobileCalendarPage />
          ) : (
            <CalendarPage
              onStartWorkout={(workout) => {
                setActiveWorkout(workout);
                setScreen(connection.status === "connected" ? "live" : "connect");
              }}
            />
          ))}

        {screen === "coach" && (
          <CoachPage
            compact={mobileShell}
            onOpenProfile={() => setScreen("profile")}
            onStartWorkout={(workout) => {
              setActiveWorkout(workout);
              setScreen(connection.status === "connected" ? "live" : "connect");
            }}
          />
        )}

        {screen === "history" && <HistoryPage />}

        {screen === "lab" && <LabPage />}

        {screen === "leaderboard" && <LeaderboardPage member={auth.member} />}

        {screen === "fit" && <FitPage heightCm={profile.heightCm} />}
      </main>
    </div>
  );
}

export default App;
