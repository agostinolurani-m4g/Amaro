import { FormEvent, useState } from "react";
import {
  AmaroAuthError,
  login,
  openDownloadPortal,
} from "../lib/amaroAuth";
import type { AuthSession } from "../types";
import "../styles/login.css";

interface LoginPageProps {
  onLogin: (session: AuthSession) => void;
  onMembershipBlocked?: (message: string) => void;
}

export function LoginPage({ onLogin, onMembershipBlocked }: LoginPageProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const session = await login(email.trim(), password);
      onLogin(session);
    } catch (e) {
      if (e instanceof AmaroAuthError) {
        if (e.status === 403 && onMembershipBlocked) {
          onMembershipBlocked(e.message);
        } else {
          setError(e.message);
        }
      } else {
        const detail = e instanceof Error && e.message ? e.message : "";
        setError(
          detail
            ? `Impossibile contattare il server Amaro (${detail}).`
            : "Impossibile contattare il server Amaro. Riprova più tardi.",
        );
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="login-shell">
      <section className="page login-page">
        <header className="hero hero--compact">
          <h1>Lupo Ammaro</h1>
          <p className="hero__copy">
            Entra con email e password dell&apos;area tesserati e pedala sul
            tuo smart trainer.
          </p>
        </header>

        <form className="form-panel login-form" onSubmit={(e) => void handleSubmit(e)}>
          <label className="form-row">
            <span>Email</span>
            <input
              type="email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="maria@esempio.com"
              required
            />
          </label>

          <label className="form-row">
            <span>Password area tesserati</span>
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </label>

          <button type="submit" className="btn btn--primary" disabled={loading}>
            {loading ? "Accesso in corso..." : "Entra"}
          </button>

          {error && <p className="error-banner">{error}</p>}
        </form>

        <div className="login-form login-form--footer">
          <p className="muted-copy">
            Non hai ancora Lupo Ammaro sul PC?
          </p>
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => void openDownloadPortal()}
          >
            Scarica dall&apos;area tesserati
          </button>
        </div>
      </section>
    </div>
  );
}
