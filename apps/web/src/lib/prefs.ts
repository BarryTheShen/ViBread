import { PERMISSION_MODES, type PermissionMode } from "@vibread/core";
import { useCallback, useSyncExternalStore } from "react";

/**
 * Default permission mode for new missions. The REST contract has no per-user preference route, so this browser
 * keeps it and sends it as `CreateMissionRequest.mode`.
 */
const KEY = "vibread.defaultMode";
const listeners = new Set<() => void>();

function read(): PermissionMode {
  const value = typeof localStorage === "undefined" ? null : localStorage.getItem(KEY);
  return PERMISSION_MODES.find((m) => m === value) ?? "review";
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener("storage", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}

export function useDefaultMode(): [PermissionMode, (mode: PermissionMode) => void] {
  const mode = useSyncExternalStore(subscribe, read, () => "review" as const);
  const set = useCallback((next: PermissionMode) => {
    localStorage.setItem(KEY, next);
    for (const listener of listeners) listener();
  }, []);
  return [mode, set];
}
