import { describe, expect, it } from "vitest";
import { BUILT_IN_PART_TYPES } from "./catalog-data.js";
import { LED_COLORS, MODULES } from "./modules.js";

const bySupport = (support: string) => BUILT_IN_PART_TYPES.filter((type) => type.support === support);

describe("built-in catalog", () => {
  it("contains the starter-kit support levels and unique ids", () => {
    expect(BUILT_IN_PART_TYPES.length).toBeGreaterThanOrEqual(35);
    expect(new Set(BUILT_IN_PART_TYPES.map((type) => type.id)).size).toBe(BUILT_IN_PART_TYPES.length);
    expect(bySupport("full").length).toBeGreaterThanOrEqual(7);
    expect(bySupport("modelled").length).toBeGreaterThanOrEqual(5);
    expect(bySupport("basic").length).toBeGreaterThanOrEqual(7);
    expect(bySupport("list-only").length).toBeGreaterThanOrEqual(15);
    expect(bySupport("supply").length).toBeGreaterThanOrEqual(4);
  });

  it("has valid fields, mappings, and generic pinouts", () => {
    for (const type of BUILT_IN_PART_TYPES) {
      expect(type.name, type.id).toBeTruthy();
      expect(type.description, type.id).toBeTruthy();
      expect(type.photoHint, type.id).toBeTruthy();
      for (const field of type.fields) {
        if (field.kind === "choice") expect(field.options?.length, `${type.id}.${field.key}`).toBeGreaterThan(0);
      }
      if (type.mapping.kind === "module" || type.mapping.kind === "modelled") expect(MODULES[type.mapping.module], type.id).toBeDefined();
      if (type.support === "basic") expect(type.pinout?.length, type.id).toBeGreaterThanOrEqual(2);
    }
  });

  it("derives LED options from the module color vocabulary", () => {
    const led = BUILT_IN_PART_TYPES.find((type) => type.id === "led")!;
    expect(led.fields.find((field) => field.key === "color")?.options).toEqual([...LED_COLORS]);
    expect(led.fields.find((field) => field.key === "color")?.options?.length).toBeGreaterThanOrEqual(5);
  });
});
