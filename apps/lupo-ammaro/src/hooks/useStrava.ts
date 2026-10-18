import { invoke } from "@tauri-apps/api/core";
import { AmaroAuthError, amaroJson } from "../lib/amaroAuth";

export interface StravaStatus {
  connected: boolean;
  configured: boolean;
  athleteId?: number | null;
  autoUpload: boolean;
  canRead?: boolean;
  lastSyncAt?: string | null;
  imported?: number | null;
}

export interface StravaUploadResult {
  activityId: number;
  uploadId: number;
}

interface AmaroStravaStatus {
  configured: boolean;
  connected: boolean;
  athleteId?: number | null;
  canRead?: boolean;
  lastSyncAt?: string | null;
  imported?: number | null;
}

interface LocalStravaStatus {
  autoUpload: boolean;
}

interface StravaFitPayload {
  fitBase64: string;
  name: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function localAutoUpload(): Promise<boolean> {
  try {
    const local = await invoke<LocalStravaStatus>("strava_get_status");
    return local.autoUpload;
  } catch {
    return false;
  }
}

export async function getStravaStatus(): Promise<StravaStatus> {
  const autoUpload = await localAutoUpload();
  try {
    const remote = await amaroJson<AmaroStravaStatus>("/api/wattlab/strava/status");
    return {
      configured: remote.configured,
      connected: remote.connected,
      athleteId: remote.athleteId,
      canRead: remote.canRead,
      lastSyncAt: remote.lastSyncAt,
      imported: remote.imported,
      autoUpload,
    };
  } catch (error) {
    if (error instanceof AmaroAuthError && error.status === 401) {
      throw new AmaroAuthError(
        "Sessione scaduta. Esci e accedi di nuovo, poi riprova Strava.",
        401,
      );
    }
    throw error;
  }
}

export async function connectStrava(): Promise<StravaStatus> {
  const { authorizeUrl } = await amaroJson<{ authorizeUrl: string }>(
    "/api/wattlab/strava/connect",
    { method: "POST" },
  );
  const { openUrl } = await import("@tauri-apps/plugin-opener");
  await openUrl(authorizeUrl);

  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    await sleep(1500);
    const status = await getStravaStatus();
    if (status.connected) return status;
  }
  throw new Error("Collegamento Strava non completato. Autorizza nel browser e riprova.");
}

export async function disconnectStrava(): Promise<StravaStatus> {
  const remote = await amaroJson<AmaroStravaStatus>("/api/wattlab/strava/disconnect", {
    method: "POST",
  });
  const autoUpload = await localAutoUpload();
  return {
    configured: remote.configured,
    connected: remote.connected,
    athleteId: remote.athleteId,
    autoUpload,
  };
}

export async function setStravaAutoUpload(enabled: boolean): Promise<StravaStatus> {
  await invoke<LocalStravaStatus>("strava_set_auto_upload", { enabled });
  return getStravaStatus();
}

export async function uploadLastSessionToStrava(options?: {
  description?: string;
}): Promise<StravaUploadResult> {
  const payload = await invoke<StravaFitPayload>("strava_last_session_fit");
  return amaroJson<StravaUploadResult>("/api/wattlab/strava/upload", {
    method: "POST",
    body: JSON.stringify({
      fitBase64: payload.fitBase64,
      name: payload.name,
      description: options?.description,
    }),
  });
}
