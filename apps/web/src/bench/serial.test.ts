import { describe, expect, it } from "vitest";
import { BOARD_PROFILES } from "@vibread/core";
import { BOARDS, STK500, type ISTKTransport, type SerialSignals } from "webserial-flasher";
import { BufferedTransport } from "./serial.js";
import { boardProfileForUsb, boardUsbFilters } from "./serial.js";

class ImmediateSignaturePort implements ISTKTransport {
  private readonly listeners = new Set<(data: Uint8Array) => void>();
  readonly signals: SerialSignals[] = [];

  on(_event: "data", listener: (data: Uint8Array) => void): void {
    this.listeners.add(listener);
  }

  off(_event: "data", listener: (data: Uint8Array) => void): void {
    this.listeners.delete(listener);
  }

  async write(data: Uint8Array): Promise<void> {
    // READ_SIGN is answered synchronously during write(), the race found in
    // webserial-flasher 1.0.1's sendCommand implementation.
    if (data[0] === 0x75) {
      for (const listener of this.listeners) listener(new Uint8Array([0x14, 0x1e, 0x95, 0x0f, 0x10]));
    }
  }

  async setSignals(signal: SerialSignals): Promise<void> {
    this.signals.push(signal);
  }

  async close(): Promise<void> {
    this.listeners.clear();
  }
}

describe("BufferedTransport", () => {
  it("retains an immediate STK500 signature response until receiveData subscribes", async () => {
    const port = new ImmediateSignaturePort();
    const transport = new BufferedTransport(port);
    const stk = new STK500(transport, BOARDS["arduino-uno"], { quiet: true });

    const signature = await stk.verifySignature();
    expect([...signature]).toEqual([0x14, 0x1e, 0x95, 0x0f, 0x10]);
  });

  it("delegates DTR signals through the buffer", async () => {
    const port = new ImmediateSignaturePort();
    const transport = new BufferedTransport(port);
    await transport.setSignals({ dtr: false });
    await transport.setSignals({ dtr: true });
    expect(port.signals).toEqual([{ dtr: false }, { dtr: true }]);
  });

  it("filters to supported USB IDs and keeps the Nano old-loader baud profile", () => {
    const filters = boardUsbFilters();
    expect(filters).toContainEqual({ usbVendorId: 0x2341, usbProductId: 0x0043 });
    expect(boardProfileForUsb({ usbVendorId: 0x1a86, usbProductId: 0x7523 })?.flash.baud).toBe(115_200);
    expect(BOARD_PROFILES["nano-atmega328p-old-5v"].flash.baud).toBe(57_600);
  });
});
