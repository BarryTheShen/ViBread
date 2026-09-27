import type { BoardProfile, BoardProfileId } from "@vibread/core";
import { BOARD_PROFILES } from "@vibread/core";
import { BOARDS, STK500, STK500SyncError, parseIntelHex } from "webserial-flasher";
import type { Board, ISTKTransport, SerialSignals } from "webserial-flasher";
import type { WebSerialPortFilter } from "webserial-flasher";
import type { BenchLog } from "./benchLog.js";

/** The browsers in which ViBread has a tested Web Serial implementation. */
export const WEB_SERIAL_BROWSERS = "Chrome or Edge" as const;
/** Bench firmware's fixed NDJSON serial speed (core telemetry protocol). */
export const TELEMETRY_BAUD = 115_200 as const;
/**
 * Per-command bootloader timeout. The longest command, a 128-byte PROG_PAGE (133 bytes out, 2 back) plus Optiboot's
 * ~4.5 ms page write, takes about 30 ms at 57600, so 200 ms is ample, and the five sync attempts (50 ms apart) all land
 * inside Optiboot's ~1 s window after a reset instead of one attempt per window with the library's 10 s default.
 */
const STK_COMMAND_TIMEOUT_MS = 200;
const SYNC_RETRY = { syncAttempts: 5, retryDelayMs: 50 } as const;
/** Resets tried at one bootloader baud before the other baud (the board's own baud is by far the likelier one). */
const RESET_ROUNDS = 3;
/** avrdude's arduino programmer: DTR/RTS off to discharge the reset capacitor, a short on pulse resets, then settle. */
const RESET_DISCHARGE_MS = 250;
const RESET_SETTLE_MS = 100;
/** esptool-js's active drain: stale bytes are discarded once the line has been quiet this long (or at the cap). */
const DRAIN_QUIET_MS = 100;
const DRAIN_MAX_MS = 400;
/** Receive buffer for port.open(). The spec's default of 255 bytes is ~22 ms at 115200: a busy page overruns it. */
const SERIAL_BUFFER_SIZE = 8_192;
/** Waits before each retry of an open that follows our own close (see BufferedTransport.open). */
const REOPEN_DELAYS_MS = [300, 600, 1_200] as const;
/** Read errors after which Chrome hands out a fresh `port.readable`: the port is still usable (Web Serial spec). */
const RECOVERABLE_READ_ERRORS = new Set(["BufferOverrunError", "FramingError", "ParityError", "BreakError", "UnknownError"]);
const STK_GET_SYNC = new Uint8Array([0x30, 0x20]);

/**
 * The error a Windows USB serial driver gives for an open issued while the previous handle is still closing. An
 * "already open" InvalidStateError is not one: a port this page still holds never becomes closed by waiting.
 */
