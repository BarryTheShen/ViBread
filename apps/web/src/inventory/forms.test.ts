import { describe, expect, it } from "vitest";
import type { PartField } from "@vibread/core";
import { choiceOptionLabel, fieldHelperText } from "./FieldValuesForm.js";
import { mergedReviewQuantity, reviewQuantityLabel, valuesForFields } from "./forms.js";

const fields: PartField[] = [
  { key: "color", label: "Colour", kind: "choice", options: ["red", "blue"], identity: true, electrical: true },
  { key: "ohms", label: "Resistance", kind: "number", unit: "Ω", min: 1, identity: true, electrical: true },
  { key: "polarized", label: "Polarized", kind: "boolean", identity: false, electrical: false },
  { key: "brand", label: "Brand", kind: "text", identity: false, electrical: false },
];

describe("inventory field form helpers", () => {
  it("renders units for choice options and explains appearance-only fields", () => {
    const size: PartField = { key: "size", label: "Lens diameter", kind: "choice", options: ["3", "5", "10"], unit: "mm", identity: false, electrical: false };
    expect(choiceOptionLabel(size, "5")).toBe("5 mm");
    expect(fieldHelperText(size)).toBe("Lens diameter — 5 mm is the most common; doesn't change the circuit");
  });

  it("generates useful defaults for every PartField kind and preserves values", () => {
    expect(valuesForFields(fields)).toEqual({ color: "red", ohms: "", polarized: false, brand: "" });
    expect(valuesForFields(fields, { color: "blue", ohms: 220 })).toEqual({ color: "blue", ohms: 220, polarized: false, brand: "" });
  });
});

describe("scan review quantity merge", () => {
  it("keeps replace as the scanned quantity", () => {
    expect(mergedReviewQuantity(10, 9, "replace")).toBe(9);
    expect(reviewQuantityLabel(10, 9, "replace")).toBe("have 10 → will be 9");
  });

  it("adds to an existing identity only when Add is selected", () => {
    expect(mergedReviewQuantity(10, 9, "add")).toBe(19);
    expect(reviewQuantityLabel(10, 9, "add")).toBe("have 10 → will be 19");
  });

  it("does not show a have/will sentence for a new identity", () => {
    expect(reviewQuantityLabel(undefined, 4, "add")).toBeUndefined();
  });
});
