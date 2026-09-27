import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Circuit, SelfTestPlan } from "@vibread/core";
import { BOARD_PROFILES } from "@vibread/core";
import type { BenchLogEntry, BenchLogLevel } from "./benchLog.js";
import { FakeSerialPort } from "./fakeSerialPort.js";
import { BenchRunner, BoardCheckError } from "./runner.js";
import { BufferedTransport, classifySerialError, flashHex, TELEMETRY_BAUD, type BoardPortConnection } from "./serial.js";

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

interface UnoOptions {
  bootloaderBaud: number;
  flashedFirmware: Firmware;
  /** Optiboot's watchdog: the sketch starts this long after a reset or the last command it understood. */
  bootWindowMs?: number;
  opensRefusedAfterClose?: number;
  busyAtConnect?: boolean;
  /** GET_SYNCs Optiboot never hears after each reset (a CH340 still settling after the DTR edge). */
  lostSyncsAfterReset?: number;
  /** Reset pulses the chip misses (the reset capacitor not discharged, a slow bridge). */
  missedResets?: number;
  /** Bytes the board sends right after every reset, at any port speed (the old sketch's tail, noise on the line). */
  staleAfterReset?: number[];
  /** Chrome's read fails with BufferOverrunError once, on the first page write (a CH340 with a full receive buffer). */
  overrunOnFirstPage?: boolean;
  /** Every open after the new firmware starts is refused (a Windows driver that never gives the handle back). */
  refuseOpensAfterFlash?: boolean;
  /**
   * Optiboot's start-up delay plus LED blink (~440 ms on a Uno): it doesn't read the UART meanwhile, and the ATmega
   * holds at most 3 received bytes (2-byte FIFO + shift register); later bytes are lost.
   */
  deafAfterResetMs?: number;
  /** The chip resets this long after the DTR edge (or the open) that resets it: a slow bridge or a large reset RC. */
  resetLatencyMs?: number;
  /** The bridge loses the first byte the page writes after each open (a CH340 still settling after the open). */
  dropsFirstByteAfterOpen?: boolean;
  /** The sketch prints a line every this many ms, forever (an old sketch that spams serial from loop()). */
  chatterEveryMs?: number;
}

/**
 * A Uno behind a USB serial bridge, behind Chrome's Web Serial port: opening the port (Chrome asserts DTR/RTS) or a
 * DTR off→on edge resets the chip into Optiboot, which answers STK500 at its own baud and starts the sketch after its
 * watchdog window, a bad byte or LEAVE_PROGMODE. The sketch talks NDJSON at 115200 in small chunks, like a CH340.
 */
class FakeUno {
  readonly port: FakeSerialPort;
  private baud: number | undefined;
  private mode: "bootloader" | "app" = "app";
  private boot: ReturnType<typeof setTimeout> | undefined;
  private dtr = false;
  private readonly flash = new Uint8Array(32 * 1024);
  private address = 0;
  private lostSyncs = 0;
  /** Bytes the chip received while Optiboot was deaf, or the unread tail of an earlier frame. */
  private uart: number[] = [];
  private deaf = false;
  /** Each reset restarts Optiboot's start-up: a wake-up scheduled by an earlier reset no longer applies. */
  private resets = 0;
  private missedResets: number;
  private overrunPending: boolean;
  private flashed = false;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  readonly opens: number[] = [];
  appText = "";
  /** Opens still to refuse after the latest close (a Windows CH340/FTDI driver releasing the handle). */
  private refusals = 0;
  refusedOpens = 0;
  private dropNextByte = false;
  /** Each sketch start; a chatter loop from an earlier run stops. */
  private appRuns = 0;

  constructor(
    private firmware: Firmware,
    private readonly options: UnoOptions,
  ) {
    this.missedResets = options.missedResets ?? 0;
    this.overrunPending = options.overrunOnFirstPage ?? false;
    this.port = new FakeSerialPort({
      open: (serial) => this.open(serial.baudRate),
      closed: () => {
        this.baud = undefined;
        this.refusals = this.options.opensRefusedAfterClose ?? 0;
      },
      signals: (signals) => this.signals(signals),
      write: (bytes) => this.write(bytes),
    });
  }

