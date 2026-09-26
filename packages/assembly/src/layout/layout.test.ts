import { describe, expect, it } from "vitest";

import { GOLDEN } from "@vibread/fixtures";
import type { Layout } from "@vibread/core";

import { assemblyReport, buildSteps, layoutBoard, layoutHash, lvs } from "./index.js";
import { renderBreadboardSvg } from "./svg.js";

function issueKinds(circuit: (typeof GOLDEN)[number]["circuit"], layout: Layout): string[] {
  return [...new Set(lvs(circuit, layout).issues.map((issue) => issue.kind))].sort();
}

describe("deterministic breadboard layout", () => {
  it("keeps every golden design LVS-clean and FAO GO", () => {
    for (const design of GOLDEN) {
      const layout = layoutBoard(design.circuit);
      const result = lvs(design.circuit, layout);
      expect(result.ok, design.key).toBe(true);
      const report = assemblyReport({ circuit: design.circuit, layout, lvs: result, revisionHash: "test" });
      expect(report.verdict, design.key).toBe("GO");
      expect(report.summary, design.key).toBe("The breadboard fits and LVS is clean.");
    }
  });

  it("reports the exact topology mutant kinds", () => {
    const circuit = GOLDEN.find((design) => design.key === "moon-phase-lamp")!.circuit;
    const clean = layoutBoard(circuit);

    const moved = structuredClone(clean);
    moved.placements.find((placement) => placement.part === "R1")!.pins["1"] = "a63";
    expect(issueKinds(circuit, moved)).toEqual(["split-net"]);

    const missing = structuredClone(clean);
    missing.jumpers.splice(missing.jumpers.findIndex((jumper) => "board" in jumper.from && jumper.from.board === "D3"), 1);
    expect(issueKinds(circuit, missing)).toEqual(["split-net"]);

    const merged = structuredClone(clean);
    merged.placements.find((placement) => placement.part === "R1")!.pins["1"] = "b15";
    expect(issueKinds(circuit, merged)).toEqual(["merged-nets", "split-net"]);

    const shorted = structuredClone(clean);
    shorted.jumpers.push({ id: "WX", from: { hole: "T+2" }, to: { hole: "T-2" }, color: "red", net: "5V" });
    expect(issueKinds(circuit, shorted)).toEqual(["merged-nets", "power-short"]);
  });

  it("builds the safe plug-state order and fits moon phase on bb-400", () => {
    const moon = GOLDEN.find((design) => design.key === "moon-phase-lamp")!.circuit;
    const layout = layoutBoard(moon);
    expect(layout.jumpers.length).toBeLessThanOrEqual(16);
    const steps = buildSteps(moon, layout);
    expect(steps.steps.every((step) => step.plug === "unplugged" || step.plug === "plugged")).toBe(true);
    expect(steps.steps.slice(0, 6).map((step) => step.kind)).toEqual(["inventory", "orientation", "unplug", "rails", "checkpoint", "unplug"]);
    expect(steps.steps[4].plug).toBe("plugged");
    expect(steps.steps[4].checkpoint?.tests).toEqual(["rails.vcc"]);
    expect(steps.steps[4].text).toContain("ViBread checks that the red + rail has 5 V");
    expect(steps.steps[4].text).not.toContain("rails.vcc");
    expect(steps.steps.at(-1)?.kind).toBe("power-up");
    expect(steps.steps.at(-1)?.plug).toBe("plugged");

    expect(steps.steps[1].text).toContain("Rows run left to right");
    const resistorStep = steps.steps.find((step) => step.title.startsWith("Insert R1"))!;
    expect(resistorStep.text).toMatch(/220 Ω resistor R1 \(red-red-brown-gold\) from hole e\d+ to hole e\d+/);
    const jumperStep = steps.steps.find((step) => step.kind === "jumper" && step.title.includes("W2"))!;
    expect(jumperStep.text).toContain("Connect a yellow wire from Arduino A0 header pin to hole f3");
    const half = { ...moon, breadboard: { profile: "bb-400" as const } };
    const halfLayout = layoutBoard(half);
    expect(lvs(half, halfLayout).ok).toBe(true);
  });
  it("focuses a step around every new hole", () => {
    const moon = GOLDEN.find((design) => design.key === "moon-phase-lamp")!.circuit;
    const layout = layoutBoard(moon);
    const steps = buildSteps(moon, layout);
    const step = steps.steps[6];
    const svg = renderBreadboardSvg({ circuit: moon, layout, steps, upToStep: step.n, focus: true });
    const box = svg.match(/viewBox="([^"]+)"/)?.[1].split(/\s+/).map(Number);
    expect(box).toHaveLength(4);
    const [x, y, width, height] = box!;
    for (const hole of step.holes) {
      const point = svg.match(new RegExp(`id="hole-${hole}"[^>]*cx="([\\d.]+)"[^>]*cy="([\\d.]+)"`));
      expect(point, hole).not.toBeNull();
      const px = Number(point?.[1]);
      const py = Number(point?.[2]);
      expect(px).toBeGreaterThanOrEqual(x);
      expect(px).toBeLessThanOrEqual(x + width);
      expect(py).toBeGreaterThanOrEqual(y);
      expect(py).toBeLessThanOrEqual(y + height);
    }
  });
  it("scopes breadboard CSS to the drawing root", () => {
    const moon = GOLDEN.find((design) => design.key === "moon-phase-lamp")!.circuit;
    const svg = renderBreadboardSvg({ circuit: moon, layout: layoutBoard(moon) });
    const style = svg.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? "";
    expect(style).not.toMatch(/(?:^|[},])\s*(?:svg|g|circle|text)\s*\{/m);
    expect(style).toContain('svg[data-vibread="breadboard"]');
  });
});