function isReopenRace(error: unknown): boolean {
  return error instanceof Error && error.name === "NetworkError" && /failed to open serial port/i.test(error.message);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const toHex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(" ");
const describeError = (error: unknown) => (error instanceof Error ? `${error.name}: ${error.message}` : String(error));

export class UnsupportedWebSerialError extends Error {
  constructor() {
    super("Web Serial is unavailable. Use Chrome or Edge on the laptop, or use the arduino-cli fallback.");
    this.name = "UnsupportedWebSerialError";
  }
}

/** A port.close() that failed: Chrome leaves such a port "closing", and every later open() refuses it. */
export class PortCloseError extends Error {
  constructor(readonly detail: string) {
    super("The USB port did not close.");
    this.name = "PortCloseError";
  }
}

/** The part of Web Serial's SerialPort the bench drives: Chrome's port, or a fake with the same semantics in tests. */
export type SerialPortLike = Pick<SerialPort, "open" | "close" | "setSignals" | "readable" | "writable"> & {
  /** Live USB presence (Chrome 124+); undefined in older browsers. */
  readonly connected?: boolean;
};

type DataListener = (chunk: Uint8Array) => void;

/** The bootloader's view of the port for one flash: its own listeners, and a queue until it subscribes. */
export interface FlashSession extends ISTKTransport {
  setSignals(opts: SerialSignals): Promise<void>;
}

interface Session {
  listeners: Set<DataListener>;
  queued: Uint8Array[];
  queuedBytes: number;
  lastChunkAt: number;
  /** Log the next bytes the flasher receives (the first answer after a reset, for Diagnostics). */
  logFirstReply: boolean;
}

/**
 * One board's serial port, shared by the bench runner and the flasher. It drives the Web Serial port itself: opens it
 * with an 8 KiB receive buffer, runs the spec's two-level read loop (a recoverable read error gets a fresh reader
 * instead of a deaf port), and closes in the order Chrome requires (cancel the read → release the lock → close).
 *
 * Subscribers (the bench runner) stay attached across close/open, so the runner still hears the board after a flash
 * reopens the port. While a flash session is active, bytes go only to that session: the runner never sees STK500
 * traffic, and the flasher's listeners are dropped with the session, so none leak into later reads. The session
 * queues bytes until the flasher subscribes, because webserial-flasher 1.0.1 installs its response listener only
 * after awaiting write(), and a USB serial bridge can answer during the write. Every write first discards what is
 * queued, so bytes from before a command (the old sketch's banner, noise at the wrong baud) never answer it.
 */
export class BufferedTransport implements ISTKTransport {
  private readonly subscribers = new Set<DataListener>();
  private session: Session | undefined;
  private openBaud: number | undefined;
  private lostValue = false;
  /** Set once this adapter has closed the port itself; only then can a failed open be the driver still letting go. */
  private closedByUs = false;
  private reading = false;
  /** Whether the read loop is still delivering: it ends on close(), a lost device, or an unrecoverable read error. */
  private listening = false;
  private reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  private readLoop: Promise<void> = Promise.resolve();
  private writes: Promise<void> = Promise.resolve();

  constructor(
    private readonly port: SerialPortLike,
    private readonly options: { log?: BenchLog; reopenDelaysMs?: readonly number[] } = {},
  ) {}

  private readonly handleData = (chunk: Uint8Array): void => {
    const session = this.session;
    if (!session) {
      for (const listener of this.subscribers) listener(chunk);
      return;
    }
    session.lastChunkAt = Date.now();
    if (session.listeners.size === 0) {
      session.queued.push(chunk.slice());
      session.queuedBytes += chunk.byteLength;
    } else this.deliver(session, chunk);
  };

  private deliver(session: Session, chunk: Uint8Array): void {
    if (session.logFirstReply) {
      session.logFirstReply = false;
      this.options.log?.("info", `flash: first reply ${toHex(chunk.subarray(0, 16))}`);
    }
    for (const listener of session.listeners) listener(chunk);
  }

  /** Drop the flash session's queued bytes; returns how many there were and the first 16 of them. */
  private discardQueued(): { count: number; sample: Uint8Array } {
    const session = this.session;
    if (!session) return { count: 0, sample: new Uint8Array(0) };
    const count = session.queuedBytes;
    const sample = new Uint8Array(Math.min(16, count));
    let offset = 0;
    for (const chunk of session.queued) {
      if (offset >= sample.length) break;
      const part = chunk.subarray(0, sample.length - offset);
      sample.set(part, offset);
      offset += part.length;
    }
    session.queued.length = 0;
    session.queuedBytes = 0;
    return { count, sample };
  }

  /**
   * Active drain (esptool-js): wait until nothing has arrived for `quietMs` (at most `maxMs`), then discard everything
   * queued. Returns the number of stale bytes discarded and the first 16 (for Diagnostics: an old sketch's text, noise
   * at the wrong baud, or a late bootloader answer).
   */
  async drain(quietMs = DRAIN_QUIET_MS, maxMs = DRAIN_MAX_MS): Promise<{ count: number; sample: Uint8Array }> {
    const session = this.session;
    if (!session) return { count: 0, sample: new Uint8Array(0) };
    const started = Date.now();
    for (;;) {
      const now = Date.now();
      const wait = Math.min(quietMs - (now - Math.max(session.lastChunkAt, started)), maxMs - (now - started));
      if (wait <= 0) break;
      await sleep(wait);
    }
    session.logFirstReply = true;
    return this.discardQueued();
  }

  async write(data: Uint8Array): Promise<void> {
    this.discardQueued();
    const run = this.writes.then(() => this.writeNow(data));
    this.writes = run.catch(() => undefined);
    await run;
  }

  private async writeNow(data: Uint8Array): Promise<void> {
    const writable = this.openBaud === undefined ? null : this.port.writable;
    if (!writable) throw new Error("Transport not open — call open() first");
    const writer = writable.getWriter();
    try {
      await writer.write(data);
    } finally {
      writer.releaseLock();
    }
  }

  /**
   * Open at `baudRate`. The first open is strict (a busy port is another app holding it). After this adapter closed the
   * port itself, a failed open is retried: Windows CH340/FTDI drivers can refuse an open right after a close while the
   * handle is still being released. Flashing closes and reopens up to three times.
   */
  async open(baudRate: number): Promise<void> {
    const delays = this.closedByUs ? (this.options.reopenDelaysMs ?? REOPEN_DELAYS_MS) : [];
    for (let attempt = 0; ; attempt += 1) {
      try {
        await this.port.open({ baudRate, bufferSize: SERIAL_BUFFER_SIZE, dataBits: 8, stopBits: 1, parity: "none", flowControl: "none" });
        break;
      } catch (error) {
        if (attempt >= delays.length || !isReopenRace(error)) throw error;
        const wait = delays[attempt];
        this.options.log?.("warn", `serial: reopen retry ${attempt + 1}/${delays.length} after ${describeError(error)}`, { baud: baudRate, waitMs: wait });
        await sleep(wait);
      }
    }
    this.openBaud = baudRate;
    this.discardQueued();
    this.reading = true;
    this.listening = true;
    this.readLoop = this.readPort().finally(() => {
      this.listening = false;
    });
  }

  /** The spec's read loop: a fresh reader after each recoverable error, until close() or the device is lost. */
  private async readPort(): Promise<void> {
    while (this.reading) {
      const readable = this.port.readable;
      if (!readable) {
        this.options.log?.("error", "serial: the port stopped delivering data (no readable stream); reconnect the board");
        return;
      }
      const reader = readable.getReader();
      this.reader = reader;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return; // close() cancelled the read
          if (value && value.byteLength > 0) this.handleData(value);
        }
      } catch (error) {
        if (!this.reading) return;
        if (error instanceof Error && RECOVERABLE_READ_ERRORS.has(error.name)) {
          this.options.log?.("warn", `serial: read error ${describeError(error)}; reading on with a fresh reader`);
          continue;
        }
        if (error instanceof Error && error.name === "NetworkError") this.lostValue = true;
        this.options.log?.("error", `serial: reading stopped after ${describeError(error)}`);
        return;
      } finally {
        reader.releaseLock();
        if (this.reader === reader) this.reader = undefined;
      }
    }
  }

  get isOpen(): boolean {
    return this.openBaud !== undefined;
  }

  /** Open, and its read loop still delivering what the board sends. */
  get isListening(): boolean {
    return this.openBaud !== undefined && this.listening;
  }

  /** The speed the port is open at, if it is open. */
  get baud(): number | undefined {
    return this.openBaud;
  }

  on(event: "data", handler: DataListener): void {
    if (event === "data") this.subscribers.add(handler);
  }

  off(event: "data", handler: DataListener): void {
    if (event === "data") this.subscribers.delete(handler);
  }

  /** The flasher's DTR/RTS, as Web Serial's names; both lines move together (boards wire either one to RESET). */
  async setSignals(opts: SerialSignals): Promise<void> {
    await this.port.setSignals(webSerialSignals(opts));
  }

  /** Route the port to a flasher until `endFlash()`; subscribers hear nothing meanwhile. */
  beginFlash(): FlashSession {
    if (this.session) throw new Error("A flash is already running on this port.");
    const session: Session = { listeners: new Set(), queued: [], queuedBytes: 0, lastChunkAt: 0, logFirstReply: false };
    this.session = session;
    return {
      write: (data) => this.write(data),
      on: (_event, handler) => {
        session.listeners.add(handler);
        const queued = session.queued.splice(0, session.queued.length);
        session.queuedBytes = 0;
        for (const chunk of queued) this.deliver(session, chunk);
      },
      off: (_event, handler) => {
        session.listeners.delete(handler);
      },
      setSignals: (opts) => this.setSignals(opts),
      // The flasher never owns the port's lifetime; flashHex opens and closes it.
      close: async () => undefined,
    };
  }

  /** Give the port back to the subscribers, dropping the flash session's listeners and queued bytes. */
  endFlash(): void {
    this.session = undefined;
  }

  /** The USB device went away (unplugged, or the board browned out and reset its USB bridge). */
  markDisconnected(): void {
    this.lostValue = true;
  }

  /** The USB device is back (the port's `connect` event). */
  markReconnected(): void {
    this.lostValue = false;
  }

  /** Whether the board is gone right now: the port's live state where the browser has it, else the last USB event. */
  get disconnected(): boolean {
    const live = this.port.connected;
    return typeof live === "boolean" ? !live : this.lostValue;
  }

  /** Cancel the pending read, let the read loop release its lock, finish any write, then close. Close errors surface. */
  async close(): Promise<void> {
    this.reading = false;
    const reader = this.reader;
    if (reader) await reader.cancel().catch((error: unknown) => this.options.log?.("warn", `serial: cancelling the read failed: ${describeError(error)}`));
    await this.readLoop;
    await this.writes;
    try {
      await this.port.close();
    } catch (error) {
      this.openBaud = undefined;
      this.closedByUs = true;
      this.discardQueued();
      this.options.log?.("error", `serial: close failed: ${describeError(error)}`);
      throw new PortCloseError(describeError(error));
    }
    this.openBaud = undefined;
    this.closedByUs = true;
    this.discardQueued();
  }
}

