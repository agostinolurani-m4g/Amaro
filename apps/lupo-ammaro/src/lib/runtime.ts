import { isTauri as tauriIsTauri } from "@tauri-apps/api/core";

export function isTauri(): boolean {
  try {
    return tauriIsTauri();
  } catch {
    return false;
  }
}

export function isMobileViewport(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia("(max-width: 720px)").matches;
}

export function useMobileShellState(): boolean {
  return isMobileViewport();
}
