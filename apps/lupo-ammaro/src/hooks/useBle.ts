import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";
import type { ConnectionState, ScanResult, Telemetry } from "../types";

const defaultConnection: ConnectionState = { status: "disconnected" };

function isKnownTrainerName(name: string): boolean {
  const trimmed = name.trim();
  if (!trimmed) return false;
  const lower = trimmed.toLowerCase();
  return !["unknown", "unknown trainer", "(unknown)", "n/a", "unnamed"].includes(lower);
}

export function useBleEvents() {
  const [scanResults, setScanResults] = useState<ScanResult[]>([]);
  const [connection, setConnection] = useState<ConnectionState>(defaultConnection);
  const [telemetry, setTelemetry] = useState<Telemetry | null>(null);

  useEffect(() => {
    const unlisteners: UnlistenFn[] = [];

    void (async () => {
      unlisteners.push(
        await listen<ScanResult>("scan-result", (event) => {
          if (!isKnownTrainerName(event.payload.name)) return;
          setScanResults((prev) => {
            if (prev.some((d) => d.id === event.payload.id)) return prev;
            return [...prev, event.payload];
          });
        }),
      );

      unlisteners.push(
        await listen<ConnectionState>("connection-state", (event) => {
          setConnection(event.payload);
        }),
      );

      unlisteners.push(
        await listen<Telemetry>("telemetry", (event) => {
          setTelemetry(event.payload);
        }),
      );
    })();

    return () => {
      unlisteners.forEach((u) => void u());
    };
  }, []);

  return { scanResults, connection, telemetry, setScanResults, setConnection };
}

export async function startScan() {
  await invoke("start_scan");
}

export async function stopScan() {
  await invoke("stop_scan");
}

export async function connectTrainer(deviceId: string) {
  await invoke("connect_trainer", { deviceId });
}

export async function disconnectTrainer() {
  await invoke("disconnect_trainer");
}

export async function setControlMode(
  mode: "erg" | "resistance" | "sim",
  options: {
    targetPower?: number;
    resistance?: number;
    simulation?: { gradePercent: number; windSpeedMs: number };
  } = {},
) {
  await invoke("set_control_mode", { mode, ...options });
}

export async function setTargetPower(watts: number) {
  await invoke("set_target_power", { watts });
}

export async function startSession() {
  await invoke("start_session");
}

export async function pauseSession() {
  await invoke("pause_session");
}

export async function resumeSession() {
  await invoke("resume_session");
}

export async function endSession() {
  return invoke<import("../types").SessionSummary>("end_session");
}

export async function exportFit() {
  return invoke<string | null>("export_fit");
}

export async function getLastSessionSamples() {
  return invoke<import("../types").SessionSample[]>("get_last_session_samples");
}
