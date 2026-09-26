import type {
  FieldValue,
  InventoryEntry,
  ParsedPartLine,
  PartField,
  PartType,
  ScanItem,
  ScanObservation,
} from "./catalog.js";
import { LED_COLORS, MODULES } from "./modules.js";
import type { InventoryItem } from "./mission.js";

const E24_BASE = [10, 11, 12, 13, 15, 16, 18, 20, 22, 24, 27, 30, 33, 36, 39, 43, 47, 51, 56, 62, 68, 75, 82, 91] as const;
const E96_BASE = [
  100, 102, 105, 107, 110, 113, 115, 118, 121, 124, 127, 130, 133, 137, 140, 143, 147, 150, 154, 158, 162, 165, 169, 174,
  178, 182, 187, 191, 196, 200, 205, 210, 215, 221, 226, 232, 237, 243, 249, 255, 261, 267, 274, 280, 287, 294,
  301, 309, 316, 324, 332, 340, 348, 357, 365, 374, 383, 392, 402, 412, 422, 432, 442, 453, 464, 475, 487, 499,
  511, 523, 536, 549, 562, 576, 590, 604, 619, 634, 649, 665, 681, 698, 715, 732, 750, 768, 787, 806, 825, 845, 866,
  887, 909, 931, 953, 976,
] as const;

const BAND_DIGITS: Record<string, number> = {
  black: 0,
  brown: 1,
  red: 2,
  orange: 3,
  yellow: 4,
  green: 5,
  blue: 6,
  violet: 7,
  purple: 7,
  grey: 8,
  gray: 8,
  white: 9,
};
const MULTIPLIERS: Record<string, number> = { ...BAND_DIGITS, gold: -1, silver: -2 };
const TOLERANCES: Record<string, number> = {
  brown: 1,
  red: 2,
  green: 0.5,
  blue: 0.25,
  violet: 0.1,
  purple: 0.1,
  grey: 0.05,
  gray: 0.05,
  gold: 5,
  silver: 10,
};

function roundOhms(value: number): number {
  // A decoded standard value should remain stable across decimal powers (1.1 rather than 1.1000000000000001).
  return Number(value.toPrecision(12));
}

function standardValues(bases: readonly number[], scaleOffset: number): Set<number> {
  const values = new Set<number>();
  for (let exponent = -1; exponent <= 9; exponent += 1) {
    for (const base of bases) values.add(roundOhms(base * 10 ** (exponent + scaleOffset)));
  }
  return values;
}

// E24 values are 10..91 × 10^(n-1); E96 values are 100..976 × 10^n.
const E24_VALUES = standardValues(E24_BASE, -1);
const E96_VALUES = standardValues(E96_BASE, -2);
const E24_OR_E96_VALUES = new Set([...E24_VALUES, ...E96_VALUES]);

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonicalValue(item)]));
  }
  return value;
}

/** Stable merge key: only fields marked as identity on the catalog type participate. */
export function inventoryIdentity(type: PartType, values: Record<string, FieldValue>): string {
  const identityValues: Record<string, FieldValue | null> = {};
  for (const field of type.fields) {
    if (field.identity) identityValues[field.key] = values[field.key] ?? null;
  }
  return `${type.id}|${JSON.stringify(canonicalValue(identityValues))}`;
}

function normalizeBand(value: string): string {
  return value.trim().toLowerCase().replace("gray", "grey");
}

function isGoldOrSilver(value: string | undefined): boolean {
  const normalized = value ? normalizeBand(value) : "";
  return normalized === "gold" || normalized === "silver";
}

function decodeBandDirection(bands: string[]): { value: number; tolerancePct?: number } | undefined {
  const bandCount = bands.length;
  const significantCount = bandCount === 4 ? 2 : bandCount === 5 ? 3 : 0;
  if (!significantCount) return undefined;
  const normalized = bands.map(normalizeBand);
  const digits = normalized.slice(0, significantCount).map((band) => BAND_DIGITS[band]);
  if (digits.some((digit) => digit === undefined) || digits[0] === 0) return undefined;
  const multiplier = MULTIPLIERS[normalized[significantCount]!];
  if (multiplier === undefined) return undefined;
  const value = roundOhms(Number(digits.join("")) * 10 ** multiplier);
  if (!(value > 0) || !Number.isFinite(value)) return undefined;
  const tolerancePct = TOLERANCES[normalized[bandCount - 1]!];
  return tolerancePct === undefined ? { value } : { value, tolerancePct };
}

