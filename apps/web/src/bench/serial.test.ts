import { describe, expect, it } from "vitest";
import { BOARD_PROFILES } from "@vibread/core";
import { BOARDS, STK500, type SerialSignals } from "webserial-flasher";
import { FakeSerialPort } from "./fakeSerialPort.js";
import { BufferedTransport, boardProfileForUsb, boardUsbFilters, classifySerialError, webSerialSignals } from "./serial.js";

/** Let the transport's read loop take what the fake port delivered. */
const flushReads = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A port whose board answers READ_SIGN immediately, while write() is still in flight. */
function signaturePort() {
  const signals: SerialOutputSignals[] = [];
  const port: FakeSerialPort = new FakeSerialPort({
    write: (bytes) => {
      if (bytes[0] === 0x75) port.receive(new Uint8Array([0x14, 0x1e, 0x95, 0x0f, 0x10]));
    },
    signals: (next) => void signals.push(next),
  });
  return { port, signals };
}

describe("BufferedTransport", () => {
  it("retains an immediate STK500 signature response until receiveData subscribes", async () => {
    const { port } = signaturePort();
    const transport = new BufferedTransport(port);
    await transport.open(115_200);
    const stk = new STK500(transport.beginFlash(), BOARDS["arduino-uno"], { quiet: true });

    const signature = await stk.verifySignature();
    expect([...signature]).toEqual([0x14, 0x1e, 0x95, 0x0f, 0x10]);
  });

  it("keeps the runner subscribed across a reopen, mutes it during a flash, and drops the flasher's listeners after", async () => {
    const { port } = signaturePort();
    const transport = new BufferedTransport(port);
    const runner: Uint8Array[] = [];
    transport.on("data", (chunk) => runner.push(chunk));
    await transport.open(115_200);

    const flasher: Uint8Array[] = [];
    const session = transport.beginFlash();
    // A listener the flasher never removes (webserial-flasher leaves one behind when a read throws mid-way).
    session.on("data", (chunk) => flasher.push(chunk));
    port.receive(new Uint8Array([0x14, 0x10]));
    await flushReads();
    await transport.close();
    await transport.open(115_200);
    transport.endFlash();
    port.receive(new TextEncoder().encode('{"t":"hello"}\n'));
    await flushReads();

    expect(flasher.map((chunk) => [...chunk])).toEqual([[0x14, 0x10]]);
    expect(runner.map((chunk) => new TextDecoder().decode(chunk))).toEqual(['{"t":"hello"}\n']);
  });

  it("discards bytes that arrived before a command, keeping only the answer to it", async () => {
    const { port } = signaturePort();
    const transport = new BufferedTransport(port);
    await transport.open(115_200);
    const session = transport.beginFlash();
    // A stale INSYNC/OK pair from before the command, then the real answer during the write.
    port.receive(new Uint8Array([0x14, 0x10]));
    await flushReads();
    await session.write(new Uint8Array([0x75, 0x20]));
    const heard: number[] = [];
    session.on("data", (chunk) => heard.push(...chunk));
    expect(heard).toEqual([0x14, 0x1e, 0x95, 0x0f, 0x10]);
  });

  it("reads on with a fresh reader after a recoverable read error, and stops when the device is lost", async () => {
    const port = new FakeSerialPort();
    const logged: string[] = [];
    const transport = new BufferedTransport(port, { log: (_level, message) => void logged.push(message) });
    const heard: number[] = [];
    transport.on("data", (chunk) => heard.push(...chunk));
    await transport.open(115_200);
    // A 1 KiB burst fits the 8 KiB receive buffer (it would overrun Chrome's 255-byte default).
    port.receive(new Uint8Array(1_024).fill(0x41));
    await flushReads();
    expect(heard).toHaveLength(1_024);

    port.failRead("FramingError", "Framing error.");
    await flushReads();
    port.receive(new Uint8Array([1, 2, 3]));
    await flushReads();
    expect(heard.slice(-3)).toEqual([1, 2, 3]);
    expect(logged).toContain("serial: read error FramingError: Framing error.; reading on with a fresh reader");

    port.lose();
    await flushReads();
    expect(transport.disconnected).toBe(true);
    expect(logged).toContain("serial: reading stopped after NetworkError: The device has been lost.");
  });

  it("closes in Chrome's order and clears the stale open state when the driver refuses", async () => {
    const port = new FakeSerialPort();
    const transport = new BufferedTransport(port);
    await transport.open(115_200);
    // A read is pending: the close has to cancel it and release the reader before port.close() will work.
    await transport.close();
    expect(port.state).toBe("closed");
    await transport.open(57_600);

    port.failNextClose = true;
    const failure = await transport.close().then(() => undefined, (error: unknown) => error);
    expect(transport.isOpen).toBe(false);
    expect(classifySerialError(failure)).toMatchObject({ kind: "busy", message: expect.stringMatching(/stuck open .*reload this page/) });
  });

  it("reads the port's live connection state instead of a stale disconnect", async () => {
    const port = new FakeSerialPort();
    const transport = new BufferedTransport(port);
    transport.markDisconnected();
    expect(transport.disconnected).toBe(false);
    port.connected = false;
    expect(transport.disconnected).toBe(true);
  });

  it("moves DTR and RTS together, in Web Serial's names", async () => {
    const { port, signals } = signaturePort();
    const transport = new BufferedTransport(port);
    await transport.open(115_200);
    await transport.setSignals({ dtr: false });
    await transport.setSignals({ rts: true });
    expect(signals).toEqual([{ dataTerminalReady: false, requestToSend: false }, { dataTerminalReady: true, requestToSend: true }]);
    expect(() => webSerialSignals({} as SerialSignals)).toThrow(TypeError);
  });

  it("filters to supported USB IDs and keeps the Nano old-loader baud profile", () => {
    const filters = boardUsbFilters();
    expect(filters).toContainEqual({ usbVendorId: 0x2341, usbProductId: 0x0043 });
    expect(boardProfileForUsb({ usbVendorId: 0x1a86, usbProductId: 0x7523 })?.flash.baud).toBe(115_200);
    expect(BOARD_PROFILES["nano-atmega328p-old-5v"].flash.baud).toBe(57_600);
  });

  it("classifies serial failures without treating every error as power loss", () => {
    // Chrome: an OS-level open failure (another app, a port not yet released, a board gone) vs a port this page holds.
    const openFailed = classifySerialError(Object.assign(new Error("Failed to execute 'open' on 'SerialPort': Failed to open serial port."), { name: "NetworkError" }));
    expect(openFailed.kind).toBe("open-failed");
    expect(openFailed.message).toMatch(/would not open.*or the board was unplugged/);
    expect(classifySerialError(Object.assign(new Error("Failed to execute 'open' on 'SerialPort': The port is already open."), { name: "InvalidStateError" })).kind).toBe("busy");
    expect(classifySerialError(Object.assign(new Error("No answer from bootloader"), { name: "STK500SyncError" })).kind).toBe("sync-timeout");
    expect(classifySerialError(Object.assign(new Error("The device has been lost"), { name: "NetworkError" })).kind).toBe("disconnect");
    // A Windows driver refusing DTR/RTS is a reset problem with a reset-button remedy, not a raw browser message.
    const reset = classifySerialError(Object.assign(new Error("Failed to execute 'setSignals' on 'SerialPort': Failed to set control signals."), { name: "NetworkError" }));
    expect(reset).toMatchObject({ kind: "reset-failed", message: expect.stringMatching(/reset button/) });
  });
});
