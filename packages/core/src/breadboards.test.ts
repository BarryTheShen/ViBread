import { describe, expect, it } from "vitest";
import { BOARD_PROFILES, BOARD_VARIANTS } from "./boards.js";
import { BREADBOARD_PROFILES, contactGroup, isRailBridge, isValidHole, powerRails, railBridge } from "./breadboards.js";

describe("breadboard profiles", () => {
  it("keeps the stored ids with their geometry", () => {
    expect(BREADBOARD_PROFILES["bb-830"]).toMatchObject({ rows: 63, railsSplit: false });
    expect(BREADBOARD_PROFILES["bb-400"]).toMatchObject({ rows: 30, railsSplit: false });
    expect(contactGroup(BREADBOARD_PROFILES["bb-830"], "T+2")).toBe(contactGroup(BREADBOARD_PROFILES["bb-830"], "T+60"));
  });

  it("gives the mini board 17 rows and no rail holes, so power must go through strips", () => {
    const mini = BREADBOARD_PROFILES["bb-170"];
    expect(isValidHole(mini, "j17")).toBe(true);
    expect(isValidHole(mini, "a18")).toBe(false);
    for (const hole of ["T+2", "T-2", "B+2", "B-2"]) {
      expect(isValidHole(mini, hole), hole).toBe(false);
      expect(contactGroup(mini, hole), hole).toBeNull();
    }
    expect(powerRails(mini)).toBeNull();
    expect(powerRails(BREADBOARD_PROFILES["bb-400"])).toEqual({ plus: "T+", minus: "T-" });
  });

  it("splits each rail of the split 830 into two halves that only a bridge wire joins", () => {
    const split = BREADBOARD_PROFILES["bb-830-split"];
    expect(contactGroup(split, "T+2")).toBe(contactGroup(split, "T+30"));
    expect(contactGroup(split, "T+32")).toBe(contactGroup(split, "T+60"));
    expect(contactGroup(split, "T+30")).not.toBe(contactGroup(split, "T+32"));
    for (const rail of ["T+", "T-", "B+", "B-"] as const) {
      const bridge = railBridge(split, rail)!;
      expect(bridge.map((hole) => isValidHole(split, hole))).toEqual([true, true]);
      expect(contactGroup(split, bridge[0])).not.toBe(contactGroup(split, bridge[1]));
      expect(isRailBridge(split, { from: { hole: bridge[0] }, to: { hole: bridge[1] } })).toBe(true);
    }
    expect(railBridge(BREADBOARD_PROFILES["bb-830"], "T+")).toBeNull();
    expect(railBridge(BREADBOARD_PROFILES["bb-170"], "T+")).toBeNull();
    // Same half, different rails, and board wires are not bridges.
    expect(isRailBridge(split, { from: { hole: "T+2" }, to: { hole: "T+8" } })).toBe(false);
    expect(isRailBridge(split, { from: { hole: "T+30" }, to: { hole: "T-32" } })).toBe(false);
    expect(isRailBridge(split, { from: { board: "5V" }, to: { hole: "T+32" } })).toBe(false);
  });
});

describe("board variants", () => {
  it("map every variant to an existing board profile without touching how it flashes", () => {
    for (const variant of Object.values(BOARD_VARIANTS)) expect(BOARD_PROFILES[variant.profile], variant.id).toBeDefined();
    expect(BOARD_VARIANTS["uno-r3-genuine"].profile).toBe(BOARD_VARIANTS["uno-r3-ch340"].profile);
    expect(BOARD_VARIANTS["nano-old"].profile).toBe("nano-atmega328p-old-5v");
  });

  it("list the USB ids each variant shows up as", () => {
    const ids = (id: keyof typeof BOARD_VARIANTS) => BOARD_VARIANTS[id].usb.map((usb) => `${usb.vid.toString(16)}:${usb.pid.toString(16)}`);
    expect(ids("uno-r3-ch340")).toEqual(["1a86:7523"]);
    expect(ids("uno-r3-genuine")).toContain("2341:43");
    expect(ids("uno-r3-genuine")).not.toContain("1a86:7523");
  });
});
