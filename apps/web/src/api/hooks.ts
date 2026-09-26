import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CreateMissionRequest, PermissionMode } from "@vibread/core";
import { api, getJson, getText } from "./client.js";

export const queryKeys = {
  me: ["me"] as const,
  modules: ["modules"] as const,
  missions: ["missions"] as const,
  mission: (id: string) => ["mission", id] as const,
  timeline: (id: string) => ["mission", id, "timeline"] as const,
  revisions: (id: string) => ["mission", id, "revisions"] as const,
  revision: (id: string, n: number) => ["mission", id, "revision", n] as const,
  artifact: (url: string) => ["artifact", url] as const,
  connections: ["connections"] as const,
};

export function useMe() {
  return useQuery({ queryKey: queryKeys.me, queryFn: ({ signal }) => api.me(signal), staleTime: 60_000 });
}

export function useModules() {
  return useQuery({ queryKey: queryKeys.modules, queryFn: ({ signal }) => api.modules(signal), staleTime: Infinity });
}

export function useMissions() {
  return useQuery({ queryKey: queryKeys.missions, queryFn: ({ signal }) => api.missions(signal), refetchInterval: 10_000 });
}

/** Mission detail, polled: faster while the agent works so console lights and approvals stay current. */
export function useMission(id: string) {
  return useQuery({
    queryKey: queryKeys.mission(id),
    queryFn: ({ signal }) => api.mission(id, signal),
    refetchInterval: (query) => (query.state.data?.agentBusy ? 1_500 : 4_000),
    refetchIntervalInBackground: false,
  });
}

export function useTimeline(id: string) {
  return useQuery({ queryKey: queryKeys.timeline(id), queryFn: ({ signal }) => api.timeline(id, undefined, signal), refetchInterval: 5_000 });
}

export function useRevisions(id: string) {
  return useQuery({ queryKey: queryKeys.revisions(id), queryFn: ({ signal }) => api.revisions(id, signal) });
}

export function useRevision(id: string, n: number | undefined) {
  return useQuery({
    queryKey: queryKeys.revision(id, n ?? 0),
    queryFn: ({ signal }) => api.revision(id, n as number, signal),
    enabled: n !== undefined && n > 0,
    placeholderData: keepPreviousData,
    // Results (bench runs, photos) accrue on the same revision.
    refetchInterval: 8_000,
  });
}

/** Raw text artifact (SVG, JSON). Artifacts are content-addressed, so the URL alone is a stable key. */
export function useArtifactText(url: string | undefined) {
  return useQuery({
    queryKey: queryKeys.artifact(url ?? ""),
    queryFn: ({ signal }) => getText(url as string, signal),
    enabled: Boolean(url),
    staleTime: Infinity,
  });
}

export function useArtifactJson<T>(url: string | undefined) {
  return useQuery({
    queryKey: [...queryKeys.artifact(url ?? ""), "json"],
    queryFn: ({ signal }) => getJson<T>(url as string, signal),
    enabled: Boolean(url),
    staleTime: Infinity,
  });
}

/** Build Mode progress (the phone polls every 1–2 s; the laptop follows along). */
export function useBuildState(id: string, enabled: boolean) {
  return useQuery({ queryKey: ["mission", id, "build"], queryFn: ({ signal }) => api.build(id, signal), enabled, refetchInterval: 2_000 });
}

export function useConnections() {
  return useQuery({ queryKey: queryKeys.connections, queryFn: ({ signal }) => api.connections(signal) });
}

export function useCreateMission() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateMissionRequest) => api.createMission(body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: queryKeys.missions }),
  });
}

export function useSetMode(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (mode: PermissionMode) => api.setMode(id, mode),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.mission(id) });
      void qc.invalidateQueries({ queryKey: queryKeys.missions });
    },
  });
}

/** Human "GO for build": releases a revision as the build target. */
export function useRelease(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ revision, acknowledgeMissingReview }: { revision: number; acknowledgeMissingReview: boolean }) =>
      api.release(id, revision, acknowledgeMissingReview),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.mission(id) });
      void qc.invalidateQueries({ queryKey: queryKeys.missions });
    },
  });
}

/** "Yes — mission complete" (USER_CONFIRMED). */
export function useConfirmMission(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.confirm(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: queryKeys.mission(id) }),
  });
}

export function useStopAgent(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.stopAgent(id),
    onSettled: () => void qc.invalidateQueries({ queryKey: queryKeys.mission(id) }),
  });
}

export function useMintToken() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ scopes, ttlMinutes }: { scopes: string[]; ttlMinutes: number }) => api.mintToken(scopes, ttlMinutes),
    onSuccess: () => void qc.invalidateQueries({ queryKey: queryKeys.connections }),
  });
}

export function useRevokeToken() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (tokenId: string) => api.revokeToken(tokenId),
    onSuccess: () => void qc.invalidateQueries({ queryKey: queryKeys.connections }),
  });
}

export function useImessageCode() {
  return useMutation({ mutationFn: () => api.imessageCode() });
}

/**
 * Origin for links a phone will open (Build Mode QR codes). Phones can't open `localhost`, so prefer the server's
 * `phoneUrl` (its LAN address, from GET /api/connections), then the public URL (the MCP URL's origin), then this page.
 */
export function usePhoneOrigin(): string {
  const connections = useConnections();
  const here = window.location.origin;
  // `phoneUrl` may be absent on servers older than the field.
  const phoneUrl: string | undefined = connections.data?.phoneUrl;
  const local = /^(localhost|127\.|\[::1\])/.test(window.location.hostname);
  for (const candidate of [phoneUrl, local ? connections.data?.mcpUrl : undefined]) {
    if (!candidate) continue;
    try {
      return new URL(candidate).origin;
    } catch {
      // not a URL: try the next source
    }
  }
  return here;
}

/**
 * Build Mode link for a phone: phone origin + `/b/<id>`, plus the laptop's one-time LAN pairing query
 * (`phonePairQuery`, e.g. "pair=<token>") when the server hands one out. Works without the field.
 */
export function usePhoneBuildLink(missionId: string): string {
  const origin = usePhoneOrigin();
  const connections = useConnections();
  const data: unknown = connections.data;
  // Read defensively: servers without LAN pairing (and the core type until it lands) don't send the field.
  const pair = typeof data === "object" && data !== null && "phonePairQuery" in data && typeof data.phonePairQuery === "string" ? data.phonePairQuery : "";
  const query = pair.replace(/^\?/, "");
  return `${origin}/b/${encodeURIComponent(missionId)}${query ? `?${query}` : ""}`;
}
