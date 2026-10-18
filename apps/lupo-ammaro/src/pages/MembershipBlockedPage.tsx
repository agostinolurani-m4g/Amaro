import { openDownloadPortal } from "../lib/amaroAuth";
import "../styles/login.css";

interface MembershipBlockedPageProps {
  message: string;
  onBackToLogin: () => void;
}

export function MembershipBlockedPage({
  message,
  onBackToLogin,
}: MembershipBlockedPageProps) {
  return (
    <div className="login-shell">
      <section className="page login-page">
        <header className="hero hero--compact">
          <h1>Tessera non attiva</h1>
          <p className="hero__copy">{message}</p>
        </header>

        <div className="form-panel login-form">
          <p className="muted-copy">
            Quando la quota è in regola, torna qui e accedi di nuovo.
          </p>
          <button type="button" className="btn btn--primary" onClick={onBackToLogin}>
            Torna al login
          </button>
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => void openDownloadPortal()}
          >
            Area tesserati
          </button>
        </div>
      </section>
    </div>
  );
}
