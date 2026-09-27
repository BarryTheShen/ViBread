/**
 * Allocator + LVS on every breadboard profile (issue #23): each golden design and the whack-a-mole either fit
 * LVS-clean or fail honestly with LAYOUT-NO-FIT; split rails get a bridge wire; a mini board carries power in strips;
 * part variants use their own footprints.
 */
import { describe, expect, it } from "vitest";

import { GOLDEN } from "@vibread/fixtures";
import { BREADBOARD_PROFILES, BREADBOARD_PROFILE_IDS, CircuitSchema, contactGroup, isRailBridge, parseHole, type BreadboardProfileId, type Circuit, type Layout } from "@vibread/core";

import { LayoutFitError, assemblyReport, layoutBoard, layoutFailureReport, lvs } from "./index.js";

const on = (circuit: Circuit, breadboard: BreadboardProfileId, board: Circuit["board"]["profile"] = circuit.board.profile): Circuit => ({ ...circuit, breadboard: { profile: breadboard }, board: { profile: board } });
const holesOf = (layout: Layout) => layout.jumpers.flatMap((jumper) => [jumper.from, jumper.to]).flatMap((end) => ("hole" in end ? [end.hole] : []));
const board = (pin: string) => ({ part: "board", pin });
const pin = (part: string, id: string) => ({ part, pin: id });

function circuitOf(input: { parts: unknown[]; nets: unknown[]; roles: unknown[]; placement?: unknown }): Circuit {
  return CircuitSchema.parse({
    schema: "vibread.circuit/0.1",
    title: "Profile regression",
    summary: "Allocator profile regression",
    board: { profile: "uno-r3-atmega328p-5v" },
    breadboard: { profile: "bb-830" },
    sketch: { source: "void setup() {}\nvoid loop() {}\n" },
    intent: [{ id: "C1", text: "Regression." }],
    ...input,
  });
}

/** The whack-a-mole from issue #16, each button grouped with its light and resistor. */
function whackAMole(): Circuit {
  const moles = [1, 2, 3];
  return circuitOf({
    parts: [
      ...moles.map((i) => ({ id: `BTN${i}`, module: "button", params: {} })),
      ...moles.map((i) => ({ id: `R${i}`, module: "resistor", params: { ohms: 1000 } })),
      ...moles.map((i) => ({ id: `LED${i}`, module: "led", params: { color: ["red", "yellow", "green"][i - 1] } })),
    ],
    nets: [
      { id: "GND", kind: "ground", pins: [board("GND"), ...moles.map((i) => pin(`BTN${i}`, "3")), ...moles.map((i) => pin(`LED${i}`, "K"))] },
      ...moles.map((i) => ({ id: `D${i + 1}`, kind: "signal", pins: [board(`D${i + 1}`), pin(`BTN${i}`, "1")] })),
      ...moles.map((i) => ({ id: `D${i + 7}`, kind: "signal", pins: [board(`D${i + 7}`), pin(`R${i}`, "1")] })),
      ...moles.map((i) => ({ id: `L${i}`, kind: "signal", pins: [pin(`R${i}`, "2"), pin(`LED${i}`, "A")] })),
    ],
    roles: [
      ...moles.map((i) => ({ pin: `D${i + 1}`, mode: "INPUT_PULLUP", part: `BTN${i}`, purpose: `Button ${i}` })),
      ...moles.map((i) => ({ pin: `D${i + 7}`, mode: "OUTPUT", part: `LED${i}`, purpose: `Mole ${i}` })),
    ],
    placement: { groups: moles.map((i) => [`BTN${i}`, `R${i}`, `LED${i}`]) },
  });
}

const DESIGNS: [string, Circuit][] = [...GOLDEN.map((design) => [design.key, design.circuit] as [string, Circuit]), ["whack-a-mole", whackAMole()]];

/**
 * Lays out and proves the result: LVS-clean and FAO GO; or, when a placement group can't be built on this board, FAO
 * NO-GO on PLACEMENT-UNMET alone (tool-side); or a tool-side LAYOUT-NO-FIT.
 */