/**
 * A flash that failed because the port disconnected. The bootloader library only sees its reads time out, so the
 * library's error is kept as the detail and the failure is reported as the disconnect it was.
 */
export class PortDisconnectedError extends Error {
  constructor(readonly detail: string) {
    super("The device has been lost (the USB port disconnected).");
    this.name = "NetworkError";
  }
}

export interface BoardPortConnection {
  transport: BufferedTransport;
  profile: BoardProfile;
  /** Raw Web Serial port, retained so the UI can explain the selected bridge. */
  port: SerialPort;
}

/** All known genuine and clone USB identifiers, deduplicated for requestPort(). */
export function boardUsbFilters(): WebSerialPortFilter[] {
  const seen = new Set<string>();
  const filters: WebSerialPortFilter[] = [];
  for (const profile of Object.values(BOARD_PROFILES)) {
    for (const usb of profile.usb) {
      const key = `${usb.vid}:${usb.pid}`;
      if (!seen.has(key)) {
        seen.add(key);
        filters.push({ usbVendorId: usb.vid, usbProductId: usb.pid });
      }
    }
  }
  return filters;
}

export function boardProfileForUsb(info: { usbVendorId?: number; usbProductId?: number }): BoardProfile | undefined {
  for (const profile of Object.values(BOARD_PROFILES)) {
    if (profile.usb.some((usb) => usb.vid === info.usbVendorId && usb.pid === info.usbProductId)) return profile;
  }
  return undefined;
}
export function webSerialSignals(signals: SerialSignals): { dataTerminalReady: boolean; requestToSend: boolean } {
  const value = signals.dtr ?? signals.rts;
  if (value === undefined) throw new TypeError("A DTR or RTS signal is required.");
  return { dataTerminalReady: value, requestToSend: value };
}

