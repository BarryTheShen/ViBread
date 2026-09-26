/**
 * Placement summary (issue #16): where each part sits, and whether each placement group the circuit asks for is
 * really side by side. Computed from the finished layout alone, so it is the truth the design agent must describe.
 *
 * A group is side by side when all its parts are placed, every part that sits on one half of the board shares that
 * half (a button straddling the channel counts as both), every part is within GROUP_GAP rows of the group's first
 * listed part (its anchor: "each light next to its button" lists the button first), no part of another group lies
 * inside it, and it starts to the right of the group listed before it.
 */
import { parseHole, type Circuit, type Layout, type PlacementSummary } from "@vibread/core";

/** Largest row gap between a grouped part and its group's anchor. */
export const GROUP_GAP = 4;

type Side = PlacementSummary["parts"][number]["side"];

export function partExtent(pins: Record<string, string>): { rows: [number, number]; side: Side } | undefined {
  const rows: number[] = [];
  const halves = new Set<"a-e" | "f-j">();
  for (const hole of Object.values(pins)) {
    const parsed = parseHole(hole);
    if (parsed?.kind !== "terminal") continue;
    rows.push(parsed.row);
    halves.add("abcde".includes(parsed.column) ? "a-e" : "f-j");
  }
  if (rows.length === 0) return undefined;
  return { rows: [Math.min(...rows), Math.max(...rows)], side: halves.size > 1 ? "both" : [...halves][0]! };
}

function rowText([from, to]: [number, number]): string {
  return from === to ? `row ${from}` : `rows ${from}–${to}`;
}

function sideText(side: Side): string {
  return side === "both" ? "across the centre channel" : side === "a-e" ? "top half (a–e)" : "bottom half (f–j)";
}

export function placementSummary(circuit: Circuit, layout: Layout): PlacementSummary {
  const parts: PlacementSummary["parts"] = [];
  for (const placement of [...layout.placements].sort((a, b) => a.part.localeCompare(b.part))) {
    const extent = partExtent(placement.pins);
    if (extent) parts.push({ part: placement.part, ...extent });
  }
  const byPart = new Map(parts.map((entry) => [entry.part, entry]));
  const requested = circuit.placement?.groups ?? [];
  const spans = requested.map((group) => {
    const placed = group.map((id) => byPart.get(id)).filter((entry) => entry !== undefined);
    return placed.length === 0 ? undefined : ([Math.min(...placed.map((entry) => entry.rows[0])), Math.max(...placed.map((entry) => entry.rows[1]))] as [number, number]);
  });
  const groups: PlacementSummary["groups"] = requested.map((group, index) => {
    const name = group.join("+");
    const placed = group.map((id) => byPart.get(id));
    const missing = group.filter((_, position) => placed[position] === undefined);
    if (missing.length > 0) return { parts: group, met: false, detail: `${missing.join(", ")} not placed` };
    const entries = placed as NonNullable<(typeof placed)[number]>[];
    const span = spans[index]!;
    const halves = new Set(entries.filter((entry) => entry.side !== "both").map((entry) => entry.side));
    const problems: string[] = [];
    if (halves.size > 1) problems.push(`split across both halves of the board (${entries.filter((entry) => entry.side !== "both").map((entry) => `${entry.part} ${entry.side}`).join(", ")})`);
    const anchor = entries[0]!;
    for (const entry of entries.slice(1)) {
      const gap = Math.max(entry.rows[0] - anchor.rows[1], anchor.rows[0] - entry.rows[1], 0);
      if (gap > GROUP_GAP) problems.push(`${entry.part} is ${gap} rows away from ${anchor.part}`);
    }
    const intruders = parts.filter((entry) => !group.includes(entry.part) && requested.some((other, otherIndex) => otherIndex !== index && other.includes(entry.part)) && entry.rows[0] <= span[1] && entry.rows[1] >= span[0]);
    if (intruders.length > 0) problems.push(`${intruders.map((entry) => entry.part).join(", ")} from another group sits between its parts`);
    const previous = spans[index - 1];
    if (index > 0 && previous && span[0] <= previous[1]) problems.push(`not to the right of group ${requested[index - 1]!.join("+")}`);
    const half = halves.size === 1 ? sideText([...halves][0]!) : "across the centre channel";
    return problems.length === 0
      ? { parts: group, met: true, detail: `${name} side by side, ${rowText(span)}, ${half}` }
      : { parts: group, met: false, detail: `${name} not side by side: ${problems.join("; ")}` };
  });
  const text = [
    parts.map((entry) => `${entry.part} ${rowText(entry.rows)} ${entry.side === "both" ? "(across the channel)" : `(${entry.side})`}`).join(" · "),
    ...groups.map((group) => `Group ${group.detail}.`),
  ].filter(Boolean).join("\n");
  return { parts, groups, text: `Rows are numbered left to right. ${text}` };
}