  private open(baud: number): void {
    const refuse = this.refusals > 0 || (this.options.busyAtConnect && this.opens.length === 0) || (this.options.refuseOpensAfterFlash && this.flashed);
    if (refuse) {
      this.refusals = Math.max(0, this.refusals - 1);
      this.refusedOpens += 1;
      throw Object.assign(new Error("Failed to execute 'open' on 'SerialPort': Failed to open serial port."), { name: "NetworkError" });
    }
    this.baud = baud;
    this.opens.push(baud);
    this.dropNextByte = this.options.dropsFirstByteAfterOpen ?? false;
    this.dtr = true;
    this.resetSoon();
  }

  private signals(signals: SerialOutputSignals): void {
    if (signals.dataTerminalReady === undefined) return;
    if (!this.dtr && signals.dataTerminalReady) this.resetSoon();
    this.dtr = signals.dataTerminalReady;
  }

  private write(bytes: Uint8Array): void {
    let data = bytes;
    if (this.dropNextByte && data.length > 0) {
      this.dropNextByte = false;
      data = data.subarray(1);
      if (data.length === 0) return;
    }
    if (this.mode === "app") {
      this.appText += new TextDecoder().decode(data);
      const lines = this.appText.split("\n");
      this.appText = lines.pop() ?? "";
      for (const line of lines) this.appCommand(line);
      return;
    }
    if (data[0] === 0x30 && this.lostSyncs > 0) {
      this.lostSyncs -= 1;
      return;
    }
    if (this.deaf) {
      this.uart.push(...Array.from(data).slice(0, Math.max(0, 3 - this.uart.length)));
      return;
    }
    this.frame(data);
  }

  /** Optiboot reads the buffered bytes first: a whole GET_SYNC is answered and a leftover byte starts the next frame. */
  private wake(): void {
    this.deaf = false;
    const buffered = this.uart;
    this.uart = [];
    if (buffered.length === 0) return;
    const sync = buffered[0] === 0x30 && buffered[1] === EOP && this.baud === this.options.bootloaderBaud;
    if (!sync) return this.frame(new Uint8Array(buffered));
    this.startAppSoon(this.options.bootWindowMs ?? 1_000);
    this.port.receive(new Uint8Array([INSYNC, OK]));
    this.uart = buffered.slice(2);
  }

  private frame(bytes: Uint8Array): void {
    const data = this.uart.length > 0 ? new Uint8Array([...this.uart, ...bytes]) : bytes;
    this.uart = [];
    // Optiboot: the wrong baud or an unknown command is a bad frame; it lets the watchdog start the sketch.
    const command = this.baud === this.options.bootloaderBaud ? this.stk(data) : undefined;
    if (!command) {
      this.startAppSoon(16);
      return;
    }
    this.startAppSoon(this.options.bootWindowMs ?? 1_000);
    if (data[0] === 0x64 && this.overrunPending) {
      this.overrunPending = false;
      this.port.failRead("BufferOverrunError", "The receive buffer overflowed.");
    }
    // Answer during write(), the race BufferedTransport's flash session queues for.
    this.port.receive(command);
  }

  /** The next `count` reset pulses don't reach the chip. */
  missResets(count: number): void {
    this.missedResets = count;
  }

  stop(): void {
    for (const timer of this.timers) clearTimeout(timer);
    clearTimeout(this.boot);
  }

  private stk(data: Uint8Array): Uint8Array | undefined {
    if (data.at(-1) !== EOP) return undefined;
    const ok = new Uint8Array([INSYNC, OK]);
    switch (data[0]) {
      case 0x30: // GET_SYNC
        return data.length === 2 ? ok : undefined;
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
        this.firmware = this.options.flashedFirmware;
        this.flashed = true;
        this.startAppSoon(16);
        return ok;
      default:
        return undefined;
    }
  }

  private resetSoon(): void {
    const latency = this.options.resetLatencyMs ?? 0;
    if (latency > 0) this.later(latency, () => this.reset());
    else this.reset();
  }