function requireSerial(): Serial {
  if (typeof navigator === "undefined" || !("serial" in navigator) || !navigator.serial) throw new UnsupportedWebSerialError();
  return navigator.serial;
}

/**
 * Opens the filtered native picker. This function must be called directly from
 * a user gesture; browsers intentionally reject permission prompts from effects.
 */
export async function requestBoardPort(options: { onDisconnect?: () => void; log?: BenchLog } = {}): Promise<BoardPortConnection> {
  const serial = requireSerial();
  const port = await serial.requestPort({ filters: boardUsbFilters() });
  const profile = boardProfileForUsb(port.getInfo());
  if (!profile) {
    await port.close().catch(() => undefined);
    throw new Error("That USB device is not a supported Uno or Nano. Choose an Arduino Uno/Nano port.");
  }
  const transport = new BufferedTransport(port, { log: options.log });
  port.addEventListener("disconnect", () => {
    transport.markDisconnected();
    options.onDisconnect?.();
  });
  port.addEventListener("connect", () => {
    transport.markReconnected();
    options.log?.("info", "serial: port connected again");
  });
  return { transport, profile, port };
}

export interface FlashProgress {
  stage: string;
  percent: number;
}

export interface FlashInput {
  connection: BoardPortConnection;
  hex: string;
  onProgress?: (progress: FlashProgress) => void;
  /**
   * Called once the port is open again at the telemetry baud, in the same turn the bytes go back to the port's
   * subscribers: everything the runner hears after this is from the new firmware.
   */
  onBoundary?: () => void;
  log?: BenchLog;
}
export interface FlashResult {
  baud: number;
  bytes: number;
  /**
   * Whether the port came back at the telemetry baud after the verified write. False means the firmware is on the board
   * but the port has to be reconnected (unplug and replug) before the bench can hear it; it never means "re-flash".
   */
  reopened: boolean;
}

