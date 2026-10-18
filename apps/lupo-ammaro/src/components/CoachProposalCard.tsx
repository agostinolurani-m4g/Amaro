import type { CoachProposal } from "../types";

interface Props {
  proposal: CoachProposal;
  busy?: boolean;
  onApply: () => void;
  onDismiss: () => void;
}

export function CoachProposalCard({ proposal, busy, onApply, onDismiss }: Props) {
  return (
    <div className="proposal-card">
      <p className="eyebrow">Proposta coach</p>
      <h3>{proposal.title}</h3>
      <p className="muted-copy">{proposal.reason}</p>
      <div className="proposal-card__actions">
        <button type="button" className="btn btn--primary btn--small" disabled={busy} onClick={onApply}>
          Applica
        </button>
        <button type="button" className="btn btn--ghost btn--small" disabled={busy} onClick={onDismiss}>
          Lascia
        </button>
      </div>
    </div>
  );
}
