import type { BoardProfile, BoardProfileId } from "@vibread/core";
import { BOARD_PROFILES } from "@vibread/core";
import { BOARDS, STK500, WebSerialTransport } from "webserial-flasher";
import type { Board, ISTKTransport, SerialSignals } from "webserial-flasher";
import type { WebSerialPortFilter } from "webserial-flasher";

/** The browsers in which ViBread has a tested Web Serial implementation. */
export const WEB_SERIAL_BROWSERS = "Chrome or Edge" as const;

export class UnsupportedWebSerialError extends Error {
  constructor() {
    super("Web Serial is unavailable. Use Chrome or Edge on the laptop, or use the arduino-cli fallback.");
    this.name = "UnsupportedWebSerialError";
  }
}

/**
 * The transport in webserial-flasher 1.0.1 installs its response listener after
 * awaiting write(). A USB serial bridge can answer during write, so this adapter
 * keeps a small receive queue until the flasher attaches its listener.
 */
export class BufferedTransport implements ISTKTransport {
  private readonly listeners = new Set<(chunk: Uint8Array) => void>();
  private readonly queued: Uint8Array[] = [];
  private readonly handleData = (chunk: Uint8Array): void => {
    if (this.listeners.size === 0) {
      this.queued.push(chunk.slice());
      return;
    }
    for (const listener of this.listeners) listener(chunk);
  };

  constructor(private readonly inner: ISTKTransport) {
    inner.on("data", this.handleData);
  }

  async write(data: Uint8Array): Promise<void> {
    await this.inner.write(data);
  }

  async open(baudRate: number, options?: Record<string, unknown>): Promise<void> {
    const opener = this.inner as ISTKTransport & { open?: (rate: number, opts?: Record<string, unknown>) => Promise<void> };
    if (!opener.open) throw new Error("The selected serial transport cannot be opened.");
    await opener.open(baudRate, options);
  }

  get isOpen(): boolean {
    return Boolean((this.inner as ISTKTransport & { isOpen?: boolean }).isOpen);
  }

  on(event: "data", handler: (chunk: Uint8Array) => void): void {
    if (event !== "data") return;
    this.listeners.add(handler);
    if (this.queued.length === 0) return;
    const queued = this.queued.splice(0, this.queued.length);
    for (const chunk of queued) handler(chunk);
  }

  off(event: "data", handler: (chunk: Uint8Array) => void): void {
    if (event === "data") this.listeners.delete(handler);
  }

  async setSignals(opts: SerialSignals): Promise<void> {
    if (this.inner.setSignals) await this.inner.setSignals(opts);
  }

  async close(): Promise<void> {
    this.inner.off("data", this.handleData);
    this.listeners.clear();
    this.queued.splice(0, this.queued.length);
    await this.inner.close();
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

function requireSerial(): Serial {
  if (typeof navigator === "undefined" || !("serial" in navigator) || !navigator.serial) throw new UnsupportedWebSerialError();
  return navigator.serial;
}

/**
 * Opens the filtered native picker. This function must be called directly from
 * a user gesture; browsers intentionally reject permission prompts from effects.
 */
export async function requestBoardPort(): Promise<BoardPortConnection> {
  const serial = requireSerial();
  const port = await serial.requestPort({ filters: boardUsbFilters() });
  const profile = boardProfileForUsb(port.getInfo());
  if (!profile) {
    await port.close().catch(() => undefined);
    throw new Error("That USB device is not a supported Uno or Nano. Choose an Arduino Uno/Nano port.");
  }
  const rawTransport = new WebSerialTransport(port);
  return { transport: new BufferedTransport(rawTransport), profile, port };
}

export interface FlashProgress {
  stage: string;
  percent: number;
}

export interface FlashInput {
  connection: BoardPortConnection;
  hex: string;
  onProgress?: (progress: FlashProgress) => void;
}

function flasherBoard(profile: BoardProfile): Board {
  const key: Record<BoardProfileId, string> = {
    "uno-r3-atmega328p-5v": "arduino-uno",
    "nano-atmega328p-5v": "arduino-nano",
    "nano-atmega328p-old-5v": "arduino-nano-old",
  };
  const board = BOARDS[key[profile.id]];
  if (!board) throw new Error(`No STK500 profile is available for ${profile.name}.`);
  return board;
}

/** Flash a server-built HEX and verify the ATmega328P signature before upload. */
export async function flashHex(input: FlashInput): Promise<void> {
  const { connection, hex, onProgress } = input;
  const board = flasherBoard(connection.profile);
  const raw = connection.transport;
  await raw.open(connection.profile.flash.baud);

  const stk = new STK500(raw, board, { quiet: true });
  await stk.resetDevice();
  const signature = await stk.verifySignature();
  const expected = connection.profile.flash.signature;
  if (signature[1] !== expected[0] || signature[2] !== expected[1] || signature[3] !== expected[2]) {
    throw new Error(`Board signature mismatch. Expected ${expected.map((part) => part.toString(16).padStart(2, "0")).join(" ")}.`);
  }
  await stk.bootload(hex, (stageOrPercent: string | number, maybePercent?: number) => {
    const stage = typeof stageOrPercent === "string" ? stageOrPercent : "upload";
    const percent = typeof stageOrPercent === "number" ? stageOrPercent : maybePercent ?? 0;
    onProgress?.({ stage, percent: Math.max(0, Math.min(100, percent)) });
  });
}

export function describePort(connection: Pick<BoardPortConnection, "profile" | "port">): string {
  const info = connection.port.getInfo();
  const vid = info.usbVendorId === undefined ? "?" : `0x${info.usbVendorId.toString(16).padStart(4, "0")}`;
  const pid = info.usbProductId === undefined ? "?" : `0x${info.usbProductId.toString(16).padStart(4, "0")}`;
  return `${connection.profile.name} · USB ${vid}:${pid}`;
}