  private reset(): void {
    if (this.missedResets > 0) {
      this.missedResets -= 1;
      return;
    }
    this.mode = "bootloader";
    this.appRuns += 1;
    this.lostSyncs = this.options.lostSyncsAfterReset ?? 0;
    this.uart = [];
    const deafMs = this.options.deafAfterResetMs ?? 0;
    if (deafMs > 0) {
      this.deaf = true;
      const reset = ++this.resets;
      this.later(deafMs, () => {
        if (reset === this.resets) this.wake();
      });
    }
    this.startAppSoon(this.options.bootWindowMs ?? 1_000);
    const stale = this.options.staleAfterReset;
    if (stale) this.later(20, () => this.port.receive(new Uint8Array(stale)));
  }

  private startAppSoon(ms: number): void {
    clearTimeout(this.boot);
    this.boot = setTimeout(() => {
      this.mode = "app";
      this.appText = "";
      this.hello(); // setup() prints the banner
      const run = ++this.appRuns;
      const every = this.options.chatterEveryMs;
      if (every) {
        const chatter = () => {
          if (run !== this.appRuns || this.mode !== "app") return;
          this.emit({ t: "log", msg: "old sketch loop" });
          this.later(every, chatter);
        };
        this.later(every, chatter);
      }
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

  private later(ms: number, run: () => void): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      run();
    }, ms);
    this.timers.add(timer);
  }

  /** The sketch prints at 115200: at any other port speed its bytes arrive as noise. */
  private emit(line: object): void {
    const bytes = new TextEncoder().encode(`${JSON.stringify(line)}\r\n`);
    for (let offset = 0; offset < bytes.length; offset += 5) {
      const chunk = this.baud === TELEMETRY_BAUD ? bytes.slice(offset, offset + 5) : new Uint8Array([0xf0, 0x00, 0xfe]);
      this.later(1, () => this.port.receive(chunk));
    }
  }
}

let board: FakeUno | undefined;
// The flasher's reset and drain waits, sync retries and the board's boot window run on a fake clock.
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
async function connect(firmware: Firmware, options: UnoOptions) {
  board = new FakeUno(firmware, options);
  const fake = board;
  const logged: BenchLogEntry[] = [];
  const log = (level: BenchLogLevel, message: string, data?: Record<string, unknown>) => void logged.push({ at: "", level, message, ...(data ? { data } : {}) });
  const transport = new BufferedTransport(fake.port, { log });
  const connection = { transport, profile: BOARD_PROFILES[BOARD], port: {} as SerialPort } satisfies BoardPortConnection;
  const runner = new BenchRunner({ plan, circuit, revision: 2, transport, log, timeouts: { helloMs: 300, vccMs: 1_000 } });
  await transport.open(TELEMETRY_BAUD);
  const flash = () => settle(flashHex({ connection, hex: HEX, onBoundary: () => runner.markFlashBoundary(), log }));
  const startRail = () => settle(runner.startRail());
  const messages = () => logged.map((entry) => entry.message);
  return { board: fake, transport, runner, flash, startRail, logged, messages };
}

