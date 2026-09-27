import type { BoardProfile, BoardProfileId } from "@vibread/core";
import { BOARD_PROFILES } from "@vibread/core";
import { BOARDS, STK500, STK500SyncError, WebSerialTransport, parseIntelHex } from "webserial-flasher";
import type { Board, ISTKTransport, SerialSignals } from "webserial-flasher";
import type { WebSerialPortFilter } from "webserial-flasher";
import type { BenchLog } from "./benchLog.js";

/** The browsers in which ViBread has a tested Web Serial implementation. */
export const WEB_SERIAL_BROWSERS = "Chrome or Edge" as const;
/** Bench firmware's fixed NDJSON serial speed (core telemetry protocol). */
export const TELEMETRY_BAUD = 115_200 as const;
/**
 * Per-command bootloader timeout. Optiboot gives up and starts the sketch about a second after a reset, so the
 * library's 10 s default only delays the 57600 fallback; every command, including a 128-byte page, answers within
 * milliseconds when the baud is right.
 */
const STK_COMMAND_TIMEOUT_MS = 1_000;

export class UnsupportedWebSerialError extends Error {
  constructor() {
    super("Web Serial is unavailable. Use Chrome or Edge on the laptop, or use the arduino-cli fallback.");
    this.name = "UnsupportedWebSerialError";
  }
}

export type SignalSetter = (signals: SerialSignals) => Promise<void>;
type DataListener = (chunk: Uint8Array) => void;

/** The bootloader's view of the port for one flash: its own listeners, and a queue until it subscribes. */
export interface FlashSession extends ISTKTransport {
  setSignals(opts: SerialSignals): Promise<void>;
}

/**
 * One board's serial port, shared by the bench runner and the flasher.
 *
 * Subscribers (the bench runner) stay attached across close/open, so the runner still hears the board after a flash
 * reopens the port. While a flash session is active, bytes go only to that session: the runner never sees STK500
 * traffic, and the flasher's listeners are dropped with the session, so none leak into later reads. The session
 * queues bytes until the flasher subscribes, because webserial-flasher 1.0.1 installs its response listener only
 * after awaiting write(), and a USB serial bridge can answer during the write.
 */
export class BufferedTransport implements ISTKTransport {
  private readonly subscribers = new Set<DataListener>();
  private session: { listeners: Set<DataListener>; queued: Uint8Array[] } | undefined;
  private openBaud: number | undefined;
  private lostValue = false;
  private readonly handleData = (chunk: Uint8Array): void => {
    const session = this.session;
    if (!session) {
      for (const listener of this.subscribers) listener(chunk);
      return;
    }
    if (session.listeners.size === 0) session.queued.push(chunk.slice());
    else for (const listener of session.listeners) listener(chunk);
  };

  constructor(private readonly inner: ISTKTransport, private readonly signalSetter?: SignalSetter) {
    inner.on("data", this.handleData);
  }

  async write(data: Uint8Array): Promise<void> {
    await this.inner.write(data);
  }

  async open(baudRate: number, options?: Record<string, unknown>): Promise<void> {
    const opener = this.inner as ISTKTransport & { open?: (rate: number, opts?: Record<string, unknown>) => Promise<void> };
    if (!opener.open) throw new Error("The selected serial transport cannot be opened.");
    // WebSerialTransport.close() drops its listeners; re-attach before the read loop starts.
    this.inner.on("data", this.handleData);
    await opener.open(baudRate, options);
    this.openBaud = baudRate;
  }