/** Decode a 4- or 5-band resistor in either direction, retaining only standard values. */
export function resistorFromBands(bands: string[]): { candidates: number[]; tolerancePct?: number; bandCount: 4 | 5 } {
  const bandCount: 4 | 5 = bands.length === 5 ? 5 : 4;
  if (bands.length !== 4 && bands.length !== 5) return { candidates: [], bandCount };

  const normalized = bands.map(normalizeBand);
  // Gold/silver is a tolerance band at an end. If only one end has it, orientation is known.
  const directions = isGoldOrSilver(normalized.at(-1)) && !isGoldOrSilver(normalized[0])
    ? [normalized]
    : isGoldOrSilver(normalized[0]) && !isGoldOrSilver(normalized.at(-1))
      ? [[...normalized].reverse()]
      : [normalized, [...normalized].reverse()];
  const standards = bandCount === 4 ? E24_VALUES : E24_OR_E96_VALUES;
  const decoded = directions.map((direction) => decodeBandDirection(direction)).filter((item): item is { value: number; tolerancePct?: number } => item !== undefined && standards.has(item.value));
  const candidates = [...new Set(decoded.map((item) => item.value))].sort((a, b) => a - b);
  const tolerances = [...new Set(decoded.map((item) => item.tolerancePct).filter((item): item is number => item !== undefined))];
  return {
    candidates,
    ...(tolerances.length === 1 ? { tolerancePct: tolerances[0] } : {}),
    bandCount,
  };
}

/** Parse common resistor markings: 4k7, 220R, 10 kΩ, 1M, and 3/4-digit codes such as 103. */
export function ohmsFromText(text: string): number | undefined {
  const explicitUnit = /(?:Ω|Ω|ohms?|ohm)/i.test(text);
  let value = text.trim().replace(/[,_]/g, "").replace(/[ΩΩ]/g, "").replace(/\b(?:ohms?|ohm)\b/gi, "").trim();
  // Letter prefixes on printed values (for example B10K) are tolerance/package marks, not part of the value.
  value = value.replace(/^[a-z]+(?=\d)/i, "").replace(/\s+/g, "");
  if (!value) return undefined;

  const compact = value.match(/^(\d+(?:\.\d+)?)([kKmMrR])(\d+)?$/);
  if (compact) {
    const whole = Number(compact[1]);
    const trailing = compact[3] ? Number(`0.${compact[3]}`) : 0;
    const multiplier = compact[2]!.toLowerCase() === "k" ? 1_000 : compact[2]!.toLowerCase() === "m" ? 1_000_000 : 1;
    const result = (whole + trailing) * multiplier;
    return result > 0 && Number.isFinite(result) ? roundOhms(result) : undefined;
  }
  if (/^\d+(?:\.\d+)?$/.test(value)) {
    if (/^\d{3,4}$/.test(value) && !explicitUnit) {
      const significantLength = value.length - 1;
      const significant = Number(value.slice(0, significantLength));
      const exponent = Number(value.slice(-1));
      const coded = significant * 10 ** exponent;
      return coded > 0 && Number.isFinite(coded) ? roundOhms(coded) : undefined;
    }
    const numeric = Number(value);
    return numeric > 0 && Number.isFinite(numeric) ? roundOhms(numeric) : undefined;
  }
  return undefined;
}

function positiveCount(count: number): number {
  return Number.isFinite(count) && count > 0 ? Math.max(1, Math.round(count)) : 1;
}

function field(type: PartType, key: string): PartField | undefined {
  return type.fields.find((item) => item.key === key);
}

function optionForColor(type: PartType, color: string | undefined): string | undefined {
  if (!color) return undefined;
  const colorField = field(type, "color");
  const options = colorField?.options ?? [...LED_COLORS];
  const normalized = color.trim().toLowerCase().replace(/\s+/g, "-");
  const aliases: Record<string, string> = {
    amber: "orange",
    gold: "yellow",
    grey: "gray",
    warmwhite: "warm-white",
    "warm-white": "warm-white",
  };
  const wanted = aliases[normalized] ?? normalized;
  return options.find((option) => option.toLowerCase() === wanted);
}

function valuesForObservation(type: PartType, obs: ScanObservation): Record<string, FieldValue> {
  const values: Record<string, FieldValue> = {};
  const source = `${obs.printed ?? ""} ${obs.label}`.toLowerCase();
  for (const item of type.fields) {
    if (item.key === "color") {
      const color = optionForColor(type, obs.lensColor);
      if (color) values[item.key] = color;
    } else if (item.kind === "choice" && item.options) {
      const option = item.options.find((candidate) => source.includes(candidate.toLowerCase()));
      if (option) values[item.key] = option;
    } else if (item.kind === "number" && item.key === "ohms") {
      const ohms = obs.printed ? ohmsFromText(obs.printed) : undefined;
      if (ohms !== undefined) values[item.key] = ohms;
    }
  }
  return values;
}

