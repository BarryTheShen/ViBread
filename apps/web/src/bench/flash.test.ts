import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Circuit, SelfTestPlan } from "@vibread/core";
import { BOARD_PROFILES } from "@vibread/core";
import type { ISTKTransport } from "webserial-flasher";
import type { BenchLogEntry, BenchLogLevel } from "./benchLog.js";
import { BenchRunner, BoardCheckError } from "./runner.js";
import { BufferedTransport, classifySerialError, flashHex, TELEMETRY_BAUD, webSerialSignals, type BoardPortConnection } from "./serial.js";

/**
 * GitHub issue #20: on a real CH340 Uno, "Flash safe firmware" wrote the board and then the page said the board had lost
 * power. These tests run the real sequence — Connect (port opened at the telemetry baud, runner attached) → flashHex
 * through webserial-flasher's STK500 against a fake Optiboot → runner.startRail — so the runner has to hear the new
 * firmware over the reopened port.
 */

const DESIGN = "design-r2";
const BOARD = "uno-r3-atmega328p-5v";
const plan = { design: DESIGN, board: BOARD, tests: [] } as unknown as SelfTestPlan;
const circuit = {} as Circuit;

type Firmware = { design: string; board: string } | "silent" | undefined;

/** 16 bytes at 0x0000 as Intel HEX (one flash page). */
function intelHex(bytes: number[]): string {
  const record = [bytes.length, 0, 0, 0, ...bytes];
  const checksum = (0x100 - (record.reduce((sum, value) => sum + value, 0) & 0xff)) & 0xff;
  const hexByte = (value: number) => value.toString(16).padStart(2, "0").toUpperCase();
  return `:${record.map(hexByte).join("")}${hexByte(checksum)}\n:00000001FF\n`;
}
const HEX = intelHex(Array.from({ length: 16 }, (_, index) => (index * 17 + 3) & 0xff));

const INSYNC = 0x14;
const OK = 0x10;
const EOP = 0x20;

/**
 * A Uno over a USB serial bridge, as Web Serial sees it: opening the port (DTR asserted) or a DTR low→high edge resets
 * the chip into Optiboot, which answers STK500 at its own baud and starts the sketch after a quiet window, a bad byte
 * or LEAVE_PROGMODE. The sketch talks NDJSON at 115200 in small chunks, like a CH340.
 */
class FakeUno implements ISTKTransport {
  private readonly listeners = new Set<(chunk: Uint8Array) => void>();
  private baud: number | undefined;
  private mode: "bootloader" | "app" = "app";
  private boot: ReturnType<typeof setTimeout> | undefined;
  private dtr = false;
  private readonly flash = new Uint8Array(32 * 1024);
  private address = 0;
  private pending: Firmware;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  readonly opens: number[] = [];
  appText = "";

  constructor(
    private firmware: Firmware,
    private readonly options: { bootloaderBaud: number; flashedFirmware: Firmware; bootWindowMs?: number; opensRefusedAfterClose?: number; busyAtConnect?: boolean },
  ) {}
  /** Opens still to refuse after the latest close (a Windows CH340/FTDI driver releasing the handle). */
  private refusals = 0;
  refusedOpens = 0;

  on(_event: "data", listener: (chunk: Uint8Array) => void): void {
    this.listeners.add(listener);
  }

  off(_event: "data", listener: (chunk: Uint8Array) => void): void {
    this.listeners.delete(listener);
  }

  async open(baud: number): Promise<void> {
    if (this.baud !== undefined) throw Object.assign(new Error("Failed to execute 'open' on 'SerialPort': The port is already open."), { name: "InvalidStateError" });
    if (this.refusals > 0 || (this.options.busyAtConnect && this.opens.length === 0)) {
      this.refusals = Math.max(0, this.refusals - 1);
      this.refusedOpens += 1;
      throw Object.assign(new Error("Failed to execute 'open' on 'SerialPort': Failed to open serial port."), { name: "NetworkError" });
    }
    this.baud = baud;
    this.opens.push(baud);
    this.dtr = true;
    this.reset();
  }

  async close(): Promise<void> {
    // WebSerialTransport.close() drops every listener, including the adapter's.
    this.listeners.clear();
    this.baud = undefined;
    this.refusals = this.options.opensRefusedAfterClose ?? 0;
  }

