import type {
  ApiError,
  ApprovalDecision,
  ApprovalView,
  BuildState,
  ClaudeAccountView,
  ClaudeLoginStart,
  ConnectionsView,
  CreateMissionRequest,
  ImessageLinkCode,
  MeResponse,
  MissionDetail,
  MissionSummary,
  ModuleSummary,
  RevisionDetail,
  RevisionSummary,
  TimelineEvent,
  TokenMintResponse,
} from "@vibread/core";

/** A non-2xx response from the ViBread server, carrying the `{ error: { code, message } }` body. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

function isApiError(value: unknown): value is ApiError {
  if (typeof value !== "object" || value === null || !("error" in value)) return false;
  const error = value.error;
  return typeof error === "object" && error !== null && "message" in error && typeof error.message === "string";
}

/** Turns a failed response into an HttpError with the server's message when it sent one. */
export async function errorFromResponse(res: Response): Promise<HttpError> {
  const text = await res.text().catch(() => "");
  if (text) {
    try {
      const body: unknown = JSON.parse(text);
      if (isApiError(body)) return new HttpError(res.status, body.error.code, body.error.message);
      // OAuth-style bodies (`{ error: "invalid_credentials", error_description? }`) from the OAuth/MCP routes.
      if (typeof body === "object" && body !== null && "error" in body && typeof body.error === "string") {
        const description = "error_description" in body && typeof body.error_description === "string" ? body.error_description : body.error;
        return new HttpError(res.status, body.error, description);
      }
    } catch {
      // not JSON: fall through to the raw text
    }
  }
  return new HttpError(res.status, `http_${res.status}`, text.slice(0, 300) || `${res.status} ${res.statusText}`);
}

export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined && typeof init.body === "string" && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const res = await fetch(path, { credentials: "include", ...init, headers });
  if (!res.ok) throw await errorFromResponse(res);
  return res;
}

export async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await apiFetch(path, { signal });
  return (await res.json()) as T;
}

export async function sendJson<T>(method: "POST" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<T> {
  const res = await apiFetch(path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
  return (await res.json()) as T;
}

export async function getText(path: string, signal?: AbortSignal): Promise<string> {
  const res = await apiFetch(path, { signal });
  return res.text();
}

const m = (id: string) => `/api/missions/${encodeURIComponent(id)}`;

/** Typed calls for every REST route in `@vibread/core` api.ts that the workspace uses. */
export const api = {
  me: (signal?: AbortSignal) => getJson<MeResponse>("/api/me", signal),
  modules: (signal?: AbortSignal) => getJson<ModuleSummary[]>("/api/modules", signal),
  missions: (signal?: AbortSignal) => getJson<MissionSummary[]>("/api/missions", signal),
  createMission: (body: CreateMissionRequest) => sendJson<MissionSummary>("POST", "/api/missions", body),
  mission: (id: string, signal?: AbortSignal) => getJson<MissionDetail>(m(id), signal),
  timeline: (id: string, after?: string, signal?: AbortSignal) =>
    getJson<TimelineEvent[]>(`${m(id)}/timeline${after ? `?after=${encodeURIComponent(after)}` : ""}`, signal),
  revisions: (id: string, signal?: AbortSignal) => getJson<RevisionSummary[]>(`${m(id)}/revisions`, signal),
  revision: (id: string, n: number, signal?: AbortSignal) => getJson<RevisionDetail>(`${m(id)}/revisions/${n}`, signal),
  artifactPath: (id: string, n: number, key: string) => `${m(id)}/revisions/${n}/artifacts/${encodeURIComponent(key)}`,
  build: (id: string, signal?: AbortSignal) => getJson<BuildState>(`${m(id)}/build`, signal),
  decideApproval: (approvalId: string, decision: ApprovalDecision) =>
    sendJson<ApprovalView>("POST", `/api/approvals/${encodeURIComponent(approvalId)}`, { decision }),
  release: (id: string, revision: number, acknowledgeMissingReview: boolean) =>
    sendJson<MissionDetail>("POST", `${m(id)}/release`, { revision, ...(acknowledgeMissingReview ? { acknowledgeMissingReview: true } : {}) }),
  confirm: (id: string) => sendJson<MissionDetail>("POST", `${m(id)}/confirm`, {}),
  claudeStart: () => sendJson<ClaudeLoginStart>("POST", "/api/connections/claude/start", {}),
  claudeComplete: (loginId: string, code: string) => sendJson<ClaudeAccountView>("POST", "/api/connections/claude/complete", { loginId, code }),
  claudeCancel: (loginId: string) => sendJson<ClaudeAccountView>("POST", "/api/connections/claude/cancel", { loginId }),
  claudeDisconnect: () => sendJson<ClaudeAccountView>("DELETE", "/api/connections/claude"),
  stopAgent: (id: string) => sendJson<{ ok: true }>("POST", `${m(id)}/chat/stop`),
  chatPath: (id: string) => `${m(id)}/chat`,
  connections: (signal?: AbortSignal) => getJson<ConnectionsView>("/api/connections", signal),
  mintToken: (scopes: string[], ttlMinutes: number) =>
    sendJson<TokenMintResponse>("POST", "/api/connections/tokens", { scopes, ttlMinutes }),
  revokeToken: (tokenId: string) => sendJson<{ ok: true }>("DELETE", `/api/connections/tokens/${encodeURIComponent(tokenId)}`),
  imessageCode: () => sendJson<ImessageLinkCode>("POST", "/api/connections/imessage/code"),
};
