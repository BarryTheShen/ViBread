import { describe, expect, it } from "vitest";
import { BUILT_IN_PART_TYPES } from "./catalog-data.js";
import type { Part } from "./circuit.js";
import { MODULES } from "./modules.js";
import { PART_VARIANTS, partVariant } from "./variants.js";
import { partVisual } from "./visuals.js";

describe("part variants", () => {
  it("cover the kit variants from issue #23 with unique ids and keys", () => {
    expect(PART_VARIANTS.map((variant) => variant.id).sort()).toEqual(
      ["button-12mm-4leg", "button-2leg", "button-6mm-4leg", "buzzer-active", "buzzer-passive", "led-3mm", "led-5mm", "pot-panel", "pot-trimmer"].sort(),
    );
    expect(new Set(PART_VARIANTS.map((variant) => `${variant.module}:${variant.variant}`)).size).toBe(PART_VARIANTS.length);
  });

  it("belong to a built-in type that designs with the same module", () => {
    for (const variant of PART_VARIANTS) {
      const type = BUILT_IN_PART_TYPES.find((candidate) => candidate.id === variant.typeId);
      expect(type, variant.id).toBeDefined();
      expect(type!.mapping.kind === "module" || type!.mapping.kind === "modelled" ? type!.mapping.module : undefined, variant.id).toBe(variant.module);
    }
  });

  it("put a leg on every pin, except pins joined inside the part to a pin that has one", () => {
    for (const variant of PART_VARIANTS) {
      const legs = variant.legs.map((leg) => leg.pin);
      const module = MODULES[variant.module];
      expect(legs.every((pin) => module.pins.some((candidate) => candidate.id === pin)), variant.id).toBe(true);
      for (const pin of module.pins) {
        if (legs.includes(pin.id)) continue;
        const group = module.internallyConnected?.find((candidate) => candidate.includes(pin.id));
        expect(group?.some((other) => legs.includes(other)), `${variant.id} pin ${pin.id}`).toBe(true);
      }
      if (variant.polarized) expect(variant.legs.some((leg) => leg.howToTell), variant.id).toBe(true);
    }
    // A 2-leg button still switches: its legs sit on the two different sides of the switch.
    const twoLeg = PART_VARIANTS.find((variant) => variant.id === "button-2leg")!;
    const groups = MODULES.button.internallyConnected!;
    expect(new Set(twoLeg.legs.map((leg) => groups.findIndex((group) => group.includes(leg.pin)))).size).toBe(2);
  });

  it("is chosen by params.variant; anything else keeps the module's built-in look", () => {
    const led = (params: Record<string, unknown>): Part => ({ id: "LED1", module: "led", params });
    expect(partVariant(led({ color: "red", variant: "3mm" }))?.id).toBe("led-3mm");
    expect(partVisual(led({ color: "red", variant: "3mm" })).name).toBe("3 mm LED");
    expect(partVariant(led({ color: "red" }))).toBeUndefined();
    expect(partVariant(led({ variant: "2leg" }))).toBeUndefined();
    expect(partVisual(led({ variant: "nonsense" })).name).toBe("LED");
    expect(partVisual({ id: "BTN1", module: "button", params: { variant: "2leg" } }).legs.map((leg) => leg.pin)).toEqual(["1", "3"]);
  });
});
