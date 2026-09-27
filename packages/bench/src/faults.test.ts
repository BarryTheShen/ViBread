import { describe, expect, it } from "vitest";
import { GOLDEN } from "@vibread/fixtures";
import { asBuiltCircuit, layoutBoard } from "@vibread/assembly/layout";
import { revisionHash, type BenchRunResult, type Circuit, type DeviceLine, type Layout } from "@vibread/core";
import { FAULT_IDS, applyFault, evaluateRun, planSelfTest, rankFaults } from "./index.js";

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

function netPartition(circuit: Circuit, layout: Layout): string[] {
  return asBuiltCircuit(circuit, layout).nets.map((net) => net.pins.map((ref) => `${ref.part}.${ref.pin}`).sort().join(" ")).sort();
}

describe("shared fault catalog", () => {
  it("applies every catalog mutation that fits the moon layout", () => {
    const layout = layoutBoard(moon.circuit);
    for (const fault of FAULT_IDS.filter((id) => id !== "button-rotated-90")) {
      const applied = applyFault({ circuit: moon.circuit, layout, fault });
      expect(applied.description.length, fault).toBeGreaterThan(0);
      expect(applied.circuit.nets.length, fault).toBeGreaterThan(0);
    }
  });

  it("only injects wiring faults that change a golden's as-built connections", () => {
    for (const golden of GOLDEN) {
      const layout = layoutBoard(golden.circuit);
      const base = netPartition(golden.circuit, layout);
      for (const fault of FAULT_IDS.filter((id) => id !== "wrong-resistor-value")) {
        let applied;
        try {
          applied = applyFault({ circuit: golden.circuit, layout, fault });
        } catch {
          continue;
        }
        expect(netPartition(golden.circuit, applied.layout), `${golden.key} ${fault}`).not.toEqual(base);
      }
    }
  });

  it("injects a moved lead on the button designs, but no rotation when D2 and GND sit on opposite channel halves", () => {
    for (const key of ["moon-phase-lamp", "launch-control"]) {
      const golden = GOLDEN.find((entry) => entry.key === key);
      if (golden === undefined) throw new Error(`${key} fixture is required`);
      const layout = layoutBoard(golden.circuit);
      expect(() => applyFault({ circuit: golden.circuit, layout, fault: "moved-lead" }), key).not.toThrow();
      expect(() => applyFault({ circuit: golden.circuit, layout, fault: "button-rotated-90" }), key).toThrow(/not applicable/);
    }
  });

  it("injects the rotation when the button's GND wiring shares the signal side of the channel", () => {
    const layout = layoutBoard(moon.circuit);
    const button = layout.placements.find((placement) => placement.part === "BTN1");
    const signal = layout.jumpers.find((jumper) => jumper.net === "D2");
    const ground = layout.jumpers.find((jumper) => "hole" in jumper.to && jumper.to.hole === button?.pins["3"].replace(/^e/, "a"));
    if (button === undefined || signal === undefined || ground === undefined || !("hole" in signal.to) || !("hole" in ground.to)) throw new Error("moon layout no longer wires BTN1 as e/f straddle with a GND jumper in column a");
    // Put the GND jumper on the same (f–j) half as the D2 jumper: a 90° turn now ties D2 to GND permanently.
    ground.to = { hole: ground.to.hole.replace(/^a/, "j") };
    const applied = applyFault({ circuit: moon.circuit, layout, fault: "button-rotated-90" });
    const d2 = applied.circuit.nets.find((net) => net.pins.some((ref) => ref.part === "board" && ref.pin === "D2"));
    expect(d2?.pins.some((ref) => ref.part === "board" && ref.pin === "GND")).toBe(true);
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
  it("penalizes dictionary mutants that pass or fail a different test", () => {
    const layout = layoutBoard(moon.circuit);
    const plan = planSelfTest(moon.circuit, revisionHash(moon.circuit));
    const observedRun: BenchRunResult = {
      ...observed("led-jumpers-swapped"),
      results: [{ test: "led.sequence", status: "fail", subjects: [], summary: "LED mismatch" }],
    };
    const predicted = (fault: "led-jumpers-swapped" | "output-jumper-in-rail-row" | "wrong-resistor-value", verdict: BenchRunResult["verdict"], test: BenchRunResult["results"][number]["test"], status: BenchRunResult["results"][number]["status"]) => {
      const applied = applyFault({ circuit: moon.circuit, layout, fault });
      return { fault, layoutHash: "mutant", description: fault, layout: applied.layout, circuit: applied.circuit, lines: [], answers: {}, result: { ...observedRun, runId: fault, verdict, results: [{ test, status, subjects: [], summary: fault }] } };
    };
    const dictionary = {
      layoutHash: "base",
      design: plan.design,
      entries: [
        predicted("led-jumpers-swapped", "fail", "led.sequence", "fail"),
        predicted("output-jumper-in-rail-row", "pass", "led.sequence", "pass"),
        predicted("wrong-resistor-value", "fail", "button.interactive", "fail"),
      ],
    };
    const ranked = rankFaults({ circuit: moon.circuit, layout, plan, observed: observedRun, lines: [], dictionary });
    expect(ranked[0]?.cause).toBe("led-jumpers-swapped");
    expect(ranked[0]?.likelihood).toBeGreaterThan(ranked[1]?.likelihood ?? 0);
  });
  it("puts an output rail short first and highlights its jumper without a drive fix", async () => {
    const layout = layoutBoard(moon.circuit);
    const plan = planSelfTest(moon.circuit, revisionHash(moon.circuit));
    const result = await evaluateRun({
      circuit: moon.circuit,
      layout,
      plan,
      lines: [
        { t: "hello", fw: "vibread-bench", proto: 1, design: plan.design, board: plan.board },
        { t: "vcc", mv: 5000 },
        { t: "begin", test: "pins.readonly" },
        { t: "read", pin: "D2", pull: 1, ones: 32, n: 32 },
        { t: "stuck", pin: "D3", level: 1 },
        { t: "end", test: "pins.readonly", status: "fail" },
      ],
      answers: {},
      kind: "selftest",
      revision: 1,
      runId: "output-rail",
    });
    expect(result.diagnosis.candidates[0]?.cause).toBe("output-jumper-in-rail-row");
    expect(result.diagnosis.candidates[0]?.highlight.holes.length).toBeGreaterThan(0);
    expect(result.diagnosis.candidates[0]?.fix.toLowerCase()).not.toContain("drive");
  });
  it("treats a real person's none answer as a missing LED", async () => {
    const layout = layoutBoard(moon.circuit);
    const plan = planSelfTest(moon.circuit, revisionHash(moon.circuit));
    const lines: DeviceLine[] = [
      { t: "hello", fw: "vibread-bench", proto: 1, design: plan.design, board: plan.board },
      { t: "vcc", mv: 5000 },
      { t: "begin", test: "led.sequence" },
      ...[1, 2, 3, 4].map((order) => ({ t: "ask" as const, id: `led${order}`, test: "led.sequence" as const, kind: "which-led" as const, part: `LED${order}`, choices: ["1", "2", "3", "4", "none"], timeoutMs: 20_000 })),
      { t: "end", test: "led.sequence", status: "fail" as const },
    ];
    const result = await evaluateRun({
      circuit: moon.circuit,
      layout,
      plan,
      lines,
      answers: { led1: "none", led2: "2", led3: "3", led4: "4" },
      kind: "selftest",
      revision: 1,
      runId: "missing-led",
    });
    expect(result.diagnosis.candidates[0]?.cause).toBe("led-missing");
    expect(result.diagnosis.candidates[0]?.highlight.holes.length).toBeGreaterThan(0);
  });
  it("does not suggest a fix for an incomplete prompt timeout", async () => {
    const plan = planSelfTest(moon.circuit, revisionHash(moon.circuit));
    const result = await evaluateRun({
      circuit: moon.circuit,
      plan,
      lines: [{ t: "ask", id: "btn0-press", test: "button.interactive", kind: "press-hold", part: "BTN1", choices: ["done"], timeoutMs: 20_000 }],
      answers: {},
      kind: "selftest",
      revision: 1,
      runId: "timeout",
    });
    expect(result.verdict).toBe("incomplete");
    expect(result.diagnosis.attribution).toBe("none");
    expect(result.diagnosis.candidates).toHaveLength(0);
    expect(result.diagnosis.summary).toContain("Nobody answered 'Press the button' in time");
  });
});
