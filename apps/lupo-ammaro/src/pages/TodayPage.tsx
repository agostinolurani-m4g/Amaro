import { useCallback, useEffect, useState } from "react";
import { DailyCheckinCard } from "../components/DailyCheckinCard";
import { CoachProposalCard } from "../components/CoachProposalCard";
import { listCalendar, todayIso } from "../hooks/useStorage";
import { saveCheckin, todayCheckin } from "../lib/athleteStore";
import { applyPlanPatch } from "../lib/coachBriefing";
import { computeCoachProposals } from "../lib/coachProposals";
import { loadSnapshotFromContext } from "../lib/sessionEvaluation";
import { buildCoachContext } from "../hooks/useCoach";
import { lifeBlocksForDate, listLifeBlocks } from "../lib/lifeBlockStore";
import type { CalendarEntry, CoachProposal, DailyCheckin, LifeBlock } from "../types";
import { SESSION_TYPE_META } from "../lib/sessionTypes";
import { readinessScore } from "../../shared/engine/planner.mjs";

export function TodayPage() {
  const today = todayIso();
  const [entries, setEntries] = useState<CalendarEntry[]>([]);
  const [lifeBlocks, setLifeBlocks] = useState<LifeBlock[]>([]);
  const [checkin, setCheckin] = useState<DailyCheckin | null>(null);
  const [proposal, setProposal] = useState<CoachProposal | null>(null);
  const [busy, setBusy] = useState(false);
  const [readiness, setReadiness] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    const [cal, blocks, cin] = await Promise.all([
      listCalendar().catch(() => []),
      listLifeBlocks(),
      todayCheckin(),
    ]);
    setEntries(cal);
    setLifeBlocks(blocks);
    setCheckin(cin);
    const ctx = await buildCoachContext().catch(() => null);
    const load = ctx ? loadSnapshotFromContext(ctx) : null;
    setReadiness(load ? readinessScore(cin, load.tsb) : null);
    const props = computeCoachProposals({
      calendar: cal,
      lifeBlocks: blocks,
      checkin: cin,
      load,
      today,
    });
    setProposal(props[0] ?? null);
  }, [today]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const planned = entries.find((e) => e.entryType === "planned" && e.date === today);
  const todayLife = lifeBlocksForDate(lifeBlocks, today);

  async function handleCheckin(next: DailyCheckin) {
    await saveCheckin(next);
    setCheckin(next);
    void refresh();
  }

  async function applyProposal() {
    if (!proposal) return;
    setBusy(true);
    try {
      await applyPlanPatch(proposal.planPatch, proposal.workouts ?? []);
      setProposal(null);
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="page mobile-page">
      <header className="mobile-page__header">
        <h1>Oggi</h1>
        <p className="muted-copy">{today}</p>
      </header>

      {proposal && (
        <CoachProposalCard
          proposal={proposal}
          busy={busy}
          onApply={() => void applyProposal()}
          onDismiss={() => setProposal(null)}
        />
      )}

      <div className="panel">
        <h3>Allenamento</h3>
        {planned ? (
          <>
            <p>
              <strong>{planned.title}</strong>
              {planned.sessionType && SESSION_TYPE_META[planned.sessionType as keyof typeof SESSION_TYPE_META]
                ? ` · ${SESSION_TYPE_META[planned.sessionType as keyof typeof SESSION_TYPE_META].label}`
                : ""}
            </p>
            {planned.plannedTss != null && <p className="muted-copy">TSS previsto {planned.plannedTss}</p>}
          </>
        ) : (
          <p className="muted-copy">Nessuna sessione pianificata. Chiedi al coach o controlla il calendario.</p>
        )}
      </div>

      {todayLife.length > 0 && (
        <div className="panel">
          <h3>Impegni</h3>
          <ul className="life-block-list">
            {todayLife.map((b) => (
              <li key={b.id}>
                {b.label}
                {b.kind === "window" ? " (fascia libera)" : ""}
              </li>
            ))}
          </ul>
        </div>
      )}

      <DailyCheckinCard
        date={today}
        initial={checkin}
        readiness={readiness}
        onSave={(c) => void handleCheckin(c)}
      />
    </section>
  );
}