  /** SerialPort.setSignals as Web Serial takes it (the adapter translates the flasher's DTR/RTS). */
  setPortSignals(signals: { dataTerminalReady: boolean }): void {
    if (!this.dtr && signals.dataTerminalReady) this.reset();
    this.dtr = signals.dataTerminalReady;
  }

  async write(data: Uint8Array): Promise<void> {
    if (this.baud === undefined) throw new Error("Transport not open — call open() first");
    if (this.mode === "app") {
      this.appText += new TextDecoder().decode(data);
      const lines = this.appText.split("\n");
      this.appText = lines.pop() ?? "";
      for (const line of lines) this.appCommand(line);
      return;
    }
    // Optiboot: the wrong baud or an unknown command is a bad frame; it lets the watchdog start the sketch.
    const command = this.baud === this.options.bootloaderBaud ? this.stk(data) : undefined;
    if (!command) {
      this.startAppSoon(16);
      return;
    }
    this.startAppSoon(this.options.bootWindowMs ?? 500);
    // Answer during write(), the race BufferedTransport's flash session queues for.
    for (const listener of this.listeners) listener(command);
  }

  stop(): void {
    for (const timer of this.timers) clearTimeout(timer);
    if (this.boot) clearTimeout(this.boot);
  }

  private stk(data: Uint8Array): Uint8Array | undefined {
    if (data.at(-1) !== EOP) return undefined;
    const ok = new Uint8Array([INSYNC, OK]);
    switch (data[0]) {
      case 0x30: // GET_SYNC
      case 0x42: // SET_DEVICE
      case 0x50: // ENTER_PROGMODE
      case 0x52: // CHIP_ERASE
        return ok;
      case 0x75: // READ_SIGN
        return new Uint8Array([INSYNC, 0x1e, 0x95, 0x0f, OK]);
      case 0x55: // LOAD_ADDRESS (word address)
        this.address = (data[1] | (data[2] << 8)) * 2;
        return ok;
      case 0x64: { // PROG_PAGE
        const size = (data[1] << 8) | data[2];
        this.flash.set(data.subarray(4, 4 + size), this.address);
        return ok;
      }
      case 0x74: { // READ_PAGE
        const size = (data[1] << 8) | data[2];
        return new Uint8Array([INSYNC, ...this.flash.subarray(this.address, this.address + size), OK]);
      }
      case 0x51: // LEAVE_PROGMODE: the new sketch starts
        this.pending = this.options.flashedFirmware;
        this.firmware = this.pending;
        this.startAppSoon(16);
        return ok;
      default:
        return undefined;
    }
  }

  private reset(): void {
    this.mode = "bootloader";
    this.startAppSoon(this.options.bootWindowMs ?? 500);
  }

  private startAppSoon(ms: number): void {
    if (this.boot) clearTimeout(this.boot);
    this.boot = setTimeout(() => {
      this.mode = "app";
      this.appText = "";
      this.hello(); // setup() prints the banner
    }, ms);
  }

  private hello(): void {
    const firmware = this.firmware;
    if (firmware && firmware !== "silent") this.emit({ t: "hello", fw: "vibread-bench", proto: 1, design: firmware.design, board: firmware.board });
  }

  private appCommand(line: string): void {
    if (!this.firmware || this.firmware === "silent") return;
    const command = JSON.parse(line) as { c: string; test?: string };
    if (command.c === "hello") this.hello();
    if (command.c === "run" && command.test === "rails.vcc") {
      this.emit({ t: "begin", test: "rails.vcc" });
      this.emit({ t: "vcc", mv: 5001 });
      this.emit({ t: "end", test: "rails.vcc", status: "pass" });
    }
  }

  /** The sketch prints at 115200: at any other port speed its bytes arrive as noise. */
  private emit(line: object): void {
    const bytes = new TextEncoder().encode(`${JSON.stringify(line)}\r\n`);
    for (let offset = 0; offset < bytes.length; offset += 5) {
      const chunk = this.baud === TELEMETRY_BAUD ? bytes.slice(offset, offset + 5) : new Uint8Array([0xf0, 0x00, 0xfe]);
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        for (const listener of this.listeners) listener(chunk);
      }, 1);
      this.timers.add(timer);
    }
  }
}

let board: FakeUno | undefined;
// The bootloader's reset delays, sync retries and the board's boot window run on a fake clock.
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  board?.stop();
  vi.useRealTimers();
});

