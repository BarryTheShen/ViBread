import { describe, expect, it } from "vitest";
import { GOLDEN } from "@vibread/fixtures";
import { layoutBoard } from "@vibread/assembly/layout";
import { revisionHash, type BenchRunResult } from "@vibread/core";
import { FAULT_IDS, applyFault, planSelfTest, rankFaults } from "./index.js";

const moon = GOLDEN.find((entry) => entry.key === "moon-phase-lamp");
if (moon === undefined) throw new Error("moon-phase-lamp fixture is required");

function observed(cause: string): BenchRunResult {
  return {
    runId: "fault-test",
    revision: 1,
    kind: "selftest",
    results: [],
    calibration: [],
    verdict: "fail",
    diagnosis: {
      attribution: "wiring",
      summary: "fault",
      candidates: [{ cause, title: cause, likelihood: 0.8, highlight: { holes: [], parts: [], jumpers: [] }, fix: "fix" }],
    },
  };
}

describe("shared fault catalog", () => {
  it("applies every catalog mutation to a layout and as-built circuit", () => {
    const layout = layoutBoard(moon.circuit);
    for (const fault of FAULT_IDS) {
      const applied = applyFault({ circuit: moon.circuit, layout, fault });
      expect(applied.description.length, fault).toBeGreaterThan(0);
      expect(applied.circuit.nets.length, fault).toBeGreaterThan(0);
    }
  });

  it("keeps five representative true faults in the top two ranked candidates", () => {
    const layout = layoutBoard(moon.circuit);
    const plan = planSelfTest(moon.circuit, revisionHash(moon.circuit));
    const trueFaults = [
      "button-leg-in-gnd-row",
      "led-jumpers-swapped",
      "divider-resistor-missing",
      "wrong-resistor-value",
      "missing-jumper",
    ] as const;
    for (const fault of trueFaults) {
      const ranked = rankFaults({ circuit: moon.circuit, layout, plan, observed: observed(fault), lines: [] });
      expect(ranked.slice(0, 2).map((candidate) => candidate.cause), fault).toContain(fault);
    }
  });
});