function outcome(circuit: Circuit): { layout: Layout } | { unmet: string[] } | { noFit: string } {
  try {
    const layout = layoutBoard(circuit);
    const result = lvs(circuit, layout);
    expect(result.issues.filter((issue) => issue.severity === "error")).toEqual([]);
    const report = assemblyReport({ circuit, layout, lvs: result, revisionHash: "test" });
    const blocking = report.findings.filter((finding) => finding.severity === "error");
    if (report.verdict !== "GO") {
      expect(blocking.map((finding) => [finding.ruleId, finding.toolSide])).toEqual(blocking.map(() => ["PLACEMENT-UNMET", true]));
      expect(circuit.placement?.groups.length ?? 0).toBeGreaterThan(0);
      return { unmet: blocking.map((finding) => finding.detail ?? "") };
    }
    for (const hole of holesOf(layout)) expect(contactGroup(BREADBOARD_PROFILES[circuit.breadboard.profile], hole), hole).not.toBeNull();
    return { layout };
  } catch (error) {
    if (!(error instanceof LayoutFitError)) throw error;
    expect(error.toolSide).toBe(true);
    const finding = layoutFailureReport({ error, revisionHash: "test" }).findings[0];
    expect(finding?.ruleId).toBe("LAYOUT-NO-FIT");
    return { noFit: error.message };
  }
}

describe("allocator and LVS on every breadboard profile", () => {
  it.each(BREADBOARD_PROFILE_IDS)("fits every golden design and the whack-a-mole with an Uno on %s (groups met on the bigger boards)", (profile) => {
    for (const [key, circuit] of DESIGNS) {
      const result = outcome(on(circuit, profile, "uno-r3-atmega328p-5v"));
      // Placement groups (the whack-a-mole's three button+light groups, the moon lamp's row of four lights) may not
      // fit 17 rows without rails: honestly unmet there (FAO NO-GO on PLACEMENT-UNMET alone), never silently shipped.
      if (profile === "bb-170" && circuit.placement) expect(result, key).not.toHaveProperty("noFit");
      else expect(result, key).toHaveProperty("layout");
    }
  });

  it.each(BREADBOARD_PROFILE_IDS)("with a Nano on %s: fits, or says LAYOUT-NO-FIT only on the mini board", (profile) => {
    for (const [key, circuit] of DESIGNS) {
      const result = outcome(on(circuit, profile, "nano-atmega328p-5v"));
      if (profile === "bb-170") expect(result, key).toHaveProperty("noFit");
      else expect(result, key).not.toHaveProperty("noFit");
    }
  });

  it("wires 5 V and GND through strips on the mini board, which has no rails", () => {
    for (const [key, circuit] of DESIGNS) {
      const layout = layoutBoard(on(circuit, "bb-170", "uno-r3-atmega328p-5v"));
      expect(holesOf(layout).filter((hole) => parseHole(hole)?.kind === "rail"), key).toEqual([]);
      const ground = layout.jumpers.find((jumper) => "board" in jumper.from && jumper.from.board === "GND");
      expect(ground && "hole" in ground.to && parseHole(ground.to.hole)?.kind, key).toBe("terminal");
    }
  });

  it("joins the halves of a split rail with a bridge wire only when the build uses both halves", () => {
    const split = BREADBOARD_PROFILES["bb-830-split"];
    const moon = on(GOLDEN.find((design) => design.key === "moon-phase-lamp")!.circuit, "bb-830-split");
    const layout = layoutBoard(moon);
    const bridges = layout.jumpers.filter((jumper) => isRailBridge(split, jumper));
    expect(bridges.map((jumper) => ["hole" in jumper.from ? jumper.from.hole : "", "hole" in jumper.to ? jumper.to.hole : ""]).sort()).toContainEqual(["T-30", "T-32"]);
    // Bridges are built with the rails, before any wire that feeds a part.
    const firstPartWire = layout.jumpers.findIndex((jumper) => !isRailBridge(split, jumper) && !("board" in jumper.from && "hole" in jumper.to && parseHole(jumper.to.hole)?.kind === "rail"));
    for (const bridge of bridges) expect(layout.jumpers.indexOf(bridge)).toBeLessThan(firstPartWire);
    // The bridge carries real current: without it LVS finds the rail nets split.
    const withoutBridges = { ...layout, jumpers: layout.jumpers.filter((jumper) => !bridges.includes(jumper)) };
    expect(lvs(moon, withoutBridges).issues.map((issue) => issue.kind)).toContain("split-net");
    // The same wires on an unsplit 830 need no bridge.
    expect(layoutBoard(on(moon, "bb-830")).jumpers.some((jumper) => isRailBridge(BREADBOARD_PROFILES["bb-830"], jumper))).toBe(false);
    // Every golden: a rail gets its bridge exactly when its wires and legs use both halves.
    for (const design of GOLDEN) {
      const layout = layoutBoard(on(design.circuit, "bb-830-split"));
      for (const rail of ["T+", "T-"] as const) {
        const holes = [
          ...layout.jumpers.filter((jumper) => !isRailBridge(split, jumper)).flatMap((jumper) => [jumper.from, jumper.to]).flatMap((end) => ("hole" in end ? [end.hole] : [])),
          ...layout.placements.flatMap((placement) => Object.values(placement.pins)),
        ].filter((hole) => hole.startsWith(rail));
        const halves = new Set(holes.map((hole) => Number(hole.slice(2)) <= split.railSplitAfter! ? 1 : 2));
        const bridged = layout.jumpers.some((jumper) => isRailBridge(split, jumper) && "hole" in jumper.from && jumper.from.hole.startsWith(rail));
        expect(bridged, `${design.key} ${rail}`).toBe(halves.size > 1);
      }
    }
  });
});

