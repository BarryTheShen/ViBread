import { describe, expect, it } from "vitest";
import type { InventoryItem } from "@vibread/core";
import { needVsHave } from "./PartsView.js";

describe("needVsHave", () => {
  it("matches module identity values while ignoring extra design params and per-part labels", () => {
    const design = [
      { module: "resistor" as const, params: { ohms: 220, tolerancePct: 5 } },
      { module: "resistor" as const, params: { tolerancePct: 10, ohms: 220 } },
      { module: "resistor" as const, params: { ohms: 220, tolerancePct: 5 } },
      { module: "resistor" as const, params: { ohms: 220, tolerancePct: 5 } },
    ];
    const inventory: InventoryItem[] = [
      { module: "resistor", count: 10, params: { ohms: 220 } },
      { module: "resistor", count: 5, params: { ohms: 10_000 } },
    ];
    expect(needVsHave(design, inventory)).toEqual([
      { key: 'resistor:{"ohms":220}', label: "Resistor · 220 Ω", module: "resistor", params: { ohms: 220 }, need: 4, have: 10 },
    ]);
  });
});
