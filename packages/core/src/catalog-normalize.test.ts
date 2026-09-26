import { describe, expect, it } from "vitest";
import { BUILT_IN_PART_TYPES } from "./catalog-data.js";
import {
  inventoryIdentity,
  normalizeObservation,
  ohmsFromText,
  parsePartsText,
  resistorFromBands,
  toMissionInventory,
} from "./catalog-normalize.js";
import { resistorBands } from "./modules.js";
import type { InventoryEntry, ScanObservation } from "./catalog.js";

const type = (id: string) => BUILT_IN_PART_TYPES.find((item) => item.id === id)!;
const observation = (overrides: Partial<ScanObservation>): ScanObservation => ({
  photoIndex: 0,
  typeId: "resistor",
  label: "resistor",
  count: 1,
  confidence: "high",
  box: [0, 0, 10, 10],
  ...overrides,
});
const entry = (typeId: string, values: Record<string, string | number | boolean>, quantity: number, status: "ready" | "needs-look" = "ready"): InventoryEntry => ({
  id: `${typeId}-${quantity}`,
  typeId,
  values,
  quantity,
  status,
  source: "typed",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

describe("resistor normalization", () => {
  it("decodes every E24 value emitted by resistorBands", () => {
    const bases = [10, 11, 12, 13, 15, 16, 18, 20, 22, 24, 27, 30, 33, 36, 39, 43, 47, 51, 56, 62, 68, 75, 82, 91];
    for (let power = -1; power <= 6; power += 1) {
      for (const base of bases) {
        const value = base * 10 ** power;
        if (value < 1) continue;
        const bands = resistorBands(value);
        const decoded = resistorFromBands(bands);
        expect(decoded.candidates, `${value} ${bands.join(" ")}`).toContain(Number(value.toPrecision(12)));
        expect(decoded.candidates, `${value} ${bands.join(" ")}`).toHaveLength(1);
      }
    }
  });

  it("keeps both directions for an ambiguous five-band marking", () => {
    const decoded = resistorFromBands(["brown", "red", "black", "black", "brown"]);
    expect(decoded.bandCount).toBe(5);
    expect(decoded.candidates.length).toBeGreaterThan(1);
  });

  it("parses printed resistance forms", () => {
    expect(ohmsFromText("4k7")).toBe(4_700);
    expect(ohmsFromText("220R")).toBe(220);
    expect(ohmsFromText("10 kΩ")).toBe(10_000);
    expect(ohmsFromText("1M")).toBe(1_000_000);
    expect(ohmsFromText("103")).toBe(10_000);
  });

  it("requires a confident four-band gold/silver-ended reading for ready", () => {
    const ready = normalizeObservation(observation({ bands: ["red", "red", "brown", "gold"] } ), BUILT_IN_PART_TYPES);
    expect(ready.status).toBe("ready");
    expect(ready.values.ohms).toBe(220);
    const ambiguous = normalizeObservation(observation({ bands: ["brown", "red", "black", "black", "brown"] }), BUILT_IN_PART_TYPES);
    expect(ambiguous.status).toBe("needs-look");
    expect(ambiguous.candidates?.length).toBeGreaterThan(1);
  });
});

describe("typed inventory parsing", () => {
  it("parses counts, aliases, plurals, and x counts", () => {
    const lines = parsePartsText("3 red LEDs, 5x 220 ohm resistors, 1 button, 2 tilt switches, 1 thermistor", BUILT_IN_PART_TYPES);
    expect(lines).toMatchObject([
      { typeId: "led", quantity: 3, values: { color: "red" }, status: "ready" },
      { typeId: "resistor", quantity: 5, values: { ohms: 220 }, status: "ready" },
      { typeId: "button", quantity: 1, status: "ready" },
      { typeId: "tilt-switch", quantity: 2, status: "ready" },
      { typeId: "ntc-thermistor", quantity: 1, status: "ready" },
    ]);
  });

  it("accepts number words and preserves unknown lines", () => {
    const lines = parsePartsText("five blue LEDs, eleven mystery parts", BUILT_IN_PART_TYPES);
    expect(lines[0]).toMatchObject({ typeId: "led", quantity: 5, values: { color: "blue" } });
    expect(lines[1]).toMatchObject({ typeId: null, quantity: 1, status: "unknown" });
  });

  it("never reads a model number or part of a longer number as a resistor value", () => {
    const [runTogether] = parsePartsText("1 SG90 servo4 resistors", BUILT_IN_PART_TYPES);
    expect(runTogether?.values.ohms).toBeUndefined();
    expect(runTogether?.status).not.toBe("ready");
    expect(parsePartsText("5x220 ohm resistors", BUILT_IN_PART_TYPES)[0]).toMatchObject({ typeId: "resistor", quantity: 5, values: { ohms: 220 }, status: "ready" });
    expect(parsePartsText("2x 4k7 resistors", BUILT_IN_PART_TYPES)[0]).toMatchObject({ quantity: 2, values: { ohms: 4700 } });
  });
  it("handles grouped parenthetical lists, variants, and board aliases", () => {
    const lines = parsePartsText("9x led (Red, green, yellow, 3 each), 6 buttons, active & passive buzzer, arduino uno", BUILT_IN_PART_TYPES);
    expect(lines).toMatchObject([
      { typeId: "led", quantity: 3, values: { color: "red" }, status: "ready" },
      { typeId: "led", quantity: 3, values: { color: "green" }, status: "ready" },
      { typeId: "led", quantity: 3, values: { color: "yellow" }, status: "ready" },
      { typeId: "button", quantity: 6, status: "ready" },
      { typeId: "buzzer-active", quantity: 1, status: "ready" },
      { typeId: "buzzer-passive", quantity: 1, status: "ready" },
      { typeId: "arduino", quantity: 1, values: { board: "uno-r3" }, status: "ready" },
    ]);
  });

  it("splits natural conjunctions and preserves ambiguous unequal lists for review", () => {
    expect(parsePartsText("2 red and 2 green LEDs", BUILT_IN_PART_TYPES)).toMatchObject([
      { typeId: "led", quantity: 2, values: { color: "red" }, status: "ready" },
      { typeId: "led", quantity: 2, values: { color: "green" }, status: "ready" },
    ]);
    expect(parsePartsText("10 resistors (220, 1k, 10k)", BUILT_IN_PART_TYPES)).toMatchObject([
      { typeId: "resistor", quantity: 10, values: {}, status: "needs-look" },
    ]);
    expect(parsePartsText("LEDs x5 (blue)", BUILT_IN_PART_TYPES)).toMatchObject([
      { typeId: "led", quantity: 5, values: { color: "blue" }, status: "ready" },
    ]);
    expect(parsePartsText("red green LEDs", BUILT_IN_PART_TYPES)[0]).toMatchObject({ typeId: "led", quantity: 1, values: {}, status: "needs-look" });
  });
});


describe("mission inventory conversion", () => {
  it("maps full, modelled, basic, list-only, and supply entries", () => {
    const { items, notes } = toMissionInventory([
      entry("led", { color: "red", size: "5" }, 2),
      entry("trimmer-pot", { ohms: 10_000 }, 1),
      entry("tilt-switch", {}, 1),
      entry("servo", {}, 1),
      entry("arduino", { board: "uno-r3" }, 1),
      entry("led", { color: "blue", size: "5" }, 4, "needs-look"),
    ], BUILT_IN_PART_TYPES);
    expect(items).toEqual([
      { module: "led", count: 2, params: { color: "red" } },
      {
        module: "potentiometer",
        count: 1,
        params: { ohms: 10_000 },
        label: "Trimmer potentiometer (modelled as Knob (potentiometer))",
      },
      expect.objectContaining({ module: "generic", count: 1, label: "Tilt switch", params: { role: "digital-sensor", description: type("tilt-switch").description }, pinout: expect.any(Array) }),
    ]);
    expect(notes).toEqual(["also owns 1 Servo — ViBread can't design with it"]);
  });

  it("merges identical mapped module parameters and ignores non-identity fields", () => {
    const red = type("led");
    expect(inventoryIdentity(red, { color: "red", size: "3" })).toBe(inventoryIdentity(red, { color: "red", size: "10" }));
    expect(inventoryIdentity(red, { color: "red" })).not.toBe(inventoryIdentity(red, { color: "blue" }));
    const { items } = toMissionInventory([
      entry("led", { color: "red", size: "3" }, 1),
      entry("led", { color: "red", size: "10" }, 2),
    ], BUILT_IN_PART_TYPES);
    expect(items).toEqual([{ module: "led", count: 3, params: { color: "red" } }]);
  });
});