describe("flash safe firmware, then check board power (issue #20)", () => {
  it("hears the new firmware's hello over the reopened port and reads VCC", async () => {
    const bench = await connect(undefined, { bootloaderBaud: 115_200, flashedFirmware: { design: DESIGN, board: BOARD } });
    await expect(bench.flash()).resolves.toEqual({ baud: 115_200, bytes: 16, reopened: true });
    await bench.startRail();
    expect(bench.runner.state.seenHello).toMatchObject({ design: DESIGN, board: BOARD });
    expect(bench.runner.state.seenVcc?.mv).toBe(5001);
    // Connect, then the reopen at the bench firmware's speed; the flash reuses the port already open at 115200.
    expect(bench.board.opens).toEqual([115_200, 115_200]);
    // The runner heard none of the STK500 traffic.
    expect(bench.runner.state.rawLines.every((line) => line.startsWith("{"))).toBe(true);
    const messages = bench.messages();
    for (const stage of [/port already open at 115200/, /reset round 1\/3 at 115200/, /drained \d+ stale bytes/, /bootloader in sync on GET_SYNC 1/, /sync OK on attempt 1/, /first reply 14 10/, /Verifying signature/, /Uploading 75%/, /Verifying 95%/, /Complete 100%/, /reopen port at 115200/, /hello design design-r2 board uno-r3/, /VCC 5001 mV/]) {
      expect(messages.some((message) => stage.test(message)), String(stage)).toBe(true);
    }
    // Chrome's receive buffer is set explicitly: its 255-byte default is ~22 ms of traffic at 115200.
    expect(bench.board.port.openOptions.map((options) => options.bufferSize)).toEqual([8_192, 8_192]);
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
    await expect(bench.flash()).resolves.toEqual({ baud: 57_600, bytes: 16, reopened: true });
    await bench.startRail();
    expect(bench.runner.state.seenVcc?.mv).toBe(5001);
    // Connect's open, the reopen at 57600 for the fallback, and the reopen at the bench firmware's speed.
    expect(bench.board.opens).toEqual([115_200, 57_600, 115_200]);
    expect(bench.logged.some((entry) => entry.level === "warn" && /failed at 115200 baud, trying 57600/.test(entry.message))).toBe(true);
    // Three reset rounds at the board's own baud before the fallback.
    expect(bench.messages().filter((message) => /reset round \d\/3 at 115200/.test(message))).toHaveLength(3);
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
    const bench = await connect(undefined, { bootloaderBaud: 57_600, flashedFirmware: { design: DESIGN, board: BOARD }, opensRefusedAfterClose: 2 });
    await expect(bench.flash()).resolves.toEqual({ baud: 57_600, bytes: 16, reopened: true });
    await bench.startRail();
    expect(bench.runner.state.seenVcc?.mv).toBe(5001);
    // Both reopens (at 57600 for the fallback and at 115200 after it) were refused twice, then worked.
    expect(bench.board.refusedOpens).toBe(4);
    expect(bench.board.opens).toEqual([115_200, 57_600, 115_200]);
    const retries = bench.logged.filter((entry) => /^serial: reopen retry/.test(entry.message)).map((entry) => entry.message);
    expect(retries).toEqual([
      "serial: reopen retry 1/3 after NetworkError: Failed to execute 'open' on 'SerialPort': Failed to open serial port.",
      "serial: reopen retry 2/3 after NetworkError: Failed to execute 'open' on 'SerialPort': Failed to open serial port.",
      "serial: reopen retry 1/3 after NetworkError: Failed to execute 'open' on 'SerialPort': Failed to open serial port.",
      "serial: reopen retry 2/3 after NetworkError: Failed to execute 'open' on 'SerialPort': Failed to open serial port.",
    ]);
  });

  it("gives up after three retries, and never retries the first open at Connect (a busy port is another app)", async () => {
    const stuck = await connect(undefined, { bootloaderBaud: 57_600, flashedFirmware: undefined, opensRefusedAfterClose: 9 });
    const failure = await stuck.flash().then(() => undefined, (error: unknown) => error);
    expect(classifySerialError(failure).kind).toBe("open-failed");
    // Three retries for the reopen at 57600, then three more when it tries to leave the port open at 115200.
    expect(stuck.logged.filter((entry) => /^serial: reopen retry/.test(entry.message)).map((entry) => entry.message.slice(0, 24))).toEqual(
      ["1/3", "2/3", "3/3", "1/3", "2/3", "3/3"].map((n) => `serial: reopen retry ${n}`),
    );

    board?.stop();
    board = new FakeUno(undefined, { bootloaderBaud: 115_200, flashedFirmware: undefined, busyAtConnect: true });
    const fake = board;
    const logged: string[] = [];
    const transport = new BufferedTransport(fake.port, { log: (_level, message) => void logged.push(message) });
    await expect(transport.open(TELEMETRY_BAUD)).rejects.toThrow("Failed to open serial port");
    expect(fake.refusedOpens).toBe(1);
    expect(logged).toEqual([]);
  });
});