function flasherBoard(profile: BoardProfile, timeout: number): Board {
  const key: Record<BoardProfileId, string> = {
    "uno-r3-atmega328p-5v": "arduino-uno",
    "nano-atmega328p-5v": "arduino-nano",
    "nano-atmega328p-old-5v": "arduino-nano-old",
  };
  const board = BOARDS[key[profile.id]];
  if (!board) throw new Error(`No STK500 profile is available for ${profile.name}.`);
  // flashHex resets the board itself (resetIntoBootloader), so the library must not reset it again before its sync.
  return { ...board, signature: new Uint8Array(profile.flash.signature), timeout, resetMethod: "none" };
}

export function isStkSyncFailure(error: unknown): boolean {
  return error instanceof STK500SyncError || (error instanceof Error && error.name === "STK500SyncError");
}

/** Chrome refusing DTR/RTS ("Failed to set control signals"), e.g. a Windows CH340 driver refusing the control transfer. */
function isResetFailure(error: unknown): boolean {
  return error instanceof Error && /setSignals|control signals/i.test(error.message);
}

export interface SerialFailure {
  kind: "disconnect" | "busy" | "open-failed" | "reset-failed" | "sync-timeout" | "signature" | "verify" | "stalled" | "not-open" | "other";
  message: string;
  technical: string;
}

/** Extra technical context an error carries for the "Technical details" line (e.g. bytes heard since the flash). */
function detailOf(error: unknown): string | undefined {
  return error instanceof Error && "detail" in error && typeof error.detail === "string" ? error.detail : undefined;
}

