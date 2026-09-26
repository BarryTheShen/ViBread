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
