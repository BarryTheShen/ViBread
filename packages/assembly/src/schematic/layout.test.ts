import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parseCircuit, type Circuit } from "@vibread/core";
import { GOLDEN } from "@vibread/fixtures";
import { renderSchematicSvg } from "./index.js";

type Box = { left: number; top: number; right: number; bottom: number };
type Label = Box & { text: string; className: string };
type Segment = { x1: number; y1: number; x2: number; y2: number };

function attrs(raw: string): Record<string, string> {
  const output: Record<string, string> = {};
  for (const match of raw.matchAll(/([\w-]+)="([^"]*)"/g)) output[match[1]] = match[2];
  return output;
}

function textOf(raw: string): string {
  return raw.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();
}

function labelBoxes(svg: string): { viewBox: Box; labels: Label[] } {
  const root = svg.match(/<svg\b([^>]*)>/)?.[1];
  if (!root) throw new Error("schematic SVG has no root");
  const rootAttrs = attrs(root);
  const view = (rootAttrs.viewBox ?? "0 0 1800 1100").split(/\s+/).map(Number);
  const viewBox: Box = { left: view[0], top: view[1], right: view[0] + view[2], bottom: view[1] + view[3] };
  const labels: Label[] = [];
  for (const match of svg.matchAll(/<text\b([^>]*)>([\s\S]*?)<\/text>/g)) {
    const a = attrs(match[1]);
    const text = textOf(match[2]);
    if (!text) continue;
    const x = Number(a.x ?? 0);
    const y = Number(a.y ?? 0);
    const fontSize = Number((a["font-size"] ?? "12").replace("px", ""));
    const width = Math.max(fontSize * 0.6, text.length * fontSize * 0.52);
    const height = fontSize * 1.15;
    let left = x;
    if (a["text-anchor"] === "middle") left -= width / 2;
    if (a["text-anchor"] === "end") left -= width;
    let box: Box = { left, top: y - height * 0.8, right: left + width, bottom: y + height * 0.2 };
    const rotation = a.transform?.match(/rotate\((-?\d+)/)?.[1];
    if (rotation && Math.abs(Number(rotation)) % 180 === 90) {
      const centerX = (box.left + box.right) / 2;
      const centerY = (box.top + box.bottom) / 2;
      box = { left: centerX - height / 2, top: centerY - width / 2, right: centerX + height / 2, bottom: centerY + width / 2 };
    }
    labels.push({ ...box, text, className: a.class ?? "" });
  }
  return { viewBox, labels };
}

function traceSegments(svg: string): Segment[] {
  const segments: Segment[] = [];
  for (const match of svg.matchAll(/<path\b([^>]*)class="[^"]*sch-trace-path[^"]*"[^>]*>/g)) {
    const path = attrs(match[1]).d ?? "";
    const numbers = [...path.matchAll(/-?\d+(?:\.\d+)?/g)].map((value) => Number(value[0]));
    for (let index = 2; index < numbers.length; index += 2) {
      segments.push({ x1: numbers[index - 2], y1: numbers[index - 1], x2: numbers[index], y2: numbers[index + 1] });
    }
  }
  return segments;
}

function intersects(a: Box, b: Box, padding = 0): boolean {
  return a.left < b.right - padding && b.left < a.right - padding && a.top < b.bottom - padding && b.top < a.bottom - padding;
}

function distanceToSegment(x: number, y: number, segment: Segment): number {
  const dx = segment.x2 - segment.x1;
  const dy = segment.y2 - segment.y1;
  if (dx === 0 && dy === 0) return Math.hypot(x - segment.x1, y - segment.y1);
  const t = Math.max(0, Math.min(1, ((x - segment.x1) * dx + (y - segment.y1) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - (segment.x1 + t * dx), y - (segment.y1 + t * dy));
}

function assertLayout(svg: string, title: string): void {
  const { viewBox, labels } = labelBoxes(svg);
  const margin = 1;
  expect(labels.length, `${title}: expected text labels`).toBeGreaterThan(10);
  for (const label of labels) {
    expect(label.left, `${title}: ${label.text} left-clipped`).toBeGreaterThanOrEqual(viewBox.left - margin);
    expect(label.top, `${title}: ${label.text} top-clipped`).toBeGreaterThanOrEqual(viewBox.top - margin);
    expect(label.right, `${title}: ${label.text} right-clipped`).toBeLessThanOrEqual(viewBox.right + margin);
    expect(label.bottom, `${title}: ${label.text} bottom-clipped`).toBeLessThanOrEqual(viewBox.bottom + margin);
  }
  for (let first = 0; first < labels.length; first += 1) {
    for (let second = first + 1; second < labels.length; second += 1) {
      const a = labels[first];
      const b = labels[second];
      expect(intersects(a, b, 0.5), `${title}: labels overlap: ${a.text} / ${b.text}`).toBe(false);
    }
  }
  const segments = traceSegments(svg);
  for (const label of labels) {
    if (label.className.includes("sch-pin-") || label.className.includes("sch-net-label")) continue;
    const centerX = (label.left + label.right) / 2;
    const centerY = (label.top + label.bottom) / 2;
    const onWire = segments.some((segment) => distanceToSegment(centerX, centerY, segment) < Math.max(2, (label.bottom - label.top) * 0.3));
    expect(onWire, `${title}: ${label.text} overlaps an unrelated wire`).toBe(false);
  }
}

function field(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return undefined;
  return (value as Record<string, unknown>)[key];
}

async function recordedCircuit(): Promise<Circuit> {
  const raw = JSON.parse(await readFile(new URL("../../../../fixtures/recorded/moon-phase-lamp.2026-09-26.json", import.meta.url), "utf8")) as unknown;
  const design = field(raw, "design");
  const steps = field(design, "steps");
  const firstStep = Array.isArray(steps) ? steps[0] : undefined;
  const input = field(firstStep, "input");
  const parsed = parseCircuit(field(input, "circuit"));
  if (!parsed.ok) throw new Error(`recorded circuit invalid: ${parsed.issues.map((issue) => issue.message).join("; ")}`);
  return parsed.circuit;
}

describe("schematic SVG geometry", () => {
  it("keeps labels inside the viewBox and clear of unrelated geometry for all designs", async () => {
    const recorded = await recordedCircuit();
    const circuits = [...GOLDEN.map((fixture) => fixture.circuit), recorded];
    for (const circuit of circuits) assertLayout(await renderSchematicSvg(circuit), circuit.title);
  });
});
