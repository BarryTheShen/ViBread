import { describe, expect, it } from "vitest";
import { DEFAULT_LED_VF, LED_COLORS, MODULES, ledVf, ledVfAssumed } from "./modules.js";

describe("LED colour data", () => {
  it("has ordered Vf corners for every built-in colour", () => {
    const vf = MODULES.led.electrical.vf ?? {};
    expect(LED_COLORS).toHaveLength(9);
    for (const color of LED_COLORS) {
      const corners = vf[color];
      if (!corners) throw new Error(`missing Vf data for ${color}`);
      expect(corners.min).toBeLessThanOrEqual(corners.typ);
      expect(corners.typ).toBeLessThanOrEqual(corners.max);
    }
  });

  it("resolves custom and assumed LED Vf values", () => {
    expect(ledVf({ color: "infrared", vf: { min: 1.5, typ: 1.7, max: 2.0 } })).toEqual({ min: 1.5, typ: 1.7, max: 2.0 });
    expect(ledVfAssumed({ color: "infrared", vf: { min: 1.5, typ: 1.7, max: 2.0 } })).toBe(false);
    expect(ledVf({ color: "infrared" })).toEqual(DEFAULT_LED_VF);
    expect(ledVfAssumed({ color: "infrared" })).toBe(true);
  });
});
