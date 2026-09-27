import type { SerialPortLike } from "./serial.js";

/** A DOMException-shaped error, as Chrome rejects Web Serial calls with. */
function domError(name: string, message: string): Error {
  return Object.assign(new Error(message), { name });
}

/**
 * The device side of a fake port: what the board does when the page opens the port, writes, or moves DTR/RTS. Throwing
 * from `open` refuses the open (as the OS would).
 */
export interface FakeSerialDevice {
  open?(options: SerialOptions): void;
  write?(bytes: Uint8Array): void;
  signals?(signals: SerialOutputSignals): void;
  closed?(): void;
}

/**
 * A SerialPort with Chrome's Web Serial semantics, for tests: `readable`/`writable` exist only while the port is open;
 * after a recoverable read error (BufferOverrunError, …) the stream is errored and the getter hands out a fresh one;
 * after the device is lost (NetworkError) `readable` stays null; `close()` refuses while a stream is locked and leaves
 * the port "closing", so every later `open()` fails with InvalidStateError; bytes that arrive while nobody has taken
 * `readable` wait in the driver; a burst larger than `bufferSize` overruns it.
 */
export class FakeSerialPort implements SerialPortLike {
  state: "closed" | "opened" | "closing" = "closed";
  connected = true;
  readonly openOptions: SerialOptions[] = [];
  /** The next close() rejects (a driver that fails to release the handle). */
  failNextClose = false;
  private readableStream: ReadableStream<Uint8Array> | null = null;
  private controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  private writableStream: WritableStream<Uint8Array> | null = null;
  private readFatal = false;
  private pending: Uint8Array[] = [];

  constructor(private readonly device: FakeSerialDevice = {}) {}

  get readable(): ReadableStream<Uint8Array> | null {
    if (this.readableStream) return this.readableStream;
    if (this.state !== "opened" || this.readFatal) return null;
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.controller = controller;
        for (const chunk of this.pending.splice(0)) controller.enqueue(chunk);
      },
      cancel: () => {
        // Cancelling discards what the driver still holds, as Chrome does.
        this.pending = [];
        if (this.readableStream === stream) this.dropReadable();
      },
    });
    this.readableStream = stream;
    return stream;
  }

  get writable(): WritableStream<Uint8Array> | null {
    return this.state === "opened" ? this.writableStream : null;
  }

  async open(options: SerialOptions): Promise<void> {
    if (this.state !== "closed") throw domError("InvalidStateError", "Failed to execute 'open' on 'SerialPort': The port is already open.");
    this.device.open?.(options);
    this.openOptions.push(options);
    this.state = "opened";
    this.readFatal = false;
    this.pending = [];
    this.writableStream = new WritableStream<Uint8Array>({ write: (chunk) => this.device.write?.(chunk.slice()) });
  }

  async close(): Promise<void> {
    if (this.state !== "opened") throw domError("InvalidStateError", "Failed to execute 'close' on 'SerialPort': The port is already closed.");
    this.state = "closing";
    if (this.readableStream?.locked || this.writableStream?.locked) throw new TypeError("Failed to execute 'close' on 'SerialPort': Cannot cancel a locked stream");
    if (this.failNextClose) {
      this.failNextClose = false;
      throw domError("NetworkError", "Failed to execute 'close' on 'SerialPort': Failed to close serial port.");
    }
    await this.readableStream?.cancel();
    this.dropReadable();
    this.writableStream = null;
    this.pending = [];
    this.state = "closed";
    this.device.closed?.();
  }

  async setSignals(signals: SerialOutputSignals = {}): Promise<void> {
    if (this.state !== "opened") throw domError("InvalidStateError", "Failed to execute 'setSignals' on 'SerialPort': The port is closed.");
    this.device.signals?.(signals);
  }

  /** Bytes from the board. More than `bufferSize` at once overruns the driver's receive buffer. */
  receive(bytes: Uint8Array): void {
    if (this.state !== "opened" || this.readFatal) return;
    if (bytes.byteLength > (this.openOptions.at(-1)?.bufferSize ?? 255)) {
      this.failRead("BufferOverrunError", "The receive buffer overflowed.");
      return;
    }
    if (this.controller) this.controller.enqueue(bytes);
    else this.pending.push(bytes);
  }

  /** A recoverable read error: the current stream errors and `readable` hands out a fresh one. */
  failRead(name: "BufferOverrunError" | "FramingError" | "ParityError" | "BreakError" | "UnknownError", message = "Read error."): void {
    const controller = this.controller;
    this.dropReadable();
    controller?.error(domError(name, message));
  }

  /** The USB device goes away: the read fails with NetworkError and `readable` stays null. */
  lose(): void {
    this.connected = false;
    this.readFatal = true;
    const controller = this.controller;
    this.dropReadable();
    controller?.error(domError("NetworkError", "The device has been lost."));
  }

  private dropReadable(): void {
    this.readableStream = null;
    this.controller = undefined;
  }
}