/** Convert one vision observation into an editable scan-review item. No model or I/O is involved. */
export function normalizeObservation(
  obs: ScanObservation,
  types: PartType[],
): Omit<ScanItem, "index" | "cropUrl" | "existing"> {
  const quantity = positiveCount(obs.count);
  const type = obs.typeId ? types.find((item) => item.id === obs.typeId) : undefined;
  if (!type) {
    return { typeId: null, label: obs.label, values: {}, quantity, status: "unknown" };
  }

  const mappingModule = type.mapping.kind === "module" || type.mapping.kind === "modelled" ? type.mapping.module : undefined;
  const label = obs.label || type.name;

  if (mappingModule === "resistor") {
    const decoded = obs.bands && (obs.bands.length === 4 || obs.bands.length === 5) ? resistorFromBands(obs.bands) : undefined;
    const printed = obs.printed ? ohmsFromText(obs.printed) : undefined;
    const candidates = printed !== undefined ? [printed] : decoded?.candidates ?? [];
    const candidateValues = candidates.map((ohms) => ({ ohms, ...(decoded ? { bands: String(decoded.bandCount) } : {}) }));
    const values = candidates.length === 1 ? candidateValues[0]! : {};
    const hasGoldSilverEnd = Boolean(obs.bands && (isGoldOrSilver(obs.bands[0]) || isGoldOrSilver(obs.bands.at(-1))));
    const ready = candidates.length === 1 && decoded?.bandCount === 4 && hasGoldSilverEnd && obs.confidence === "high";
    return {
      typeId: type.id,
      label,
      values,
      quantity,
      status: ready ? "ready" : "needs-look",
      candidates: candidateValues,
    };
  }

  if (mappingModule === "led") {
    const color = optionForColor(type, obs.lensColor);
    if (!color) {
      return {
        typeId: type.id,
        label,
        values: {},
        quantity,
        status: "needs-look",
        candidates: (field(type, "color")?.options ?? [...LED_COLORS]).map((option) => ({ color: option })),
      };
    }
    return { typeId: type.id, label, values: { color }, quantity, status: "ready" };
  }

  if (mappingModule === "potentiometer") {
    const ohms = obs.printed ? ohmsFromText(obs.printed) : undefined;
    if (ohms !== undefined) return { typeId: type.id, label, values: { ohms }, quantity, status: "ready" };
    return { typeId: type.id, label, values: {}, quantity, status: "needs-look", candidates: [] };
  }

  const values = valuesForObservation(type, obs);
  const missingRequired = type.fields.some((item) => item.required && values[item.key] === undefined);
  const status = obs.confidence === "high" && !missingRequired ? "ready" : "needs-look";
  return { typeId: type.id, label, values, quantity, status };
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};

