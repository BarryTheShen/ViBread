import type { StepList } from "@vibread/core";
import { describe, expect, it } from "vitest";
import { remapProgress, reshownCount } from "./build-progress.js";

const step = (n: number, parts: string[] = [], jumpers: string[] = []) => ({ n, adds: { parts, jumpers } }) as unknown as StepList["steps"][number];
// Old steps, one part each: rails, Uno, power check (adds nothing), then R, LED, wire for each of three units.
const before = {
  steps: [step(1, [], ["WR"]), step(2, ["U1"]), step(3), step(4, ["R1"]), step(5, ["LED1"]), step(6, [], ["W1"]), step(7, ["R2"]), step(8, ["LED2"]), step(9, [], ["W2"]), step(10, ["R3"]), step(11, ["LED3"]), step(12, [], ["W3"])],
} as unknown as StepList;
// Re-derived with issue #25's grouping: unit 1 as a template step, then one "Repeat ×2" step for the other units.
const after = { steps: [step(1, [], ["WR"]), step(2, ["U1"]), step(3), step(4, ["R1", "LED1"], ["W1"]), step(5, ["R2", "LED2", "R3", "LED3"], ["W2", "W3"])] } as unknown as StepList;
const through = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

describe("remapProgress", () => {
  it("shows a trailing check again when nothing after it is on the board", () => {
    expect(remapProgress(before, after, through(3))).toEqual([1, 2]);
  });

  it("keeps the power check done when the builder already placed parts of the next step", () => {
    expect(remapProgress(before, after, through(4))).toEqual([1, 2, 3]);
    expect(reshownCount(before, after, through(4), [1, 2, 3])).toBe(1);
  });

  it("stops before a repeat step the builder was halfway through, and counts what it shows again", () => {
    expect(remapProgress(before, after, through(8))).toEqual([1, 2, 3, 4]);
    expect(reshownCount(before, after, through(8), [1, 2, 3, 4])).toBe(2);
  });

  it("credits everything when whole groups were finished", () => {
    expect(remapProgress(before, after, through(6))).toEqual([1, 2, 3, 4]);
    expect(reshownCount(before, after, through(6), [1, 2, 3, 4])).toBe(0);
    expect(remapProgress(before, after, through(12))).toEqual([1, 2, 3, 4, 5]);
  });
});
