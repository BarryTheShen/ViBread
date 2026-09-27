import { formatOhms, type FieldValue, type PartField, type PartType, type ScanItem } from "@vibread/core";

export type FieldValues = Record<string, FieldValue>;

const OPTION_LABELS: Record<string, string> = { "uno-r3": "Uno R3", "830-split": "830 (split rails)" };

/** Render a choice's unit and known human label while preserving its raw stored value. */
export function choiceOptionLabel(field: PartField, option: string): string {
  const label = OPTION_LABELS[option] ?? option;
  return `${label}${field.unit ? ` ${field.unit}` : ""}`;
}

/** Build a controlled form state from a PartField list, preserving any known values. */
export function valuesForFields(fields: PartField[], existing: FieldValues = {}): FieldValues {
  const values: FieldValues = {};
  for (const field of fields) {
    const current = existing[field.key];
    if (current !== undefined) {
      values[field.key] = current;
      continue;
    }
    if (field.kind === "boolean") {
      values[field.key] = false;
    } else if (field.kind === "number") {
      values[field.key] = "";
    } else {
      values[field.key] = field.options?.[0] ?? "";
    }
  }
  return values;
}

/** Keep arbitrary JSON values from a typed input in the FieldValue contract. */
export function parseFieldValue(field: PartField, raw: string | boolean): FieldValue {
  if (field.kind === "boolean") return Boolean(raw);
  if (field.kind === "number") {
    if (raw === "") return "";
    const number = Number(raw);
    return Number.isFinite(number) ? number : "";
  }
  return String(raw);
}

/** Human-readable value for a field in inventory rows and review cards. */
export function formatFieldValue(field: PartField, value: FieldValue | undefined): string {
  if (value === undefined || value === "") return "—";
  if (field.kind === "boolean") return value ? "Yes" : "No";
  if (field.kind === "choice" && typeof value === "string") return choiceOptionLabel(field, value);
  if (field.kind === "number" && field.unit === "Ω" && typeof value === "number") return formatOhms(value);
  return `${String(value)}${field.unit ? ` ${field.unit}` : ""}`;
}

/** Compact type + field label shown in rows, links and review cards. */
export function formatEntryLabel(type: PartType | undefined, values: FieldValues): string {
  if (!type) return "Unknown part";
  const details = type.fields
    .filter((field) => values[field.key] !== undefined && values[field.key] !== "")
    .map((field) => formatFieldValue(field, values[field.key]))
    .filter((value) => value !== "—");
  return details.length > 0 ? `${type.name} · ${details.join(" · ")}` : type.name;
}

/** Merge quantity according to the scan review Add/Replace choice. */
export function mergedReviewQuantity(existingQuantity: number | undefined, scannedQuantity: number, mode: "add" | "replace"): number {
  const scanned = Math.max(0, Math.trunc(scannedQuantity));
  if (mode === "replace") return scanned;
  return Math.max(0, Math.trunc(existingQuantity ?? 0)) + scanned;
}

/** The exact sentence shown beside a scan row when an existing identity matches. */
export function reviewQuantityLabel(existingQuantity: number | undefined, scannedQuantity: number, mode: "add" | "replace"): string | undefined {
  if (existingQuantity === undefined) return undefined;
  return `have ${existingQuantity} → will be ${mergedReviewQuantity(existingQuantity, scannedQuantity, mode)}`;
}

/** Resolve a scan row to the accept request; the server applies Add/Replace to this raw scanned quantity. */
export function scanItemToUpsert(item: ScanItem, typeId: string, mode: "add" | "replace") {
  return {
    index: item.index,
    typeId,
    values: item.values,
    quantity: Math.max(1, Math.trunc(item.quantity)),
    mode,
  } as const;
}
