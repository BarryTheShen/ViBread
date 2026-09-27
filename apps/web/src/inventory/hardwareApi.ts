import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { HardwareIdentification, HardwareKind, HardwareView, MyHardware } from "@vibread/core";
import { apiFetch, getJson, sendJson } from "../api/client.js";

/** "Your hardware" (issue #23): GET/PUT /api/inventory/hardware and POST /api/inventory/hardware/identify. */
export const hardwareQueryKey = ["inventory", "hardware"] as const;

export function useHardware() {
  return useQuery({ queryKey: hardwareQueryKey, queryFn: ({ signal }) => getJson<HardwareView>("/api/inventory/hardware", signal) });
}

export function useSaveHardware() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (hardware: MyHardware) => (await (await apiFetch("/api/inventory/hardware", { method: "PUT", body: JSON.stringify(hardware) })).json()) as HardwareView,
    onSuccess: (view) => queryClient.setQueryData(hardwareQueryKey, view),
  });
}

/** A photo from an upload or this computer's camera, or the latest photo the phone added to a scan. */
export type HardwarePhoto = { file: File } | { scanId: string };

export async function identifyHardware(photo: HardwarePhoto, kind?: HardwareKind): Promise<HardwareIdentification> {
  if ("scanId" in photo) return sendJson<HardwareIdentification>("POST", "/api/inventory/hardware/identify", { scanId: photo.scanId, ...(kind ? { kind } : {}) });
  const form = new FormData();
  form.append("photo", photo.file, photo.file.name || "hardware.jpg");
  if (kind) form.append("kind", kind);
  const response = await apiFetch("/api/inventory/hardware/identify", { method: "POST", body: form });
  return (await response.json()) as HardwareIdentification;
}

export function useIdentifyHardware() {
  return useMutation({ mutationFn: (input: { photo: HardwarePhoto; kind?: HardwareKind }) => identifyHardware(input.photo, input.kind) });
}