/** The real-board failure modes behind issue #20 after the flash itself worked in the Arduino IDE on the same Uno. */
describe("flashing a real CH340 Uno over Web Serial (issue #20)", () => {
  it("keeps reading after Chrome reports a buffer overrun mid-flash instead of going deaf", async () => {
    const bench = await connect(undefined, { bootloaderBaud: 115_200, flashedFirmware: { design: DESIGN, board: BOARD }, overrunOnFirstPage: true });
    await expect(bench.flash()).resolves.toEqual({ baud: 115_200, bytes: 16, reopened: true });
    expect(bench.logged).toContainEqual(expect.objectContaining({ level: "warn", message: "serial: read error BufferOverrunError: The receive buffer overflowed.; reading on with a fresh reader" }));
    await bench.startRail();
    expect(bench.runner.state.seenVcc?.mv).toBe(5001);
  });

  it("syncs on a later attempt when the first GET_SYNC after the reset is lost, inside Optiboot's 1 s window", async () => {
    const bench = await connect(undefined, { bootloaderBaud: 115_200, flashedFirmware: { design: DESIGN, board: BOARD }, lostSyncsAfterReset: 1 });
    await expect(bench.flash()).resolves.toEqual({ baud: 115_200, bytes: 16, reopened: true });
    const messages = bench.messages();
    expect(messages).toContainEqual(expect.stringMatching(/^flash: bootloader in sync on GET_SYNC 2/));
    expect(messages).toContain("flash: sync OK on attempt 1");
    expect(messages.filter((message) => /reset round/.test(message))).toEqual([expect.stringMatching(/^flash: reset round 1\/3 at 115200/)]);
    expect(bench.board.opens).toEqual([115_200, 115_200]);
  });

  it("doesn't overrun Optiboot while it blinks the LED after a reset (answers once, then the sketch starts)", async () => {
    // The real CH340 Uno log: GET_SYNCs sent during Optiboot's ~440 ms deaf start-up piled up in the chip's 3-byte
    // buffer; it answered once, read '0' where it expected ' ', and its watchdog started the old sketch.
    const bench = await connect(undefined, { bootloaderBaud: 115_200, flashedFirmware: { design: DESIGN, board: BOARD }, deafAfterResetMs: 440 });
    await expect(bench.flash()).resolves.toEqual({ baud: 115_200, bytes: 16, reopened: true });
    const messages = bench.messages();
    expect(messages).toContainEqual(expect.stringMatching(/^flash: bootloader in sync on GET_SYNC 1/));
    expect(messages.filter((message) => /reset round/.test(message))).toHaveLength(1);
    await bench.startRail();
    expect(bench.runner.state.seenVcc?.mv).toBe(5001);
  });

  it("resets again at the board's own baud when a reset pulse doesn't take, before trying 57600", async () => {
    // The reset on Connect's open and the first explicit pulse don't reach the chip.
    const bench = await connect(undefined, { bootloaderBaud: 115_200, flashedFirmware: { design: DESIGN, board: BOARD }, missedResets: 2 });
    await expect(bench.flash()).resolves.toEqual({ baud: 115_200, bytes: 16, reopened: true });
    const messages = bench.messages();
    expect(messages).toContainEqual(expect.stringMatching(/^flash: no answer at 115200 baud after reset round 1\/3; resetting again/));
    expect(messages).toContainEqual(expect.stringMatching(/^flash: reset round 2\/3 at 115200/));
    expect(bench.board.opens).not.toContain(57_600);
  });

  it("never takes stale 0x14 0x10 bytes on the line for the bootloader's answer", async () => {
    // The bootloader is at 57600; at 115200 the only 0x14 0x10 on the line is left over from before each command.
    const bench = await connect(undefined, { bootloaderBaud: 57_600, flashedFirmware: { design: DESIGN, board: BOARD }, staleAfterReset: [INSYNC, OK, INSYNC, OK] });
    await expect(bench.flash()).resolves.toEqual({ baud: 57_600, bytes: 16, reopened: true });
    expect(bench.messages()).toContain("flash: drained 4 stale bytes");
    // Nothing at 115200 counted as an answer: the first sync is the bootloader's at 57600.
    const messages = bench.messages();
    expect(messages.findIndex((message) => /sync OK/.test(message))).toBeGreaterThan(messages.indexOf("flash: open port at 57600 baud"));
    expect(bench.logged.find((entry) => /failed at 115200 baud, trying 57600/.test(entry.message))?.data).toEqual({ error: expect.stringContaining("STK500SyncError") });
  });

  it("keeps a verified flash when only the reopen at 115200 fails", async () => {
    const bench = await connect(undefined, { bootloaderBaud: 115_200, flashedFirmware: { design: DESIGN, board: BOARD }, refuseOpensAfterFlash: true });
    await expect(bench.flash()).resolves.toEqual({ baud: 115_200, bytes: 16, reopened: false });
    expect(bench.logged).toContainEqual(
      expect.objectContaining({ level: "error", message: "flash: firmware written and verified, but the port didn't reopen at 115200 baud", data: { error: expect.stringContaining("Failed to open serial port") } }),
    );
    expect(bench.transport.isOpen).toBe(false);
  });

  it("still falls back to 57600 after an earlier USB dropout the port has recovered from", async () => {
    const bench = await connect(undefined, { bootloaderBaud: 57_600, flashedFirmware: { design: DESIGN, board: BOARD } });
    // A disconnect event from earlier in the session; the port is connected now.
    bench.transport.markDisconnected();
    await expect(bench.flash()).resolves.toEqual({ baud: 57_600, bytes: 16, reopened: true });
    expect(bench.board.opens).toEqual([115_200, 57_600, 115_200]);
  });

  it("reuses the open port for the flash: a Windows driver that is slow to give the handle back never blocks it", async () => {
    // The driver refuses every open after a close for longer than the reopen retries last.
    const bench = await connect(undefined, { bootloaderBaud: 115_200, flashedFirmware: { design: DESIGN, board: BOARD }, opensRefusedAfterClose: 9 });
    // Written and verified; only the reopen after it (which resets into the new firmware) needs the driver.
    await expect(bench.flash()).resolves.toEqual({ baud: 115_200, bytes: 16, reopened: false });
    expect(bench.board.opens).toEqual([115_200]);
  });

  it.each<[string, Partial<UnoOptions>]>([
    ["a slow bridge that resets the chip 150 ms after the DTR edge", { resetLatencyMs: 150 }],
    ["a late bootloader, deaf for 700 ms after the reset", { deafAfterResetMs: 700 }],
    ["an old sketch that prints every 5 ms until the reset", { chatterEveryMs: 5 }],
  ])("syncs on the first reset round with %s", async (_name, variant) => {
    const bench = await connect({ design: "design-r1", board: BOARD }, { bootloaderBaud: 115_200, flashedFirmware: { design: DESIGN, board: BOARD }, deafAfterResetMs: 440, ...variant });
    await expect(bench.flash()).resolves.toEqual({ baud: 115_200, bytes: 16, reopened: true });
    expect(bench.messages().filter((message) => /reset round/.test(message))).toHaveLength(1);
    await bench.startRail();
    expect(bench.runner.state.seenVcc?.mv).toBe(5001);
  });

  it("resets again when a CH340 drops the first byte after the open, without falling back to 57600", async () => {
    const bench = await connect(undefined, { bootloaderBaud: 115_200, flashedFirmware: { design: DESIGN, board: BOARD }, deafAfterResetMs: 440, dropsFirstByteAfterOpen: true });
    await expect(bench.flash()).resolves.toEqual({ baud: 115_200, bytes: 16, reopened: true });
    expect(bench.messages()).toContainEqual(expect.stringMatching(/^flash: reset round 2\/3 at 115200/));
    expect(bench.board.opens).not.toContain(57_600);
  });

  it("logs what the line carried when a reset didn't take, so a bug report shows the old sketch still talking", async () => {
    // The old sketch prints every 5 ms; the flash's first reset pulse misses the chip.
    const bench = await connect({ design: "design-r1", board: BOARD }, { bootloaderBaud: 115_200, flashedFirmware: { design: DESIGN, board: BOARD }, chatterEveryMs: 5 });
    await until(() => bench.runner.state.seenHello?.design === "design-r1");
    bench.board.missResets(1);
    await expect(bench.flash()).resolves.toEqual({ baud: 115_200, bytes: 16, reopened: true });
    // `{"t":"log"` in hex: the sketch's own NDJSON, not a bootloader at another baud.
    const heard = bench.logged.filter((entry) => entry.level === "warn" && /^flash: no INSYNC to GET_SYNC 1\/2 within 600 ms; heard \d+ bytes \(/.test(entry.message));
    expect(heard.length).toBeGreaterThan(0);
    expect(heard[0].message).toContain("7b 22 74 22 3a 22 6c 6f 67 22");
    expect(bench.logged).toContainEqual(expect.objectContaining({ message: expect.stringMatching(/^flash: drained \d+ stale bytes$/), data: { sample: expect.stringMatching(/^\d+ bytes \([0-9a-f]{2}( [0-9a-f]{2}){15} …\)$/) } }));
  });
});