/** Advance the fake clock until `promise` settles. */
async function settle<T>(promise: Promise<T>): Promise<T> {
  let done = false;
  promise.then(() => (done = true), () => (done = true));
  for (let step = 0; step < 5_000 && !done; step += 1) await vi.advanceTimersByTimeAsync(10);
  return promise;
}

/** Advance the fake clock until `check()` holds. */
async function until(check: () => boolean): Promise<void> {
  for (let step = 0; step < 1_000 && !check(); step += 1) await vi.advanceTimersByTimeAsync(10);
  if (!check()) throw new Error("condition not met");
}

/** Connect as the bench view does: runner attached to the port, port opened at the telemetry baud. */
async function connect(firmware: Firmware, options: { bootloaderBaud: number; flashedFirmware: Firmware; opensRefusedAfterClose?: number; busyAtConnect?: boolean }) {
  board = new FakeUno(firmware, options);
  const fake = board;
  const logged: BenchLogEntry[] = [];
  const log = (level: BenchLogLevel, message: string, data?: Record<string, unknown>) => void logged.push({ at: "", level, message, ...(data ? { data } : {}) });
  const transport = new BufferedTransport(fake, async (signals) => fake.setPortSignals(webSerialSignals(signals)), { log });
  const connection = { transport, profile: BOARD_PROFILES[BOARD], port: {} as SerialPort } satisfies BoardPortConnection;
  const runner = new BenchRunner({ plan, circuit, revision: 2, transport, log, timeouts: { helloMs: 300, vccMs: 1_000 } });
  await transport.open(TELEMETRY_BAUD);
  const flash = () => settle(flashHex({ connection, hex: HEX, onBoundary: () => runner.markFlashBoundary(), log, commandTimeoutMs: 100 }));
  const startRail = () => settle(runner.startRail());
  return { board: fake, runner, flash, startRail, logged };
}

