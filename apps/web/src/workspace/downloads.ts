import { BOARD_PROFILES, MODULES, formatOhms, type Circuit, type Part } from "@vibread/core";
import { strToU8, zipSync, type Zippable } from "fflate";

/**
 * What the panel's download menu offers for one design version (IQA2-14): the Arduino sketch and one "Everything" zip
 * first, then single files, with the many per-step pictures and the diagnostic files folded into zips.
 */

/** File/folder name the Arduino IDE accepts for a sketch ("Launch Control" → "launch-control"). */
export function sketchName(title: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50)
    .replace(/-+$/, "");
  return slug || "sketch";
}

const STEP = /^step-(\d+)\.(svg|png)$/;

export type BundleKind = "everything" | "steps" | "other";

/** One file inside a zip: either an artifact to fetch (`key`) or text made here. */
export type BundleEntry = { path: string; key: string } | { path: string; text: string };

/** Single-file downloads shown as their own menu rows, in menu order. */
export const SINGLE_FILES: readonly { key: string; label: string; group: "Compiled" | "Pictures"; suffix: string }[] = [
  { key: "app.hex", label: "Compiled sketch · HEX", group: "Compiled", suffix: ".hex" },
  { key: "bench.hex", label: "Bench self-test firmware · HEX", group: "Compiled", suffix: "-bench-self-test.hex" },
  { key: "schematic.svg", label: "Schematic · SVG", group: "Pictures", suffix: "-schematic.svg" },
  { key: "schematic.png", label: "Schematic · PNG", group: "Pictures", suffix: "-schematic.png" },
  { key: "breadboard.svg", label: "Breadboard picture · SVG", group: "Pictures", suffix: "-breadboard.svg" },
];

/** Step pictures, one per step: the PNG (opens anywhere) when there is one, else the SVG; numbered so they sort. */
function stepPictures(keys: readonly string[]): { n: number; key: string }[] {
  const byStep = new Map<number, string>();
  for (const key of keys) {
    const match = STEP.exec(key);
    if (!match) continue;
    const n = Number(match[1]);
    const current = byStep.get(n);
    if (!current || (match[2] === "png" && current.endsWith(".svg"))) byStep.set(n, key);
  }
  return [...byStep.entries()].sort((a, b) => a[0] - b[0]).map(([n, key]) => ({ n, key }));
}

export function stepPictureCount(keys: readonly string[]): number {
  return stepPictures(keys).length;
}

/** Artifacts that aren't the sketch, a single-file row, a step picture or a calibrated-firmware cache (`app-<runId>.hex`): traces, fault data, photo checks… */
export function otherFiles(keys: readonly string[]): string[] {
  return keys.filter((key) => !SINGLE_FILES.some((f) => f.key === key) && !STEP.test(key) && !/^step-\d+-focus\.(?:svg|png)$/.test(key) && !/^app-.+\.hex$/.test(key));
}

function partLine(part: Part): string {
  const params = part.params ?? {};
  const value = [typeof params.color === "string" ? params.color : "", typeof params.ohms === "number" ? formatOhms(params.ohms) : ""].filter(Boolean).join(", ");
  const name = `${MODULES[part.module]?.name ?? part.module}${value ? ` (${value})` : ""}`;
  return `${part.id.padEnd(6)} ${name}${part.label ? ` — ${part.label}` : ""}`;
}

export function partsListText(circuit: Circuit, revision: number): string {
  return [`${circuit.title} — parts for design r${revision}`, "", ...circuit.parts.map(partLine), "", `Board: ${BOARD_PROFILES[circuit.board.profile]?.name ?? circuit.board.profile}`, ""].join("\n");
}

/**
 * The files of a zip and the folder they sit in. "everything" puts the sketch in a folder of the same name
 * (`launch-control/launch-control.ino`), which is what the Arduino IDE needs to open it.
 */
export function bundlePlan(kind: BundleKind, name: string, revision: number, circuit: Circuit, keys: readonly string[]): { fileName: string; entries: BundleEntry[] } {
  const root = `${name}-r${revision}`;
  const steps = stepPictures(keys).map(({ n, key }) => ({ path: `steps/step-${String(n).padStart(2, "0")}${key.slice(key.lastIndexOf("."))}`, key }));
  if (kind === "steps") return { fileName: `${root}-steps.zip`, entries: steps.map((e) => ({ ...e, path: `${root}-steps/${e.path.slice("steps/".length)}` })) };
  if (kind === "other") return { fileName: `${root}-reports.zip`, entries: otherFiles(keys).map((key) => ({ path: `${root}-reports/${key}`, key })) };
  const has = (key: string) => keys.includes(key);
  const entries: BundleEntry[] = [
    { path: `${name}/${name}.ino`, text: circuit.sketch.source },
    ...(has("app.hex") ? [{ path: `${name}.hex`, key: "app.hex" }] : []),
    ...(has("schematic.svg") ? [{ path: "schematic.svg", key: "schematic.svg" }] : []),
    ...(has("breadboard.svg") ? [{ path: "breadboard.svg", key: "breadboard.svg" }] : []),
    { path: "parts-list.txt", text: partsListText(circuit, revision) },
    ...steps,
  ];
  return { fileName: `${root}.zip`, entries: entries.map((e) => ({ ...e, path: `${root}/${e.path}` })) };
}

/** Zip the planned entries; `fetchBytes` loads an artifact. Already-compressed pictures are stored, not re-deflated. */
export async function buildZip(entries: readonly BundleEntry[], fetchBytes: (key: string) => Promise<Uint8Array>): Promise<Uint8Array<ArrayBuffer>> {
  const files: Zippable = {};
  await Promise.all(
    entries.map(async (entry) => {
      const data = "text" in entry ? strToU8(entry.text) : await fetchBytes(entry.key);
      files[entry.path] = [data, { level: /\.(?:png|jpe?g)$/i.test(entry.path) ? 0 : 6 }];
    }),
  );
  return zipSync(files);
}

/** Save bytes or text as a file through a temporary link. */
export function saveFile(data: BlobPart, fileName: string, type: string): void {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
