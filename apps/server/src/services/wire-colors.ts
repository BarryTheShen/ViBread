/**
 * Builder wire-colour overrides (issue #15). Stored as `build.wire-color` timeline events per revision (last write
 * wins), so they survive reloads and show in the timeline; folded into BuildState and every picture on read.
 */
import { hashJson, isWireColorValue, type BuildState, type Revision, type TimelineEvent, type WireColorRequest } from "@vibread/core";
import { buildSteps, jumperColors, netColors, wireLegend, type WireColorOverrides } from "@vibread/assembly/layout";

export const WIRE_COLOR_EVENT = "build.wire-color";

interface WireColorEventData {
  key: string;
  color: string | null;
  /** Single-wire choices a whole-net change replaces. */
  clears?: string[];
}

function isEventData(value: unknown): value is WireColorEventData {
  if (!value || typeof value !== "object") return false;
  const data = value as Record<string, unknown>;
  return typeof data.key === "string" && (data.color === null || isWireColorValue(data.color)) && (data.clears === undefined || (Array.isArray(data.clears) && data.clears.every((key) => typeof key === "string")));
}

/** "wire:W3" / "net:D2" → colour, from this revision's events in order (null resets). */
export function wireOverrides(events: TimelineEvent[], revision: number): WireColorOverrides {
  const overrides: WireColorOverrides = {};
  for (const event of events) {
    if (event.kind !== WIRE_COLOR_EVENT || event.revision !== revision || !isEventData(event.data)) continue;
    for (const key of event.data.clears ?? []) delete overrides[key];
    if (event.data.color === null) delete overrides[event.data.key];
    else overrides[event.data.key] = event.data.color;
  }
  return overrides;
}

/** Validates a WireColorRequest against the revision; returns the event data or an error message. */
export function wireColorChange(revision: Revision, body: unknown): { data: WireColorEventData; text: string } | { error: string } {
  const request = body as Partial<WireColorRequest> | undefined;
  const layout = revision.results.layout;
  if (!layout) return { error: "This design has no breadboard layout yet." };
  if (request?.revision !== revision.n) return { error: `revision must be ${revision.n}, the design being built` };
  if (request.color !== null && !isWireColorValue(request.color)) return { error: "color must be a kit colour name (red, black, orange, yellow, green, blue, purple, white, brown, gray), a #rrggbb value, or null" };
  const target = request.target as { jumper?: unknown; net?: unknown } | undefined;
  const color = request.color === null ? null : request.color.toLowerCase();
  if (typeof target?.jumper === "string") {
    const jumper = layout.jumpers.find((entry) => entry.id === target.jumper);
    if (!jumper) return { error: `wire ${target.jumper} is not in this layout` };
    return { data: { key: `wire:${jumper.id}`, color }, text: color === null ? `Wire ${jumper.id} back to its suggested colour` : `Wire ${jumper.id} (${jumper.net}) set to ${color}` };
  }
  if (typeof target?.net === "string") {
    const net = revision.circuit.nets.find((entry) => entry.id === target.net);
    if (!net) return { error: `net ${target.net} is not in this design` };
    // A whole-net change replaces earlier single-wire choices on that net, so "whole net" means every wire of it.
    const clears = layout.jumpers.filter((jumper) => jumper.net === net.id).map((jumper) => `wire:${jumper.id}`);
    return { data: { key: `net:${net.id}`, color, clears }, text: color === null ? `Net ${net.id} wires back to their suggested colour` : `Net ${net.id} wires set to ${color}` };
  }
  return { error: "target must be { jumper } or { net }" };
}


function buildUrl(missionId: string, path: string, version: string): string {
  return `/api/missions/${encodeURIComponent(missionId)}/build/${path}?v=${version}`;
}

/** Steps, picture URLs, and wire colours for BuildState, all reflecting the overrides. */
export function withWireColors(
  missionId: string,
  revision: Revision,
  steps: BuildState["steps"],
  overrides: WireColorOverrides,
): Pick<BuildState, "steps" | "wires"> {
  const layout = revision.results.layout;
  if (!layout || steps.length === 0) return { steps };
  const jumpers = jumperColors(revision.circuit, layout, overrides);
  const customized = Object.keys(overrides).length > 0;
  const version = hashJson({ revision: revision.hash, overrides }).slice(0, 12);
  // Text names each wire's colour, so recolouring rewrites it (same structure: steps are a pure function of the layout).
  const rebuilt = customized ? buildSteps(revision.circuit, layout, { wireColors: jumpers }).steps : undefined;
  return {
    steps: steps.map((step) => {
      const fresh = rebuilt?.find((candidate) => candidate.n === step.n);
      return {
        ...step,
        ...(fresh ? { text: fresh.text } : {}),
        svgUrl: buildUrl(missionId, `steps/${step.n}.svg`, version),
        ...(customized
          ? { imageUrl: buildUrl(missionId, `steps/${step.n}.png`, version), focusImageUrl: `${buildUrl(missionId, `steps/${step.n}.png`, version)}&focus=1` }
          : {}),
      };
    }),
    wires: {
      overrides,
      jumpers,
      nets: netColors(revision.circuit, overrides),
      legend: wireLegend(revision.circuit, layout, overrides),
      schematicUrl: buildUrl(missionId, "schematic.svg", version),
    },
  };
}