  get isOpen(): boolean {
    return this.openBaud !== undefined;
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

  async setSignals(opts: SerialSignals): Promise<void> {
    if (this.signalSetter) await this.signalSetter(opts);
    else if (this.inner.setSignals) await this.inner.setSignals(opts);
  }

  /** Route the port to a flasher until `endFlash()`; subscribers hear nothing meanwhile. */
  beginFlash(): FlashSession {
    if (this.session) throw new Error("A flash is already running on this port.");
    const session = { listeners: new Set<DataListener>(), queued: [] as Uint8Array[] };
    this.session = session;
    return {
      write: (data) => this.write(data),
      on: (_event, handler) => {
        session.listeners.add(handler);
        const queued = session.queued.splice(0, session.queued.length);
        for (const chunk of queued) handler(chunk);
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

  get disconnected(): boolean {
    return this.lostValue;
  }

  async close(): Promise<void> {
    this.openBaud = undefined;
    await this.inner.close();
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
export async function requestBoardPort(options: { onDisconnect?: () => void } = {}): Promise<BoardPortConnection> {
  const serial = requireSerial();
  const port = await serial.requestPort({ filters: boardUsbFilters() });
  const profile = boardProfileForUsb(port.getInfo());
  if (!profile) {
    await port.close().catch(() => undefined);
    throw new Error("That USB device is not a supported Uno or Nano. Choose an Arduino Uno/Nano port.");
  }
  const rawTransport = new WebSerialTransport(port);
  const transport = new BufferedTransport(rawTransport, async (signals) => {
    await port.setSignals(webSerialSignals(signals));
  });
  port.addEventListener("disconnect", () => {
    transport.markDisconnected();
    options.onDisconnect?.();
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
  /** Bootloader command timeout (tests use a short one; see STK_COMMAND_TIMEOUT_MS). */
  commandTimeoutMs?: number;
}
export interface FlashResult {
  baud: number;
  bytes: number;
}

function flasherBoard(profile: BoardProfile, timeout: number): Board {
  const key: Record<BoardProfileId, string> = {
    "uno-r3-atmega328p-5v": "arduino-uno",
    "nano-atmega328p-5v": "arduino-nano",
    "nano-atmega328p-old-5v": "arduino-nano-old",
  };
  const board = BOARDS[key[profile.id]];
  if (!board) throw new Error(`No STK500 profile is available for ${profile.name}.`);
  return { ...board, signature: new Uint8Array(profile.flash.signature), timeout };
}

export function isStkSyncFailure(error: unknown): boolean {
  return error instanceof STK500SyncError || (error instanceof Error && error.name === "STK500SyncError");
}

export interface SerialFailure {
  kind: "disconnect" | "busy" | "sync-timeout" | "signature" | "verify" | "stalled" | "not-open" | "other";
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
  if (name === "InvalidStateError" || /already open|failed to open serial port/i.test(message)) return { kind: "busy", message: "Another app is using this USB port. Close the Arduino IDE serial monitor or another ViBread tab, then retry.", technical };
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
 * Flash a server-built HEX over the board's bootloader (reset → sync → signature check → erase → upload → read-back
 * verify), trying the profile's bootloader baud and then the other common one (clone Unos often ship the old 57600
 * bootloader). The port ends open at the telemetry baud, where the new firmware says hello.
 */
export async function flashHex(input: FlashInput): Promise<FlashResult> {
  const { connection, hex, onProgress, log } = input;
  const board = flasherBoard(connection.profile, input.commandTimeoutMs ?? STK_COMMAND_TIMEOUT_MS);
  const bytes = parseIntelHex(hex).byteCount;
  const raw = connection.transport;
  const firstBaud = connection.profile.flash.baud;
  const bauds = [firstBaud, firstBaud === 115_200 ? 57_600 : 115_200];
  const session = raw.beginFlash();
  const logProgress = progressLogger(log);
  let flashedBaud: number | undefined;
  try {
    for (let index = 0; index < bauds.length && flashedBaud === undefined; index += 1) {
      const baud = bauds[index];
      try {
        if (raw.isOpen) await raw.close();
        log?.("info", `flash: open port at ${baud} baud`, { board: connection.profile.id, bytes });
        await raw.open(baud);
        const stk = new STK500(session, board, {
          // The library's own reset/sync/signature lines; its "<stage> (N%)" lines are logged throttled below instead.
          logger: (level, message) => {
            if (!/\(\d+%\)$/.test(message)) log?.(level === "error" ? "error" : level === "warn" ? "warn" : "info", `flash: ${message}`);
          },
        });
        await stk.bootload(hex, (stage: string, percent: number) => {
          const clamped = Math.max(0, Math.min(100, percent));
          logProgress(stage, clamped);
          onProgress?.({ stage: `${stage} at ${baud}`, percent: clamped });
        });
        flashedBaud = baud;
      } catch (error) {
        const last = index === bauds.length - 1 || !isStkSyncFailure(error) || raw.disconnected;
        log?.(last ? "error" : "warn", `flash: failed at ${baud} baud${last ? "" : `, trying ${bauds[index + 1]}`}`, { error: classifySerialError(error).technical });
        if (last) throw error;
      }
    }
    const baud = flashedBaud ?? firstBaud;
    log?.("info", `flash: verified; reopen port at ${TELEMETRY_BAUD} baud for the bench firmware`, { flashedAt: baud });
    await raw.close();
    await raw.open(TELEMETRY_BAUD);
    input.onBoundary?.();
    raw.endFlash();
    return { baud, bytes };
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
