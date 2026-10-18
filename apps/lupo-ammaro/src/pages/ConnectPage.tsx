import { useState } from "react";
import {
  connectTrainer,
  disconnectTrainer,
  startScan,
  stopScan,
} from "../hooks/useBle";
import type { ConnectionState, ScanResult } from "../types";

interface ConnectPageProps {
  scanResults: ScanResult[];
  connection: ConnectionState;
  onConnected: () => void;
  onClearScan: () => void;
}

export function ConnectPage({
  scanResults,
  connection,
  onConnected,
  onClearScan,
}: ConnectPageProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleScan() {
    setError(null);
    onClearScan();
    setBusy(true);
    try {
      await startScan();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg.replace(/^error,\s*/i, ""));
    } finally {
      setBusy(false);
    }
  }

  async function handleStopScan() {
    setBusy(true);
    try {
      await stopScan();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg.replace(/^error,\s*/i, ""));
    } finally {
      setBusy(false);
    }
  }

  async function handleConnect(deviceId: string) {
    setError(null);
    setBusy(true);
    try {
      await connectTrainer(deviceId);
      onConnected();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg.replace(/^error,\s*/i, ""));
    } finally {
      setBusy(false);
    }
  }

  async function handleDisconnect() {
    setBusy(true);
    try {
      await disconnectTrainer();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg.replace(/^error,\s*/i, ""));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="page connect-page">
      <header className="hero">
        <p className="eyebrow">Bluetooth</p>
        <h1>Collega il rullo</h1>
        <p className="hero__copy">
          Collega un rullo FTMS via Bluetooth, controlla la potenza in live e
          registra la sessione.
        </p>
      </header>

      <div className="connect-panel">
        <div className="connect-panel__actions">
          {connection.status !== "connected" ? (
            <>
              <button
                type="button"
                className="btn btn--primary"
                disabled={busy || connection.status === "scanning"}
                onClick={() => void handleScan()}
              >
                {connection.status === "scanning" ? "Scansione..." : "Cerca rulli"}
              </button>
              {connection.status === "scanning" && (
                <button
                  type="button"
                  className="btn btn--ghost"
                  disabled={busy}
                  onClick={() => void handleStopScan()}
                >
                  Stop scan
                </button>
              )}
            </>
          ) : (
            <>
              <p className="connected-label">
                Connesso a <strong>{connection.deviceName}</strong>
              </p>
              <button
                type="button"
                className="btn btn--ghost"
                disabled={busy}
                onClick={() => void handleDisconnect()}
              >
                Disconnetti
              </button>
              <button type="button" className="btn btn--primary" onClick={onConnected}>
                Vai alla sessione live
              </button>
            </>
          )}
        </div>

        {(error || connection.error) && (
          <p className="error-banner">{error || connection.error}</p>
        )}

        {connection.status === "connecting" && (
          <p className="connect-hint">
            Connessione in corso… Pedala sul rullo per tenerlo sveglio via Bluetooth.
          </p>
        )}

        {connection.status !== "connected" && (
          <ul className="device-list">
            {scanResults.length === 0 && connection.status === "scanning" && (
              <li className="device-list__empty">Cerco dispositivi FTMS...</li>
            )}
            {scanResults.map((device) => (
              <li key={device.id} className="device-item">
                <div>
                  <strong>{device.name}</strong>
                  <span>{device.hasFtms ? "FTMS" : "No FTMS"}</span>
                </div>
                <button
                  type="button"
                  className="btn btn--small"
                  disabled={busy || connection.status === "connecting"}
                  onClick={() => void handleConnect(device.id)}
                >
                  Connetti
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
