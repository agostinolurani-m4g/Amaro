import { useCallback, useEffect, useMemo, useState } from "react";
import { CoachProposalCard } from "../components/CoachProposalCard";
import { listCalendar, todayIso } from "../hooks/useStorage";
import { applyPlanPatch } from "../lib/coachBriefing";
import { proposalFromDayComment } from "../lib/coachProposals";
import { lifeBlocksForDate, listLifeBlocks, upsertLifeBlockFromMessage } from "../lib/lifeBlockStore";
import { addDaysIso } from "../../shared/engine/dates.mjs";
import type { CalendarEntry, CoachProposal, LifeBlock } from "../types";
import { SESSION_TYPE_META } from "../lib/sessionTypes";

export function MobileCalendarPage() {
  const today = todayIso();
  const [entries, setEntries] = useState<CalendarEntry[]>([]);
  const [lifeBlocks, setLifeBlocks] = useState<LifeBlock[]>([]);
  const [selected, setSelected] = useState(today);
  const [comment, setComment] = useState("");
  const [proposal, setProposal] = useState<CoachProposal | null>(null);
  const [busy, setBusy] = useState(false);

  const days = useMemo(() => {
    const out: string[] = [];
    for (let i = -3; i <= 10; i += 1) {
      out.push(addDaysIso(today, i));
    }
    return out;
  }, [today]);

  const refresh = useCallback(async () => {
    const [cal, blocks] = await Promise.all([listCalendar().catch(() => []), listLifeBlocks()]);
    setEntries(cal);
    setLifeBlocks(blocks);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const dayEntries = entries.filter((e) => e.date === selected);
  const planned = dayEntries.find((e) => e.entryType === "planned");
  const done = dayEntries.filter((e) => e.entryType !== "planned");
  const life = lifeBlocksForDate(lifeBlocks, selected);

  async function submitComment() {
    const text = comment.trim();
    if (!text) return;
    setBusy(true);
    try {
      await upsertLifeBlockFromMessage(text, { date: selected, source: "day_comment" });
      const prop =
        proposalFromDayComment(text, selected, entries, lifeBlocks) ??
        proposalFromDayComment(text, selected, await listCalendar(), await listLifeBlocks());
      setProposal(prop);
      setComment("");
      await refresh();
    } finally {
      setBusy(false);
    }
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
        <h1>Calendario</h1>
      </header>

      <div className="mobile-day-strip">
        {days.map((d) => {
          const hasPlan = entries.some((e) => e.entryType === "planned" && e.date === d);
          return (
            <button
              key={d}
              type="button"
              className={`mobile-day-chip${d === selected ? " mobile-day-chip--active" : ""}${d === today ? " mobile-day-chip--today" : ""}`}
              onClick={() => {
                setSelected(d);
                setProposal(null);
                setComment("");
              }}
            >
              <span>{d.slice(8)}</span>
              <span>{d.slice(5, 7)}</span>
              {hasPlan && <span className="mobile-day-chip__dot" />}
            </button>
          );
        })}
      </div>

      <div className="panel mobile-day-detail">
        <h2>{selected}</h2>
        {life.length > 0 && (
          <div className="life-block-list">
            {life.map((b) => (
              <p key={b.id} className="life-block-pill">
                {b.label}
              </p>
            ))}
          </div>
        )}
        {planned && (
          <div className="mobile-session-card">
            <p className="eyebrow">Pianificato</p>
            <strong>{planned.title}</strong>
            {planned.sessionType && (
              <p className="muted-copy">
                {SESSION_TYPE_META[planned.sessionType as keyof typeof SESSION_TYPE_META]?.label ?? planned.sessionType}
              </p>
            )}
          </div>
        )}
        {done.map((e) => (
          <div key={e.id} className="mobile-session-card mobile-session-card--done">
            <p className="eyebrow">{e.entryType === "completed" ? "Svolto" : "Importato"}</p>
            <strong>{e.title}</strong>
            {e.tss != null && <p className="muted-copy">TSS {e.tss}</p>}
          </div>
        ))}
        {!planned && done.length === 0 && <p className="muted-copy">Giornata libera.</p>}

        <label className="form-row">
          <span>Commento rapido</span>
          <input
            type="text"
            value={comment}
            placeholder="Es. sposta a domani · solo 45 min"
            onChange={(e) => setComment(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submitComment();
            }}
          />
        </label>
        <button type="button" className="btn btn--primary btn--small" disabled={busy || !comment.trim()} onClick={() => void submitComment()}>
          Invia
        </button>

        {proposal && (
          <CoachProposalCard
            proposal={proposal}
            busy={busy}
            onApply={() => void applyProposal()}
            onDismiss={() => setProposal(null)}
          />
        )}
      </div>
    </section>
  );
}