export function classifySerialError(error: unknown): SerialFailure {
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : String(error);
  const detail = detailOf(error);
  const technical = `${error instanceof Error ? `${name}: ${message}` : message}${detail ? ` (${detail})` : ""}`;
  if (name === "NetworkError" && /lost|disconnect/i.test(message)) return { kind: "disconnect", message: "The board connection was lost. Check the USB cable and power, then retry.", technical };
  // Chrome's "Failed to open serial port" covers another app holding the port, a port the OS hasn't released yet, and a
  // board that went away. "Already open" (InvalidStateError) and a failed close are this page's own handle stuck open
  // (another tab holding the port shows up as "Failed to open serial port" instead).
  if (/failed to open serial port/i.test(message)) return { kind: "open-failed", message: "The USB port would not open. Another app may be holding it (close the Arduino IDE serial monitor or another ViBread tab), or the board was unplugged — check the cable, then retry.", technical };
  if (name === "InvalidStateError" || name === "PortCloseError" || /already open/i.test(message)) return { kind: "busy", message: "The USB port is stuck open in this page. Unplug the board, reload this page, then connect again.", technical };
  if (isResetFailure(error)) return { kind: "reset-failed", message: "The board could not be reset over USB. Press and release the board's reset button, then click Retry flash within a second.", technical };
  if (isStkSyncFailure(error)) return { kind: "sync-timeout", message: "No answer from the bootloader at 115200 or 57600. Check the board type, press the board's reset button right after Retry flash, or try another USB cable.", technical };
  if (name === "STK500SignatureMismatchError") return { kind: "signature", message: "This chip is not the ATmega328P this board type expects, so nothing was written. Check the board type.", technical };
  if (name === "STK500VerifyError") return { kind: "verify", message: "The firmware was written but did not read back the same, so the board may not run it. Retry flash; if it repeats, try another USB cable.", technical };
  if (name === "STK500TimeoutError" || name === "STK500ProtocolError") return { kind: "stalled", message: "The board stopped answering partway through the flash. Check the USB cable, then retry flash.", technical };
  if (/transport not open/i.test(message)) return { kind: "not-open", message: "The USB port is closed. Choose the port again, then retry.", technical };
  return { kind: "other", message, technical };
}

/** Throttles per-page progress to the debug log: each stage's start, then one line per 10 points of the whole flash. */
function progressLogger(log: BenchLog | undefined): (stage: string, percent: number) => void {
  let lastStage = "";
  let lastTen = -1;
  return (stage, percent) => {
    const ten = Math.floor(percent / 10);
    if (stage === lastStage && ten === lastTen) return;
    lastStage = stage;
    lastTen = ten;
    log?.("info", `flash: ${stage} ${Math.round(percent)}%`);
  };
}

/**
 * How long one GET_SYNC waits for its answer before the next is sent. Optiboot (Uno/Nano) blinks the LED for ~375 ms
 * after the ~65 ms start-up delay before it reads the UART, and the ATmega's receive FIFO holds only 2 bytes: a second
 * GET_SYNC sent into that blink overruns it, Optiboot then reads a '0' where it expects the ' ' end-of-packet, and its
 * watchdog starts the old sketch — one answer (to the buffered bytes), then silence. So one GET_SYNC at a time, each
 * waiting past the end of the blink, keeps at most one command buffered.
 */
const BOOT_SYNC_WAIT_MS = 600;
const BOOT_SYNC_ATTEMPTS = 2;

/**
 * Wait for Optiboot's INSYNC OK (0x14 0x10) on the flash session, or time out. Also counts what else arrived and keeps
 * the first 16 bytes, so a failed sync says whether the line was silent, carried the old sketch's text (the reset
 * didn't take), or noise (the bootloader talks at another baud).
 */
