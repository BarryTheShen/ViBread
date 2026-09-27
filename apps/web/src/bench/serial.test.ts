import { describe, expect, it } from "vitest";
import { BOARD_PROFILES } from "@vibread/core";
import { BOARDS, STK500, type ISTKTransport, type SerialSignals } from "webserial-flasher";
import { BufferedTransport, boardProfileForUsb, boardUsbFilters, classifySerialError, webSerialSignals } from "./serial.js";

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

  push(chunk: Uint8Array): void {
    for (const listener of this.listeners) listener(chunk);
  }

  async close(): Promise<void> {
    this.listeners.clear();
  }
}

describe("BufferedTransport", () => {
  it("retains an immediate STK500 signature response until receiveData subscribes", async () => {
    const port = new ImmediateSignaturePort();
    const transport = new BufferedTransport(port);
    const stk = new STK500(transport.beginFlash(), BOARDS["arduino-uno"], { quiet: true });

    const signature = await stk.verifySignature();
    expect([...signature]).toEqual([0x14, 0x1e, 0x95, 0x0f, 0x10]);
  });

  it("keeps the runner subscribed across a reopen, mutes it during a flash, and drops the flasher's listeners after", async () => {
    const port = new ImmediateSignaturePort();
    const transport = new BufferedTransport(Object.assign(port, { open: async () => undefined }));
    const runner: Uint8Array[] = [];
    transport.on("data", (chunk) => runner.push(chunk));
    await transport.open(115_200);

    const flasher: Uint8Array[] = [];
    const session = transport.beginFlash();
    // A listener the flasher never removes (webserial-flasher leaves one behind when a read throws mid-way).
    session.on("data", (chunk) => flasher.push(chunk));
    port.push(new Uint8Array([0x14, 0x10]));
    await transport.close();
    await transport.open(115_200);
    transport.endFlash();
    port.push(new TextEncoder().encode('{"t":"hello"}\n'));

    expect(flasher.map((chunk) => [...chunk])).toEqual([[0x14, 0x10]]);
    expect(runner.map((chunk) => new TextDecoder().decode(chunk))).toEqual(['{"t":"hello"}\n']);
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
  it("translates DTR/RTS to both Web Serial reset signal names", async () => {
    const port = new ImmediateSignaturePort();
    const serialSignals: { dataTerminalReady: boolean; requestToSend: boolean }[] = [];
    const transport = new BufferedTransport(port, async (signals) => {
      serialSignals.push(webSerialSignals(signals));
    });
    await transport.setSignals({ dtr: false });
    await transport.setSignals({ rts: true });
    expect(serialSignals).toEqual([{ dataTerminalReady: false, requestToSend: false }, { dataTerminalReady: true, requestToSend: true }]);
    expect(() => webSerialSignals({} as SerialSignals)).toThrow(TypeError);
  });

  it("classifies serial failures without treating every error as power loss", () => {
    // Chrome: an OS-level open failure (another app, a port not yet released, a board gone) vs a port this page holds.
    const openFailed = classifySerialError(Object.assign(new Error("Failed to execute 'open' on 'SerialPort': Failed to open serial port."), { name: "NetworkError" }));
    expect(openFailed.kind).toBe("open-failed");
    expect(openFailed.message).toMatch(/would not open.*or the board was unplugged/);
    expect(classifySerialError(Object.assign(new Error("Failed to execute 'open' on 'SerialPort': The port is already open."), { name: "InvalidStateError" })).kind).toBe("busy");
    expect(classifySerialError(Object.assign(new Error("No answer from bootloader"), { name: "STK500SyncError" })).kind).toBe("sync-timeout");
    expect(classifySerialError(Object.assign(new Error("The device has been lost"), { name: "NetworkError" })).kind).toBe("disconnect");
  });
});
