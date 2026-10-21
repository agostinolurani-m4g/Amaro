import { clearAuth, getAuth, saveAuth } from "../hooks/useStorage";
import { isTauri } from "./runtime";
import type { AmaroMember, AuthSession } from "../types";

const configuredApiUrl =
  import.meta.env.VITE_AMARO_API_URL?.replace(/\/$/, "") || "http://127.0.0.1:8000";

/** Nel browser le API passano dallo stesso indirizzo della pagina, così il telefono non deve raggiungere il PC in LAN. */
export const API_URL =
  typeof window !== "undefined" && !isTauri() ? window.location.origin : configuredApiUrl;

export const DOWNLOAD_PORTAL_URL =
  import.meta.env.VITE_AMARO_DOWNLOAD_URL?.replace(/\/$/, "") ??
  `${API_URL}/area-tesserati#wattlab`;

export const ACTIVE_MEMBERSHIP = "active";

export async function amaroFetch(
  input: string,
  init?: RequestInit,
): Promise<Response> {
  const { isTauri } = await import("./runtime");
  if (!isTauri()) {
    return fetch(input, init);
  }
  const { fetch: tauriFetch } = await import("@tauri-apps/plugin-http");
  return tauriFetch(input, init);
}

export class AmaroAuthError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "AmaroAuthError";
    this.status = status;
  }
}

export function isActiveMember(member: AmaroMember): boolean {
  return member.membershipStatus === ACTIVE_MEMBERSHIP;
}

export async function amaroJson<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const stored = await getAuth();
  if (!stored?.token) {
    throw new AmaroAuthError("Accedi con l'account tesserato.", 401);
  }
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${stored.token}`);
  if (init.body && !(init.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const res = await amaroFetch(`${API_URL}${path}`, { ...init, headers });
  if (!res.ok) {
    throw new AmaroAuthError(await parseAmaroError(res), res.status);
  }
  if (res.status === 204) {
    return undefined as T;
  }
  return (await res.json()) as T;
}

export async function parseAmaroError(res: Response): Promise<string> {
  try {
    const data = (await res.json()) as { detail?: string | { msg?: string }[] };
    if (typeof data.detail === "string") return data.detail;
    if (Array.isArray(data.detail) && data.detail[0]?.msg) {
      return data.detail[0].msg;
    }
  } catch {
    // ignore
  }
  return "Richiesta non riuscita.";
}

function assertActiveMember(member: AmaroMember): void {
  if (!isActiveMember(member)) {
    throw new AmaroAuthError(
      "Tessera non attiva. Rinnova la quota per accedere a WattLab.",
      403,
    );
  }
}

export async function login(
  email: string,
  password: string,
): Promise<AuthSession> {
  const res = await amaroFetch(`${API_URL}/api/wattlab/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });

  if (!res.ok) {
    throw new AmaroAuthError(await parseAmaroError(res), res.status);
  }

  const session = (await res.json()) as AuthSession;
  assertActiveMember(session.member);
  await saveAuth(session);
  return session;
}

export async function fetchMe(token: string): Promise<AmaroMember> {
  const res = await amaroFetch(`${API_URL}/api/wattlab/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    throw new AmaroAuthError(await parseAmaroError(res), res.status);
  }

  const data = (await res.json()) as { member: AmaroMember };
  assertActiveMember(data.member);
  return data.member;
}

const SESSION_RESTORE_MS = 12_000;

export async function restoreSession(): Promise<AuthSession | null> {
  const stored = await getAuth();
  if (!stored?.token) return null;

  try {
    const member = await Promise.race([
      fetchMe(stored.token),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("timeout")), SESSION_RESTORE_MS),
      ),
    ]);
    const session: AuthSession = { ...stored, member };
    await saveAuth(session);
    return session;
  } catch {
    await clearAuth();
    return null;
  }
}

export async function logout(): Promise<void> {
  const stored = await getAuth();
  if (stored?.token) {
    await amaroFetch(`${API_URL}/api/wattlab/logout`, {
      method: "POST",
      headers: { Authorization: `Bearer ${stored.token}` },
    }).catch(() => undefined);
  }
  await clearAuth();
}

export async function openExternalUrl(url: string): Promise<void> {
  const { isTauri } = await import("./runtime");
  if (!isTauri()) {
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }
  const { openUrl } = await import("@tauri-apps/plugin-opener");
  await openUrl(url);
}

export async function openDownloadPortal(): Promise<void> {
  await openExternalUrl(DOWNLOAD_PORTAL_URL);
}