function awaitInSync(session: FlashSession, timeoutMs: number): Promise<{ ok: boolean; heard: number; sample: Uint8Array }> {
  return new Promise((resolve) => {
    let previous = -1;
    let heard = 0;
    const sample: number[] = [];
    const onData = (chunk: Uint8Array) => {
      heard += chunk.byteLength;
      for (const byte of chunk) {
        if (sample.length < 16) sample.push(byte);
        if (previous === 0x14 && byte === 0x10) return finish(true);
        previous = byte;
      }
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    function finish(ok: boolean): void {
      clearTimeout(timer);
      session.off("data", onData);
      resolve({ ok, heard, sample: new Uint8Array(sample) });
    }
    session.on("data", onData);
  });
}

/** "12 bytes (7b 22 74 …)" for the Diagnostics log. */
function describeBytes(count: number, sample: Uint8Array): string {
  return count === 0 ? "0 bytes" : `${count} byte${count === 1 ? "" : "s"} (${toHex(sample)}${count > sample.length ? " …" : ""})`;
}

/**
 * avrdude's arduino-programmer reset: DTR+RTS off long enough to discharge the reset capacitor, a short on pulse (two
 * back-to-back setSignals calls, a few ms in Web Serial) resets the chip into the bootloader, off again so a direct
 * connection to RESET works, and a short settle. Then drain what the old sketch left behind and sync one GET_SYNC at a
 * time (see BOOT_SYNC_WAIT_MS), draining any late duplicate answer, so the library's own syncs start on a clean line.
 */
async function resetIntoBootloader(raw: BufferedTransport, session: FlashSession, baud: number, round: number, log: BenchLog | undefined): Promise<void> {
  log?.("info", `flash: reset round ${round}/${RESET_ROUNDS} at ${baud} baud (DTR+RTS off ${RESET_DISCHARGE_MS} ms, pulse on, off, wait ${RESET_SETTLE_MS} ms)`);
  await session.setSignals({ dtr: false });
  await sleep(RESET_DISCHARGE_MS);
  await session.setSignals({ dtr: true });
  await session.setSignals({ dtr: false });
  await sleep(RESET_SETTLE_MS);
  const stale = await raw.drain();
  log?.("info", `flash: drained ${stale.count} stale bytes`, stale.count > 0 ? { sample: describeBytes(stale.count, stale.sample) } : undefined);
  for (let attempt = 1; attempt <= BOOT_SYNC_ATTEMPTS; attempt += 1) {
    const answered = awaitInSync(session, BOOT_SYNC_WAIT_MS);
    await session.write(STK_GET_SYNC);
    const reply = await answered;
    if (reply.ok) {
      log?.("info", `flash: bootloader in sync on GET_SYNC ${attempt}; drained ${(await raw.drain()).count} bytes after it`);
      return;
    }
    log?.("warn", `flash: no INSYNC to GET_SYNC ${attempt}/${BOOT_SYNC_ATTEMPTS} within ${BOOT_SYNC_WAIT_MS} ms; heard ${describeBytes(reply.heard, reply.sample)}`);
  }
  throw new STK500SyncError(BOOT_SYNC_ATTEMPTS);
}

/**
 * Flash a server-built HEX over the board's bootloader (reset → sync → signature check → erase → upload → read-back
 * verify). Each bootloader baud gets up to three reset rounds, the profile's baud first and then the other common one
 * (clone Unos often ship the old 57600 bootloader). The port ends open at the telemetry baud, where the new firmware
 * says hello; if only that reopen fails, the verified flash still counts (`reopened: false`).
 */
export async function flashHex(input: FlashInput): Promise<FlashResult> {
  const { connection, hex, onProgress, log } = input;
  const board = flasherBoard(connection.profile, STK_COMMAND_TIMEOUT_MS);
  const bytes = parseIntelHex(hex).byteCount;
  const raw = connection.transport;
  const firstBaud = connection.profile.flash.baud;
  const bauds = [firstBaud, firstBaud === 115_200 ? 57_600 : 115_200];
  const session = raw.beginFlash();
  const logProgress = progressLogger(log);
  const stk = new STK500(session, board, {
    retry: SYNC_RETRY,
    // The library's own sync/signature lines; its "<stage> (N%)" lines are logged throttled below instead.
    logger: (level, message) => {
      if (!/\(\d+%\)$/.test(message) && !/^resetDevice: skipped/.test(message)) log?.(level === "error" ? "error" : level === "warn" ? "warn" : "info", `flash: ${message}`);
    },
  });
  let flashedBaud: number | undefined;
  try {
    for (let index = 0; index < bauds.length && flashedBaud === undefined; index += 1) {
      const baud = bauds[index];
      try {
        // Reuse the port when it is already open and reading at this baud: a Windows CH340/FTDI driver can refuse the
        // reopen that follows a close for seconds, and the reset below restarts the bootloader either way.
        if (raw.isListening && raw.baud === baud) log?.("info", `flash: port already open at ${baud} baud`, { board: connection.profile.id, bytes });
        else {
          if (raw.isOpen) await raw.close();
          log?.("info", `flash: open port at ${baud} baud`, { board: connection.profile.id, bytes });
          await raw.open(baud);
        }
        for (let round = 1; flashedBaud === undefined; round += 1) {
          try {
            await resetIntoBootloader(raw, session, baud, round, log);
            await stk.bootload(hex, (stage: string, percent: number) => {
              const clamped = Math.max(0, Math.min(100, percent));
              logProgress(stage, clamped);
              onProgress?.({ stage: `${stage} at ${baud}`, percent: clamped });
            });
            flashedBaud = baud;
          } catch (error) {
            if (round >= RESET_ROUNDS || !(isStkSyncFailure(error) || isResetFailure(error)) || raw.disconnected) throw error;
            log?.("warn", `flash: no answer at ${baud} baud after reset round ${round}/${RESET_ROUNDS}; resetting again`, { error: classifySerialError(error).technical });
          }
        }
      } catch (error) {
        const last = index === bauds.length - 1 || !(isStkSyncFailure(error) || isResetFailure(error)) || raw.disconnected;
        log?.(last ? "error" : "warn", `flash: failed at ${baud} baud${last ? "" : `, trying ${bauds[index + 1]}`}`, { error: classifySerialError(error).technical });
        if (last) throw error;
      }
    }
    const baud = flashedBaud ?? firstBaud;
    log?.("info", `flash: verified; reopen port at ${TELEMETRY_BAUD} baud for the bench firmware`, { flashedAt: baud });
    let reopened = true;
    try {
      await raw.close();
      await raw.open(TELEMETRY_BAUD);
    } catch (error) {
      reopened = false;
      log?.("error", `flash: firmware written and verified, but the port didn't reopen at ${TELEMETRY_BAUD} baud`, { error: classifySerialError(error).technical });
    }
    input.onBoundary?.();
    raw.endFlash();
    return { baud, bytes, reopened };
  } catch (error) {
    raw.endFlash();
    if (raw.disconnected) throw new PortDisconnectedError(classifySerialError(error).technical);
    // Whatever the board runs now (its old sketch if nothing was written) keeps talking at the telemetry baud.
    if (raw.baud !== TELEMETRY_BAUD) {
      if (raw.isOpen) await raw.close().catch(() => undefined);
      await raw.open(TELEMETRY_BAUD).catch(() => undefined);
    }
    throw error;
  }
}

export function describePort(connection: Pick<BoardPortConnection, "profile" | "port">): string {
  const info = connection.port.getInfo();
  const vid = info.usbVendorId === undefined ? "?" : `0x${info.usbVendorId.toString(16).padStart(4, "0")}`;
  const pid = info.usbProductId === undefined ? "?" : `0x${info.usbProductId.toString(16).padStart(4, "0")}`;
  return `${connection.profile.name} · USB ${vid}:${pid}`;
}
