import type { DiagnosisCandidate } from "@vibread/core";

export interface SvgHighlight {
  holes: string[];
  parts: string[];
  jumpers: string[];
}

function idFor(kind: "hole" | "part" | "wire", value: string): string {
  return `${kind}-${value}`;
}

function escapeAttribute(value: string): string {
  return value.replace(/[&<>\"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character);
}

/**
 * Apply highlights and LED state without re-rendering an SVG artifact as JSX.
 * DOMParser is used in the browser; the regex path keeps tests and SSR safe.
 */
export function decorateBreadboardSvg(svg: string, highlight: SvgHighlight = { holes: [], parts: [], jumpers: [] }, partStates: Record<string, number> = {}): string {
  if (typeof DOMParser !== "undefined" && typeof XMLSerializer !== "undefined") {
    const document = new DOMParser().parseFromString(svg, "image/svg+xml");
    const root = document.documentElement;
    const ids = [
      ...highlight.holes.map((value) => idFor("hole", value)),
      ...highlight.parts.map((value) => idFor("part", value)),
      ...highlight.jumpers.map((value) => idFor("wire", value)),
    ];
    for (const id of ids) document.getElementById(id)?.classList.add("vb-hl");
    for (const [part, value] of Object.entries(partStates)) {
      const glow = document.getElementById(`glow-${part}`);
      if (glow) glow.setAttribute("opacity", String(Math.max(0, Math.min(1, value))));
    }
    return new XMLSerializer().serializeToString(root);
  }

  let result = svg;
  const highlightedIds = new Set(idsFromHighlight(highlight));
  for (const id of highlightedIds) {
    const escaped = escapeAttribute(id);
    const matcher = new RegExp(`(<[^>]*\\bid=["']${escaped}["'][^>]*)(>)`, "g");
    result = result.replace(matcher, (full, prefix: string, close: string) => {
      if (/\bclass=["'][^"']*["']/.test(prefix)) return prefix.replace(/\bclass=["']([^"']*)["']/, (_match, classes: string) => `class="${classes} vb-hl"`) + close;
      return `${prefix} class="vb-hl"${close}`;
    });
  }
  for (const [part, value] of Object.entries(partStates)) {
    const escaped = escapeAttribute(`glow-${part}`);
    const matcher = new RegExp(`(<[^>]*\\bid=["']${escaped}["'][^>]*\\bopacity=["'])[^"']*(["'])`, "g");
    result = result.replace(matcher, (_full, prefix: string, close: string) => `${prefix}${Math.max(0, Math.min(1, value))}${close}`);
  }
  return result;
}

function idsFromHighlight(highlight: SvgHighlight): string[] {
  return [
    ...highlight.holes.map((value) => idFor("hole", value)),
    ...highlight.parts.map((value) => idFor("part", value)),
    ...highlight.jumpers.map((value) => idFor("wire", value)),
  ];
}

export function candidateHighlight(candidate: DiagnosisCandidate | undefined): SvgHighlight {
  return candidate?.highlight ?? { holes: [], parts: [], jumpers: [] };
}

/** Minimal artifact used while an older server has not rendered breadboard.svg yet. */
export function fallbackBreadboardSvg(parts: string[], states: Record<string, number> = {}): string {
  const width = 840;
  const rows = Math.max(5, Math.ceil(parts.length / 4));
  const height = 180 + rows * 66;
  const groups = parts.map((part, index) => {
    const x = 80 + (index % 4) * 185;
    const y = 100 + Math.floor(index / 4) * 66;
    const glow = Math.max(0, Math.min(1, states[part] ?? 0));
    return `<g id="part-${escapeAttribute(part)}"><circle id="glow-${escapeAttribute(part)}" cx="${x}" cy="${y}" r="18" fill="#ffd54f" opacity="${glow}"/><rect x="${x - 24}" y="${y - 24}" width="48" height="48" rx="8" fill="#26364f" stroke="#8ea4c6"/><text x="${x}" y="${y + 5}" text-anchor="middle" fill="#fff" font-size="12">${escapeAttribute(part)}</text></g>`;
  }).join("");
  const holes = Array.from({ length: Math.max(20, rows * 8) }, (_, index) => {
    const x = 54 + (index % 10) * 80;
    const y = 155 + Math.floor(index / 10) * 28;
    return `<circle id="hole-e${index + 1}" cx="${x}" cy="${y}" r="4" fill="#b7c7dd"/>`;
  }).join("");
  return `<svg data-vibread="breadboard" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Virtual breadboard"><rect width="100%" height="100%" rx="18" fill="#16243b"/><text x="32" y="44" fill="#e7f0ff" font-size="21">Virtual breadboard · simulated telemetry</text>${groups}${holes}</svg>`;
}
