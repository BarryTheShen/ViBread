import { CIRCUIT_SCHEMA, type Circuit } from "@vibread/core";
import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { bundlePlan, buildZip, otherFiles, sketchName, stepPictureCount } from "./downloads.js";

const circuit: Circuit = {
  schema: CIRCUIT_SCHEMA,
  title: "Launch Control",
  summary: "",
  board: { profile: "uno-r3-atmega328p-5v" },
  breadboard: { profile: "bb-830" },
  parts: [
    { id: "BTN1", module: "button", label: "ARM button", params: {} },
    { id: "BZ1", module: "buzzer-active", label: "Liftoff buzzer", params: {} },
  ],
  nets: [],
  roles: [],
  sketch: { source: "void setup() {}\nvoid loop() {}\n" },
  intent: [],
  assumptions: [],
};
const keys = ["breadboard.svg", "schematic.svg", "schematic.png", "app.hex", "bench.hex", "faults.json", "trace-T1.json", "photo-step-3.jpg"];
for (let n = 1; n <= 11; n += 1) keys.push(`step-${n}.svg`, `step-${n}.png`, `step-${n}-focus.png`);

describe("sketchName", () => {
  it("makes a name the Arduino IDE accepts for the sketch and its folder", () => {
    expect(sketchName("Launch Control")).toBe("launch-control");
    expect(sketchName("  Moon-Phase Lamp (recorded run)!")).toBe("moon-phase-lamp-recorded-run");
    expect(sketchName("Café lamp — v2")).toBe("cafe-lamp-v2");
    expect(sketchName("💡")).toBe("sketch");
  });
});

describe("download bundles", () => {
  it("Everything: the sketch inside a same-named folder, compiled HEX, drawings, parts list and one picture per step", async () => {
    const plan = bundlePlan("everything", "launch-control", 2, circuit, keys);
    expect(plan.fileName).toBe("launch-control-r2.zip");
    const zip = await buildZip(plan.entries, async (key) => new TextEncoder().encode(`bytes of ${key}`));
    const files = unzipSync(zip);
    const paths = Object.keys(files).sort();
    expect(paths.slice(0, 6)).toEqual([
      "launch-control-r2/breadboard.svg",
      "launch-control-r2/launch-control.hex",
      "launch-control-r2/launch-control/launch-control.ino",
      "launch-control-r2/parts-list.txt",
      "launch-control-r2/schematic.svg",
      "launch-control-r2/steps/step-01.png",
    ]);
    expect(paths.filter((p) => p.includes("/steps/"))).toHaveLength(11);
    expect(paths.at(-1)).toBe("launch-control-r2/steps/step-11.png");
    expect(strFromU8(files["launch-control-r2/launch-control/launch-control.ino"])).toBe(circuit.sketch.source);
    expect(strFromU8(files["launch-control-r2/launch-control.hex"])).toBe("bytes of app.hex");
    expect(strFromU8(files["launch-control-r2/parts-list.txt"])).toContain("BZ1    Buzzer (active) — Liftoff buzzer");
    // Focus crops, bench firmware and diagnostics stay out of the everyday bundle.
    expect(paths.some((p) => /focus|bench|trace|faults/.test(p))).toBe(false);
  });

  it("step pictures fall back to the SVG when a step has no PNG; diagnostics go in their own zip", async () => {
    expect(stepPictureCount(keys)).toBe(11);
    const svgOnly = bundlePlan("steps", "lamp", 1, circuit, ["step-2.svg", "step-10.svg", "step-10.png"]);
    expect(svgOnly.entries.map((e) => e.path)).toEqual(["lamp-r1-steps/step-02.svg", "lamp-r1-steps/step-10.png"]);
    expect(otherFiles(keys).sort()).toEqual(["faults.json", "photo-step-3.jpg", "trace-T1.json"]);
    expect(bundlePlan("other", "lamp", 1, circuit, keys).fileName).toBe("lamp-r1-reports.zip");
  });
});