describe("part variants on the breadboard", () => {
  const variantCircuit = (variants: { button: string; pot: string; led: string }) =>
    circuitOf({
      parts: [
        { id: "BTN1", module: "button", params: { variant: variants.button } },
        { id: "POT1", module: "potentiometer", params: { ohms: 10000, variant: variants.pot } },
        { id: "LED1", module: "led", params: { color: "red", variant: variants.led } },
        { id: "R1", module: "resistor", params: { ohms: 220 } },
      ],
      nets: [
        { id: "5V", kind: "power", pins: [board("5V"), pin("POT1", "A")] },
        { id: "GND", kind: "ground", pins: [board("GND"), pin("POT1", "B"), pin("BTN1", "3"), pin("LED1", "K")] },
        { id: "A0", kind: "signal", pins: [board("A0"), pin("POT1", "W")] },
        { id: "D2", kind: "signal", pins: [board("D2"), pin("BTN1", "1")] },
        { id: "D9", kind: "signal", pins: [board("D9"), pin("R1", "1")] },
        { id: "LA", kind: "signal", pins: [pin("R1", "2"), pin("LED1", "A")] },
      ],
      roles: [
        { pin: "A0", mode: "ANALOG_IN", part: "POT1", purpose: "knob" },
        { pin: "D2", mode: "INPUT_PULLUP", part: "BTN1", purpose: "button" },
        { pin: "D9", mode: "OUTPUT", part: "LED1", purpose: "light" },
      ],
    });
  const holes = (layout: Layout, part: string) => layout.placements.find((placement) => placement.part === part)!.pins;
  const rowOf = (hole: string) => (parseHole(hole) as { row: number }).row;

  it("places a 2-leg button by its two legs, a panel pot with legs two holes apart, a 12 mm button in d/g", () => {
    const small = variantCircuit({ button: "2leg", pot: "panel", led: "3mm" });
    const layout = layoutBoard(small);
    expect(lvs(small, layout).ok).toBe(true);
    const button = holes(layout, "BTN1");
    expect(Object.keys(button).sort()).toEqual(["1", "3"]);
    expect(button["1"]![0]).toBe(button["3"]![0]);
    expect(Math.abs(rowOf(button["1"]!) - rowOf(button["3"]!))).toBe(2);
    const pot = holes(layout, "POT1");
    expect([rowOf(pot.A!), rowOf(pot.W!), rowOf(pot.B!)].map((row, _, all) => Math.abs(row - all[1]!))).toEqual([2, 0, 2]);

    // Moving the 2-leg button's second leg off its strip splits the ground net: LVS checks the legs it really has.
    const moved = structuredClone(layout);
    const used = new Set(moved.placements.flatMap((placement) => Object.values(placement.pins)).concat(holesOf(moved)));
    const free = Array.from({ length: 63 }, (_, index) => `a${63 - index}`).find((hole) => !used.has(hole) && !used.has(`b${hole.slice(1)}`) && !used.has(`e${hole.slice(1)}`))!;
    moved.placements.find((placement) => placement.part === "BTN1")!.pins["3"] = free;
    expect(lvs(small, moved).issues.map((issue) => issue.kind)).toContain("split-net");

    const wide = variantCircuit({ button: "12mm-4leg", pot: "trimmer", led: "5mm" });
    const wideLayout = layoutBoard(wide);
    expect(lvs(wide, wideLayout).ok).toBe(true);
    const big = holes(wideLayout, "BTN1");
    expect([big["1"]![0], big["2"]![0], big["3"]![0], big["4"]![0]]).toEqual(["d", "g", "d", "g"]);
    const trimmer = holes(wideLayout, "POT1");
    expect(Math.abs(rowOf(trimmer.A!) - rowOf(trimmer.B!))).toBe(2);
  });

  it("still fits the variants on the mini board", () => {
    const circuit = on(variantCircuit({ button: "2leg", pot: "trimmer", led: "3mm" }), "bb-170");
    expect(outcome(circuit)).toHaveProperty("layout");
  });
});