function normalizedPhrase(value: string): string {
  return value
    .toLowerCase()
    .replace(/×/g, "x")
    .replace(/[‐‑‒–—]/g, "-")
    .replace(/[^a-z0-9µμΩ×+./ -]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function singularPhrase(value: string): string {
  const phrase = normalizedPhrase(value);
  return phrase
    .split(" ")
    .map((word) => word.endsWith("ies") ? `${word.slice(0, -3)}y` : word.endsWith("ses") ? word.slice(0, -2) : word.endsWith("s") && word.length > 2 ? word.slice(0, -1) : word)
    .join(" ");
}

function phraseFound(text: string, phrase: string): boolean {
  const source = ` ${singularPhrase(text)} `;
  const wanted = ` ${singularPhrase(phrase)} `;
  return source.includes(wanted);
}

function findType(text: string, types: PartType[]): PartType | undefined {
  const candidates = types.flatMap((type) => {
    const aliases = [type.name, ...type.aliases].filter(Boolean);
    return aliases.map((alias) => ({ type, alias, length: normalizedPhrase(alias).length }));
  }).sort((a, b) => b.length - a.length);
  return candidates.find((candidate) => phraseFound(text, candidate.alias))?.type;
}

function extractNumericTokens(text: string): string[] {
  return text.match(/\d+(?:\.\d+)?(?:\s*[kKmMrR]\s*\d+|\s*[kKmMrR])?(?:\s*(?:Ω|ohms?|ohm))?/gi) ?? [];
}

function parsedValues(type: PartType, text: string): Record<string, FieldValue> {
  const values: Record<string, FieldValue> = {};
  const source = normalizedPhrase(text);
  const module = type.mapping.kind === "module" || type.mapping.kind === "modelled" ? type.mapping.module : undefined;
  if (module === "resistor" || module === "potentiometer" || type.fields.some((item) => item.key === "ohms")) {
    const ohms = extractNumericTokens(text).map(ohmsFromText).find((item): item is number => item !== undefined);
    if (ohms !== undefined && type.fields.some((item) => item.key === "ohms")) values.ohms = ohms;
  }
  for (const item of type.fields) {
    if (item.key === "color") {
      const option = item.options?.find((candidate) => phraseFound(source, candidate));
      if (option) values[item.key] = option;
    } else if (item.key === "size") {
      const mm = source.match(/\b(\d+)\s*mm\b/);
      const option = mm ? item.options?.find((candidate) => candidate === mm[1]) : undefined;
      if (option) values[item.key] = option;
    } else if (item.key === "capacitanceUf") {
      const match = source.match(/(\d+(?:\.\d+)?)\s*(?:u|µ|μ)f\b/);
      if (match) values[item.key] = Number(match[1]);
    } else if (item.kind === "choice" && item.options) {
      const option = item.options.find((candidate) => phraseFound(source, candidate));
      if (option) values[item.key] = option;
    } else if (item.kind === "number" && item.key === "cells") {
      const match = source.match(/\b(\d+)\s*(?:cell|cells)\b/);
      if (match) values[item.key] = Number(match[1]);
    }
  }
  return values;
}

/** Parse comma/newline/semicolon-separated typed inventory text without an AI call. */
export function parsePartsText(text: string, types: PartType[]): ParsedPartLine[] {
  return text
    .split(/[\n,;]+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((line): ParsedPartLine => {
      let remainder = line;
      let quantity = 1;
      const countMatch = remainder.match(/^\s*(?:(\d+)|([a-z]+))(?:\s*x\b|\s+|\b)/i);
      if (countMatch) {
        const numeric = countMatch[1] ? Number(countMatch[1]) : NUMBER_WORDS[countMatch[2]!.toLowerCase()];
        if (numeric !== undefined) {
          quantity = positiveCount(numeric);
          remainder = remainder.slice(countMatch[0].length).trim();
        }
      }
      const type = findType(remainder, types);
      if (!type) return { text: line, typeId: null, values: {}, quantity, status: "unknown" };
      const values = parsedValues(type, remainder);
      const missingRequired = type.fields.some((item) => item.required && values[item.key] === undefined);
      return {
        text: line,
        typeId: type.id,
        values,
        quantity,
        status: missingRequired ? "needs-look" : "ready",
      };
    });
}

function paramsFor(type: PartType, entry: InventoryEntry, mapping: Extract<PartType["mapping"], { kind: "module" | "modelled" }>): Record<string, unknown> {
  const params: Record<string, unknown> = { ...(mapping.fixed ?? {}) };
  for (const [param, fieldKey] of Object.entries(mapping.params ?? {})) {
    const value = entry.values[fieldKey];
    if (value !== undefined) params[param] = value;
  }
  return params;
}

function stableParams(value: Record<string, unknown> | undefined): string {
  return JSON.stringify(canonicalValue(value ?? {}));
}

/** Copy ready catalog entries into the mission's library inventory and notes. */
export function toMissionInventory(entries: InventoryEntry[], types: PartType[]): { items: InventoryItem[]; notes: string[] } {
  const items: InventoryItem[] = [];
  const notes: string[] = [];
  const byType = new Map(types.map((type) => [type.id, type]));
  const merged = new Map<string, InventoryItem>();

  for (const entry of entries) {
    if (entry.status !== "ready" || entry.quantity <= 0) continue;
    const type = byType.get(entry.typeId);
    if (!type) continue;
    const mapping = type.mapping;
    if (mapping.kind === "note") {
      notes.push(`also owns ${entry.quantity} ${type.name} — ViBread can't design with it`);
      continue;
    }
    if (mapping.kind === "setting") continue;

    let item: InventoryItem;
    if (mapping.kind === "generic") {
      item = {
        module: "generic",
        count: entry.quantity,
        params: { role: mapping.role, description: type.description },
        label: type.name,
        ...(type.pinout ? { pinout: type.pinout.map((pin) => ({ ...pin })) } : {}),
      };
    } else {
      const params = paramsFor(type, entry, mapping);
      item = {
        module: mapping.module,
        count: entry.quantity,
        ...(Object.keys(params).length ? { params } : {}),
        ...(mapping.kind === "modelled" ? { label: `${type.name} (modelled as ${MODULES[mapping.module].name})` } : {}),
      };
    }

    const mergeKey = `${item.module}|${stableParams(item.params)}`;
    const previous = merged.get(mergeKey);
    if (previous) previous.count += item.count;
    else {
      merged.set(mergeKey, item);
      items.push(item);
    }
  }

  return { items, notes };
}

