import { apiFetch, errorFromResponse } from "../api/client.js";
import { saveFile } from "../workspace/downloads.js";

export interface ImportedProject {
  missionId: string;
}

function fallbackFileName(title: string): string {
  const name = title.normalize("NFKC").replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^[.\-_]+|[.\-_]+$/g, "").slice(0, 100);
  return `${name || "project"}.vibread`;
}

function responseFileName(response: Response, fallback: string): string {
  const header = response.headers.get("content-disposition");
  const encoded = header?.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  const raw = encoded ?? header?.match(/filename=\"?([^\";]+)\"?/i)?.[1];
  if (!raw) return fallback;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export async function downloadProject(missionId: string, title: string): Promise<void> {
  const response = await apiFetch(`/api/missions/${encodeURIComponent(missionId)}/project`);
  const bytes = await response.blob();
  saveFile(bytes, responseFileName(response, fallbackFileName(title)), "application/zip");
}

export async function importProject(file: File): Promise<ImportedProject> {
  const form = new FormData();
  form.set("file", file, file.name);
  const response = await fetch("/api/missions/import", { method: "POST", body: form, credentials: "include" });
  if (!response.ok) throw await errorFromResponse(response);
  return (await response.json()) as ImportedProject;
}
