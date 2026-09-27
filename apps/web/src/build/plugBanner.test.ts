import { describe, expect, it } from "vitest";
import { plugInstruction } from "./plugBanner.js";

describe("plugInstruction", () => {
  it("tells the builder to unplug on the step after a plugged-in checkpoint", () => {
    expect(plugInstruction("unplugged", "plugged")).toMatchObject({ plugged: false, change: true, action: "Unplug the USB cable now" });
  });

  it("tells the builder to plug in on a checkpoint that follows unplugged steps", () => {
    expect(plugInstruction("plugged", "unplugged")).toMatchObject({ plugged: true, change: true, action: "Plug the USB cable in now" });
  });

  it("says keep when the cable state doesn't change", () => {
    expect(plugInstruction("unplugged", "unplugged")).toMatchObject({ change: false, action: "Keep the USB cable unplugged" });
    expect(plugInstruction("plugged", "plugged")).toMatchObject({ change: false, action: "Keep the USB cable plugged in" });
  });

  it("treats the first step as starting unplugged", () => {
    expect(plugInstruction("unplugged", undefined).change).toBe(false);
    expect(plugInstruction("plugged", undefined)).toMatchObject({ change: true, action: "Plug the USB cable in now" });
  });
});
