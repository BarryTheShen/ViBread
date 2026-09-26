import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  CatalogView,
  InventoryEntry,
  InventoryUpsertRequest,
  InventoryView,
  ParsePartsResponse,
  PartType,
  ScanAcceptRequest,
  ScanView,
} from "@vibread/core";
import { apiFetch, getJson, sendJson } from "./client.js";

/** Query keys for the inventory/catalog surfaces. Kept separate from mission query keys so mutations can invalidate narrowly. */
export const inventoryQueryKeys = {
  catalog: ["catalog"] as const,
  inventory: ["inventory"] as const,
  scan: (id: string) => ["inventory", "scan", id] as const,
};

export interface ScanPhotoUploadResult {
  photos?: number;
  scan?: ScanView;
}

export interface CreateScanResult {
  id: string;
  status?: ScanView["status"];
  photos?: number;
  items?: ScanView["items"];
  claude?: ScanView["claude"];
  createdAt?: string;
}

export async function fetchCatalog(signal?: AbortSignal): Promise<CatalogView> {
  return getJson<CatalogView>("/api/catalog", signal);
}

export async function fetchInventory(signal?: AbortSignal): Promise<InventoryView> {
  return getJson<InventoryView>("/api/inventory", signal);
}

export async function parseInventory(text: string): Promise<ParsePartsResponse> {
  return sendJson<ParsePartsResponse>("POST", "/api/inventory/parse", { text });
}

export async function upsertInventory(body: InventoryUpsertRequest): Promise<InventoryEntry[]> {
  return sendJson<InventoryEntry[]>("POST", "/api/inventory/items", body);
}

export async function patchInventoryItem(id: string, patch: Partial<InventoryUpsertRequest["items"][number]>): Promise<InventoryEntry> {
  return sendJson<InventoryEntry>("PATCH", `/api/inventory/items/${encodeURIComponent(id)}`, patch);
}

export async function deleteInventoryItem(id: string): Promise<{ ok: true }> {
  return sendJson<{ ok: true }>("DELETE", `/api/inventory/items/${encodeURIComponent(id)}`);
}

export async function createPartType(type: Omit<PartType, "id" | "builtIn"> & Partial<Pick<PartType, "id">>): Promise<PartType> {
  return sendJson<PartType>("POST", "/api/catalog/types", type);
}

export async function patchPartType(id: string, patch: Partial<Omit<PartType, "id" | "builtIn">>): Promise<PartType> {
  return sendJson<PartType>("PATCH", `/api/catalog/types/${encodeURIComponent(id)}`, patch);
}

export async function deletePartType(id: string): Promise<{ ok: true }> {
  return sendJson<{ ok: true }>("DELETE", `/api/catalog/types/${encodeURIComponent(id)}`);
}

export async function createScan(): Promise<CreateScanResult> {
  return sendJson<CreateScanResult>("POST", "/api/inventory/scans", {});
}

export async function fetchScan(id: string, signal?: AbortSignal): Promise<ScanView> {
  return getJson<ScanView>(`/api/inventory/scans/${encodeURIComponent(id)}`, signal);
}

export async function uploadScanPhoto(id: string, file: File): Promise<ScanPhotoUploadResult> {
  const form = new FormData();
  form.append("photo", file, file.name || "scan-photo.jpg");
  const response = await apiFetch(`/api/inventory/scans/${encodeURIComponent(id)}/photos`, {
    method: "POST",
    body: form,
  });
  return (await response.json()) as ScanPhotoUploadResult;
}

export async function analyzeScan(id: string): Promise<ScanView> {
  return sendJson<ScanView>("POST", `/api/inventory/scans/${encodeURIComponent(id)}/analyze`, {});
}

export function scanCropUrl(id: string, index: number): string {
  return `/api/inventory/scans/${encodeURIComponent(id)}/crops/${index}`;
}

export async function acceptScan(id: string, body: ScanAcceptRequest): Promise<InventoryEntry[]> {
  return sendJson<InventoryEntry[]>("POST", `/api/inventory/scans/${encodeURIComponent(id)}/accept`, body);
}

export function useCatalog() {
  return useQuery({
    queryKey: inventoryQueryKeys.catalog,
    queryFn: ({ signal }) => fetchCatalog(signal),
    staleTime: 60_000,
  });
}

export function useInventory() {
  return useQuery({
    queryKey: inventoryQueryKeys.inventory,
    queryFn: ({ signal }) => fetchInventory(signal),
    staleTime: 10_000,
  });
}

export function useParseInventory() {
  return useMutation({ mutationFn: (text: string) => parseInventory(text) });
}

export function useUpsertInventory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: InventoryUpsertRequest) => upsertInventory(body),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: inventoryQueryKeys.inventory }),
  });
}

export function usePatchInventoryItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Partial<InventoryUpsertRequest["items"][number]> }) => patchInventoryItem(id, patch),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: inventoryQueryKeys.inventory }),
  });
}

export function useDeleteInventoryItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteInventoryItem(id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: inventoryQueryKeys.inventory }),
  });
}

export function useCreatePartType() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (type: Omit<PartType, "id" | "builtIn"> & Partial<Pick<PartType, "id">>) => createPartType(type),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: inventoryQueryKeys.catalog }),
  });
}

export function usePatchPartType() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Partial<Omit<PartType, "id" | "builtIn">> }) => patchPartType(id, patch),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: inventoryQueryKeys.catalog }),
  });
}

export function useDeletePartType() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deletePartType(id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: inventoryQueryKeys.catalog }),
  });
}

export function useCreateScan() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => createScan(),
    onSuccess: (scan) => {
      if (scan.id) void queryClient.invalidateQueries({ queryKey: inventoryQueryKeys.scan(scan.id) });
    },
  });
}

export function scanPollingInterval(status: ScanView["status"] | undefined): number | false {
  return status === "ready" || status === "failed" || status === "accepted" ? false : 1_500;
}

/**
 * The laptop's scan query. It keeps polling while the window is hidden — a phone window or another app covering the
 * browser makes the page "hidden", and the paired phone's uploads must still show up (issue #4).
 */
export function scanQueryOptions(scanId: string, enabled = true) {
  return queryOptions({
    queryKey: inventoryQueryKeys.scan(scanId),
    queryFn: ({ signal }) => fetchScan(scanId, signal),
    enabled: Boolean(scanId) && enabled,
    refetchInterval: (query) => scanPollingInterval(query.state.data?.status),
    refetchIntervalInBackground: true,
  });
}

export function useScan(scanId: string, enabled = true) {
  return useQuery(scanQueryOptions(scanId, enabled));
}

export function useUploadScanPhoto(scanId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (file: File) => uploadScanPhoto(scanId, file),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: inventoryQueryKeys.scan(scanId) }),
  });
}

export function useAnalyzeScan(scanId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => analyzeScan(scanId),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: inventoryQueryKeys.scan(scanId) }),
  });
}

export function useAcceptScan(scanId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: ScanAcceptRequest) => acceptScan(scanId, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: inventoryQueryKeys.inventory });
      void queryClient.invalidateQueries({ queryKey: inventoryQueryKeys.scan(scanId) });
    },
  });
}
