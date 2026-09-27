import { describe, expect, it, vi } from "vitest";
import { planChooser, portLabel } from "./serial.js";

vi.mock("electron", () => ({ dialog: {} }));

// Electron reports USB ids as decimal strings: 0x1a86:0x7523 is the CH340 bridge on most Uno clones.
const CH340 = { portId: "1", portName: "COM3", displayName: "USB-SERIAL CH340", vendorId: "6790", productId: "29987" };
const UNO = { portId: "2", portName: "COM4", displayName: "Arduino Uno", vendorId: "9025", productId: "67" };
const BLUETOOTH = { portId: "3", portName: "COM5", displayName: "Standard Serial over Bluetooth link" };

describe("portLabel", () => {
  it("names a port the way Device Manager does", () => {
    expect(portLabel(CH340)).toBe("USB-SERIAL CH340 (COM3)");
    expect(portLabel({ ...CH340, displayName: "USB-SERIAL CH340 (COM3)" })).toBe("USB-SERIAL CH340 (COM3)");
  });

  it("falls back to ViBread's USB label, then to the bare port name", () => {
    expect(portLabel({ ...CH340, displayName: undefined, portName: "ttyUSB0" })).toBe("CH340 (common clone) (ttyUSB0)");
    expect(portLabel({ portId: "9", portName: "ttyS0", displayName: " " })).toBe("ttyS0");
  });
});

describe("planChooser", () => {
  it("picks the only known board even when other serial ports exist", () => {
    expect(planChooser([BLUETOOTH, CH340])).toEqual({ kind: "pick", port: CH340 });
  });

  it("asks when several boards are plugged in, listing only the boards", () => {
    expect(planChooser([CH340, BLUETOOTH, UNO])).toEqual({ kind: "ask", choices: [CH340, UNO] });
  });

  it("asks about unknown ports rather than hiding them when no known board is present", () => {
    expect(planChooser([BLUETOOTH])).toEqual({ kind: "ask", choices: [BLUETOOTH] });
  });

  it("waits for a board to be plugged in when there are no ports", () => {
    expect(planChooser([])).toEqual({ kind: "wait" });
  });
});
