import type { BuildState, PhotoCheckResult, RevisionDetail } from "@vibread/core";

export class BuildApiError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "BuildApiError";
    this.status = status;
    this.code = code;
  }
}


function apiErrorDetails(value: unknown): { message?: string; code?: string } {
  if (typeof value !== "object" || value === null || !("error" in value)) return {};
  const error = value.error;
  if (typeof error !== "object" || error === null) return {};
  const message = "message" in error && typeof error.message === "string" ? error.message : undefined;
  const code = "code" in error && typeof error.code === "string" ? error.code : undefined;
  return { message, code };
}

async function requestJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = undefined;
  }

  if (!response.ok) {
    const details = apiErrorDetails(payload);
    throw new BuildApiError(
      details.message ?? `The server could not complete that request (${response.status}).`,
      response.status,
      details.code,
    );
  }

  return payload as T;
}

function missionUrl(missionId: string, suffix: string): string {
  return `/api/missions/${encodeURIComponent(missionId)}${suffix}`;
}

export interface PhoneMission {
  id: string;
  title: string;
  currentStep: number;
}

export function fetchPhoneMissions(signal?: AbortSignal): Promise<PhoneMission[]> {
  return requestJson<PhoneMission[]>("/api/phone/missions", {
    method: "GET",
    headers: { Accept: "application/json" },
    signal,
  });
}
export interface InventoryScanStart {
  id: string;
}

export function createInventoryScan(signal?: AbortSignal): Promise<InventoryScanStart> {
  return requestJson<InventoryScanStart>("/api/inventory/scans", {
    method: "POST",
    headers: { Accept: "application/json" },
    signal,
  });
}


export function fetchBuildState(missionId: string, signal?: AbortSignal): Promise<BuildState> {
  return requestJson<BuildState>(missionUrl(missionId, "/build"), {
    method: "GET",
    headers: { Accept: "application/json" },
    signal,
  });
}

export function fetchRevisionDetail(missionId: string, revision: number, signal?: AbortSignal): Promise<RevisionDetail> {
  return requestJson<RevisionDetail>(missionUrl(missionId, `/revisions/${revision}`), {
    method: "GET",
    headers: { Accept: "application/json" },
    signal,
  });
}

/** How often the phone rereads the revision while a checkpoint on screen waits for the laptop's bench run. */
export const CHECKPOINT_POLL_MS = 1_500;

/**
 * The phone's revision query. Checkpoint results (bench runs) land on the revision from the laptop, so while a
 * checkpoint step is on screen it polls as often as the build state; otherwise the revision doesn't change under a step.
 */
export function revisionQueryOptions(missionId: string, revision: number | undefined, onCheckpointStep: boolean) {
  return {
    queryKey: ["mission-revision", missionId, revision] as const,
    queryFn: ({ signal }: { signal: AbortSignal }) => fetchRevisionDetail(missionId, revision!, signal),
    enabled: revision !== undefined,
    staleTime: 5 * 60_000,
    refetchInterval: onCheckpointStep ? CHECKPOINT_POLL_MS : (false as const),
    retry: false,
  };
}

export function postBuildStep(missionId: string, n: number): Promise<BuildState> {
  return requestJson<BuildState>(missionUrl(missionId, "/build/step"), {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ n }),
  });
}

export function postPhotoCheck(missionId: string, step: number, photo: File): Promise<PhotoCheckResult> {
  const form = new FormData();
  form.append("photo", photo);
  form.append("step", String(step));
  return requestJson<PhotoCheckResult>(missionUrl(missionId, "/photo"), {
    method: "POST",
    headers: { Accept: "application/json" },
    body: form,
  });
}
