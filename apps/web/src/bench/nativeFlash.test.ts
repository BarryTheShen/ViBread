import { describe, expect, it } from "vitest";
import { fetchBenchPorts, nativeFlash, preferredPort, type BenchPort } from "./nativeFlash.js";

const CH340: BenchPort = { port: "COM3", label: "COM3 · CH340 (common clone)", vid: 0x1a86, pid: 0x7523 };
const UNO: BenchPort = { port: "COM4", label: "COM4 · Arduino Uno", vid: 0x2341, pid: 0x0043, boardFqbn: "arduino:avr:uno" };
const json = (status: number, body: unknown) => async (): Promise<Response> => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("preferredPort", () => {
  it("keeps the current choice while it is listed, then prefers the Web Serial board's USB ID, then the only port", () => {
    expect(preferredPort([CH340, UNO], "COM4", { usbVendorId: 0x1a86, usbProductId: 0x7523 })).toBe("COM4");
    expect(preferredPort([CH340, UNO], "COM9", { usbVendorId: 0x1a86, usbProductId: 0x7523 })).toBe("COM3");
    expect(preferredPort([CH340], undefined)).toBe("COM3");
    expect(preferredPort([CH340, UNO], undefined)).toBeUndefined();
    expect(preferredPort([], "COM3")).toBeUndefined();
  });
});

describe("fetchBenchPorts", () => {
  it("is unavailable when the server refuses (not the ViBread computer) or can't list", async () => {
    expect(await fetchBenchPorts(json(200, { ports: [CH340] }))).toEqual([CH340]);
    expect(await fetchBenchPorts(json(403, { error: { code: "lan_loopback_required", message: "no" } }))).toBeUndefined();
    expect(await fetchBenchPorts(json(503, { error: { code: "toolchain_missing", message: "no" } }))).toBeUndefined();
    expect(await fetchBenchPorts(async () => { throw new TypeError("offline"); })).toBeUndefined();
  });
});

describe("nativeFlash", () => {
  it("returns the uploader output on success and the classified error with output on failure", async () => {
    expect(await nativeFlash("m1", { port: "COM3", which: "bench" }, json(200, { ok: true, output: "2462 bytes of flash written", fqbn: "arduino:avr:uno", durationMs: 1800 })))
      .toEqual({ ok: true, output: "2462 bytes of flash written", fqbn: "arduino:avr:uno", durationMs: 1800 });
    expect(await nativeFlash("m1", { port: "COM3", which: "bench" }, json(502, { ok: false, error: { code: "port_busy", message: "The port is busy.", hint: "Close the Serial Monitor." }, output: "Access is denied." })))
      .toEqual({ ok: false, output: "Access is denied.", error: { code: "port_busy", message: "The port is busy.", hint: "Close the Serial Monitor." } });
    expect(await nativeFlash("m1", { port: "COM8", which: "app" }, json(400, { error: { code: "port_not_listed", message: "COM8 is not a connected Arduino port." } })))
      .toEqual({ ok: false, output: "", error: { code: "port_not_listed", message: "COM8 is not a connected Arduino port." } });
  });

  it("preserves app calibration metadata from the native uploader", async () => {
    await expect(nativeFlash("m1", { port: "COM3", which: "app" }, json(200, { ok: true, output: "written", fqbn: "arduino:avr:uno", durationMs: 1800, calibration: "measured" })))
      .resolves.toMatchObject({ ok: true, calibration: "measured" });
  });

  it("reports the bootloader speed the server's uploader reached the board at", async () => {
    await expect(nativeFlash("m1", { port: "COM3", which: "bench" }, json(200, { ok: true, output: "written", fqbn: "arduino:avr:nano:cpu=atmega328old", durationMs: 9000, board: "nano-atmega328p-old-5v", baud: 57_600 })))
      .resolves.toEqual({ ok: true, output: "written", fqbn: "arduino:avr:nano:cpu=atmega328old", durationMs: 9000, baud: 57_600 });
  });
});