describe("flash safe firmware, then check board power (issue #20)", () => {
  it("hears the new firmware's hello over the reopened port and reads VCC", async () => {
    const bench = await connect(undefined, { bootloaderBaud: 115_200, flashedFirmware: { design: DESIGN, board: BOARD } });
    await expect(bench.flash()).resolves.toEqual({ baud: 115_200, bytes: 16 });
    await bench.startRail();
    expect(bench.runner.state.seenHello).toMatchObject({ design: DESIGN, board: BOARD });
    expect(bench.runner.state.seenVcc?.mv).toBe(5001);
    // Connect, the flash, and the reopen at the bench firmware's speed.
    expect(bench.board.opens).toEqual([115_200, 115_200, 115_200]);
    // The runner heard none of the STK500 traffic.
    expect(bench.runner.state.rawLines.every((line) => line.startsWith("{"))).toBe(true);
    const messages = bench.logged.map((entry) => entry.message);
    for (const stage of [/open port at 115200/, /Resetting device/, /Syncing/, /Verifying signature/, /Uploading 75%/, /Verifying 95%/, /Complete 100%/, /reopen port at 115200/, /hello design design-r2 board uno-r3/, /VCC 5001 mV/]) {
      expect(messages.some((message) => stage.test(message)), String(stage)).toBe(true);
    }
  });

  it("ignores the old firmware's banner from before the flash", async () => {
    const bench = await connect({ design: "design-r1", board: BOARD }, { bootloaderBaud: 115_200, flashedFirmware: { design: DESIGN, board: BOARD } });
    await until(() => bench.runner.state.seenHello?.design === "design-r1");
    await bench.flash();
    await bench.startRail();
    expect(bench.runner.state.seenHello?.design).toBe(DESIGN);
    // The old banner stays in the visible log; the run only carries the new firmware's lines.
    expect(bench.runner.state.rawLines.some((line) => line.includes("design-r1"))).toBe(true);
    expect(bench.runner.runRequest().lines.some((line) => line.t === "hello" && line.design === "design-r1")).toBe(false);
  });

  it("falls back to 57600 when the bootloader doesn't answer at 115200, then talks at 115200", async () => {
    const bench = await connect(undefined, { bootloaderBaud: 57_600, flashedFirmware: { design: DESIGN, board: BOARD } });
    await expect(bench.flash()).resolves.toEqual({ baud: 57_600, bytes: 16 });
    await bench.startRail();
    expect(bench.runner.state.seenVcc?.mv).toBe(5001);
    expect(bench.board.opens).toEqual([115_200, 115_200, 57_600, 115_200]);
    expect(bench.logged.some((entry) => entry.level === "warn" && /failed at 115200 baud, trying 57600/.test(entry.message))).toBe(true);
  });

  it("says no bytes arrived after the flash, even though the old firmware talked before it", async () => {
    const bench = await connect({ design: "design-r1", board: BOARD }, { bootloaderBaud: 115_200, flashedFirmware: "silent" });
    await until(() => bench.runner.state.seenHello !== undefined);
    await bench.flash();
    const failure = await bench.startRail().then(() => undefined, (error: unknown) => error);
    expect(failure).toBeInstanceOf(BoardCheckError);
    expect(classifySerialError(failure)).toMatchObject({
      message: expect.stringMatching(/^No bytes arrived from the board after the flash/),
      technical: expect.stringContaining("0 bytes received since the flash"),
    });
    expect(bench.logged.some((entry) => entry.level === "error" && /hello timeout .*0 bytes received since the flash/.test(entry.message))).toBe(true);
  });

  it("reports a bootloader that answers at neither baud as a sync failure, not lost power", async () => {
    const bench = await connect(undefined, { bootloaderBaud: 38_400, flashedFirmware: undefined });
    const failure = await bench.flash().then(() => undefined, (error: unknown) => error);
    expect(classifySerialError(failure)).toMatchObject({ kind: "sync-timeout", technical: expect.stringContaining("STK500SyncError") });
    // The port is left open at the telemetry baud so the board's own sketch can still be heard.
    expect(bench.board.opens.at(-1)).toBe(TELEMETRY_BAUD);
  });

  it("waits out a Windows driver that refuses to reopen the port right after we closed it", async () => {
    // Every reopen after our own close fails twice before the driver lets go (CH340/FTDI on Windows).
    const bench = await connect(undefined, { bootloaderBaud: 115_200, flashedFirmware: { design: DESIGN, board: BOARD }, opensRefusedAfterClose: 2 });
    await expect(bench.flash()).resolves.toEqual({ baud: 115_200, bytes: 16 });
    await bench.startRail();
    expect(bench.runner.state.seenVcc?.mv).toBe(5001);
    // Both reopens (before the flash and at 115200 after it) were refused twice, then worked.
    expect(bench.board.refusedOpens).toBe(4);
    expect(bench.board.opens).toEqual([115_200, 115_200, 115_200]);
    const retries = bench.logged.filter((entry) => /^serial: reopen retry/.test(entry.message)).map((entry) => entry.message);
    expect(retries).toEqual([
      "serial: reopen retry 1/3 after NetworkError: Failed to execute 'open' on 'SerialPort': Failed to open serial port.",
      "serial: reopen retry 2/3 after NetworkError: Failed to execute 'open' on 'SerialPort': Failed to open serial port.",
      "serial: reopen retry 1/3 after NetworkError: Failed to execute 'open' on 'SerialPort': Failed to open serial port.",
      "serial: reopen retry 2/3 after NetworkError: Failed to execute 'open' on 'SerialPort': Failed to open serial port.",
    ]);
  });

  it("gives up after three retries, and never retries the first open at Connect (a busy port is another app)", async () => {
    const stuck = await connect(undefined, { bootloaderBaud: 115_200, flashedFirmware: undefined, opensRefusedAfterClose: 9 });
    const failure = await stuck.flash().then(() => undefined, (error: unknown) => error);
    expect(classifySerialError(failure).kind).toBe("open-failed");
    // Three retries for the flash's own open, then three more when it tries to leave the port open at 115200.
    expect(stuck.logged.filter((entry) => /^serial: reopen retry/.test(entry.message)).map((entry) => entry.message.slice(0, 24))).toEqual(
      ["1/3", "2/3", "3/3", "1/3", "2/3", "3/3"].map((n) => `serial: reopen retry ${n}`),
    );

    board?.stop();
    board = new FakeUno(undefined, { bootloaderBaud: 115_200, flashedFirmware: undefined, busyAtConnect: true });
    const fake = board;
    const logged: string[] = [];
    const transport = new BufferedTransport(fake, undefined, { log: (_level, message) => void logged.push(message) });
    await expect(transport.open(TELEMETRY_BAUD)).rejects.toThrow("Failed to open serial port");
    expect(fake.refusedOpens).toBe(1);
    expect(logged).toEqual([]);
  });
});
