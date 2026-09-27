import type { BenchRunResult, Circuit, DeviceLine, DecodedLine, HostCommand, SelfTestPlan, TestId } from "@vibread/core";
import { decodeDeviceLine, encodeHostCommand } from "@vibread/core";
import { LineDecoder } from "@vibread/bench";
import type { BenchLog } from "./benchLog.js";

export interface BenchTransport {
  write(data: Uint8Array): Promise<void>;
  on(event: "data", handler: (data: Uint8Array) => void): void;
  off(event: "data", handler: (data: Uint8Array) => void): void;
  close(): Promise<void>;
}

export type RunnerPhase = "idle" | "rail" | "selftest" | "complete" | "error";

export interface BenchRunnerState {
  phase: RunnerPhase;
  lines: DeviceLine[];
  rawLines: string[];
  asks: Extract<DeviceLine, { t: "ask" }>[];
  answers: Record<string, string>;
  /** Latest hello / VCC reading since the last flash (a banner from the board's previous firmware doesn't count). */
  seenHello: Extract<DeviceLine, { t: "hello" }> | undefined;
  seenVcc: Extract<DeviceLine, { t: "vcc" }> | undefined;
  /** Index into `lines` where the current firmware's output starts (0 until a flash). */
  flashBoundary: number;
  done: boolean;
  error?: string;
}

type TimerHandle = number | NodeJS.Timeout;

interface PendingLine<T extends DeviceLine> {
  resolve: (line: T) => void;
  reject: (reason: Error) => void;
  timer: TimerHandle;
  match: (line: DeviceLine) => line is T;
}

/**
 * A line with noise before its JSON (a bootloader byte or a half line from before a reset) decodes as invalid; the
 * JSON after the noise is still the device talking.
 */
function recoverLine(line: DecodedLine): DecodedLine {
  if (line.t !== "invalid") return line;
  const start = line.raw.indexOf("{");
  if (start <= 0) return line;
  const recovered = decodeDeviceLine(line.raw.slice(start));
  return recovered.t === "invalid" ? line : recovered;
}

export type BenchRunnerEvent =
  | { type: "connected" }
  | { type: "command"; command: HostCommand }
  | { type: "line"; line: DecodedLine }
  | { type: "transport-error"; message: string }
  | { type: "flashed" }
  | { type: "reset" };

export function initialRunnerState(): BenchRunnerState {
  return {
    phase: "idle",
    lines: [],
    rawLines: [],
    asks: [],
    answers: {},
    seenHello: undefined,
    seenVcc: undefined,
    flashBoundary: 0,
    done: false,
  };
}

/** Pure state transition used by the browser runner and its focused tests. */
export function runnerReducer(state: BenchRunnerState, event: BenchRunnerEvent): BenchRunnerState {
  switch (event.type) {
    case "connected":
      return { ...state, phase: "idle", error: undefined };
    case "reset":
      return initialRunnerState();
    case "flashed":
      // The log stays visible; only what the new firmware says counts from here.
      return { ...state, phase: "idle", seenHello: undefined, seenVcc: undefined, flashBoundary: state.lines.length, error: undefined };
    case "transport-error":
      return { ...state, phase: "error", error: event.message };
    case "command":
      if (event.command.c === "hello") return { ...state, phase: "rail", error: undefined };
      if (event.command.c === "run") {
        if (event.command.test === "rails.vcc") return { ...state, phase: "rail", done: false, error: undefined };
        return { ...state, phase: "selftest", done: false, error: undefined };
      }
      if (event.command.c === "answer") {
        return { ...state, answers: { ...state.answers, [event.command.id]: event.command.v } };
      }
      return state;
    case "line": {
      if (event.line.t === "invalid") return { ...state, rawLines: [...state.rawLines, event.line.raw] };
      const lines = [...state.lines, event.line];
      const next: BenchRunnerState = { ...state, lines, rawLines: [...state.rawLines, JSON.stringify(event.line)] };
      if (event.line.t === "hello") next.seenHello = event.line;
      if (event.line.t === "vcc") next.seenVcc = event.line;
      if (event.line.t === "ask") next.asks = [event.line];
      if (event.line.t === "done") {
        next.done = true;
        next.asks = [];
        next.phase = "complete";
      }
      return next;
    }
  }
}

export interface BenchRunnerOptions {
  plan: SelfTestPlan;
  circuit: Circuit;
  revision: number;
  runId?: string;
  transport: BenchTransport;
  onState?: (state: BenchRunnerState) => void;
  /** Serial events for the laptop debug log (hello, VCC, timeouts with bytes heard). */
  log?: BenchLog;
  /** Waits for the board (tests shorten them). */
  timeouts?: { helloMs?: number; vccMs?: number };
}

/** A board-check failure worded for the person, with the serial facts behind it for "Technical details". */
export class BoardCheckError extends Error {
  constructor(message: string, readonly detail: string) {
    super(message);
    this.name = "BoardCheckError";
  }
}

/**
 * NDJSON host/device loop. Physical actions are deliberately explicit methods;
 * receiving a line never sends a command except an answer requested by a click.
 */
export class BenchRunner {
  readonly plan: SelfTestPlan;
  readonly circuit: Circuit;
  readonly revision: number;
  readonly runId: string;
  private decoder = new LineDecoder();
  private bytesSinceFlashValue = 0;
  private readonly onState?: (state: BenchRunnerState) => void;
  private readonly log?: BenchLog;
  private readonly helloMs: number;
  private readonly vccMs: number;
  private readonly handleData = (data: Uint8Array): void => {
    this.bytesSinceFlashValue += data.byteLength;
    for (const line of this.decoder.push(new TextDecoder().decode(data))) this.dispatch({ type: "line", line: recoverLine(line) });
  };
  private stateValue = initialRunnerState();
  private readonly helloWaiters: PendingLine<Extract<DeviceLine, { t: "hello" }>>[] = [];
  private readonly vccWaiters: PendingLine<Extract<DeviceLine, { t: "vcc" }>>[] = [];
  private readonly endWaiters: PendingLine<Extract<DeviceLine, { t: "end" }>>[] = [];
  private subsetTests: TestId[] | undefined;
  private readonly askTimeouts = new Map<string, TimerHandle>();
  private readonly askWatchdogs = new Map<string, TimerHandle>();
  constructor(options: BenchRunnerOptions) {
    this.plan = options.plan;
    this.circuit = options.circuit;
    this.revision = options.revision;
    this.runId = options.runId ?? `bench-${Date.now().toString(36)}`;
    this.onState = options.onState;
    this.log = options.log;
    this.helloMs = options.timeouts?.helloMs ?? 2_000;
    this.vccMs = options.timeouts?.vccMs ?? 5_000;
    options.transport.on("data", this.handleData);
    this.transport = options.transport;
    this.dispatch({ type: "connected" });
  }

  private readonly transport: BenchTransport;

  get state(): BenchRunnerState {
    return this.stateValue;
  }

  /**
   * The board now runs freshly flashed firmware: a partial line from before is dropped, bytes are counted from zero,
   * and only a hello that arrives from here on counts. Call in the same turn the port is handed back after the flash.
   */
  markFlashBoundary(): void {
    this.decoder = new LineDecoder();
    this.bytesSinceFlashValue = 0;
    this.dispatch({ type: "flashed" });
  }

  /** Bytes heard since the last flash (since connect when nothing was flashed). */
  get bytesSinceFlash(): number {
    return this.bytesSinceFlashValue;
  }

  /** A hello from the current firmware for exactly this revision's design and board, if one arrived. */
  get matchingHello(): Extract<DeviceLine, { t: "hello" }> | undefined {
    const hello = this.state.seenHello;
    return hello && hello.design === this.plan.design && hello.board === this.plan.board ? hello : undefined;
  }

  private dispatch(event: BenchRunnerEvent): void {
    this.stateValue = runnerReducer(this.stateValue, event);
    if (event.type === "line" && event.line.t !== "invalid") {
      const line = event.line;
      if (line.t === "hello") {
        this.log?.("info", `serial: hello design ${line.design} board ${line.board}`, { fw: line.fw, proto: line.proto, bytesSinceFlash: this.bytesSinceFlashValue });
        this.resolveWaiters(this.helloWaiters, line);
      }
      if (line.t === "vcc") {
        this.log?.("info", `serial: VCC ${line.mv} mV`);
        this.resolveWaiters(this.vccWaiters, line);
      }
      if (line.t === "end") this.resolveWaiters(this.endWaiters, line);
      this.clearAskWatchdogs();
      if (line.t === "ask") {
        this.clearAskTimeouts();
        const ask = line;
        if (ask.timeoutMs > 0) {
          const linesAtAsk = this.state.lines.length;
          const timeout = setTimeout(() => {
            if (this.state.answers[ask.id] === undefined) {
              void this.sendTimeoutAnswer(ask.id).catch((reason: unknown) => this.fail(reason instanceof Error ? reason.message : String(reason)));
            }
          }, ask.timeoutMs);
          const watchdog = setTimeout(() => {
            if (this.state.lines.length <= linesAtAsk) this.fail("The board stopped answering during the self-test. Check the cable and power, then retry.");
          }, ask.timeoutMs + 5_000);
          this.askTimeouts.set(ask.id, timeout);
          this.askWatchdogs.set(ask.id, watchdog);
        }
      }
      if (line.t === "done") this.clearAskTimers();
    }
    if (event.type === "transport-error") this.rejectWaiters(new Error(event.message));
    this.onState?.(this.stateValue);
  }

  private resolveWaiters<T extends DeviceLine>(waiters: PendingLine<T>[], line: T): void {
    for (const waiter of waiters.filter((candidate) => candidate.match(line))) {
      waiters.splice(waiters.indexOf(waiter), 1);
      clearTimeout(waiter.timer);
      waiter.resolve(line);
    }
  }

  private rejectWaiters(reason: Error): void {
    const waiters = [...this.helloWaiters, ...this.vccWaiters, ...this.endWaiters];
    this.helloWaiters.splice(0, this.helloWaiters.length);
    this.vccWaiters.splice(0, this.vccWaiters.length);
    this.endWaiters.splice(0, this.endWaiters.length);
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(reason);
    }
  }

  private clearAskTimeouts(): void {
    for (const timer of this.askTimeouts.values()) clearTimeout(timer);
    this.askTimeouts.clear();
  }

  private clearAskWatchdogs(): void {
    for (const timer of this.askWatchdogs.values()) clearTimeout(timer);
    this.askWatchdogs.clear();
  }

  private clearAskTimers(): void {
    this.clearAskTimeouts();
    this.clearAskWatchdogs();
  }

  /** The first matching line at or after `from` in the log, else the next one to arrive within `timeoutMs`. */
  private waitForLine<T extends DeviceLine>(
    waiters: PendingLine<T>[],
    match: (line: DeviceLine) => line is T,
    name: string,
    timeoutMs: number,
    from: number,
  ): Promise<T> {
    const existing = this.state.lines.slice(from).find(match);
    if (existing !== undefined) return Promise.resolve(existing);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = waiters.findIndex((waiter) => waiter.timer === timer);
        if (index >= 0) waiters.splice(index, 1);
        reject(new Error(`Timed out waiting for ${name}.`));
      }, timeoutMs);
      waiters.push({ resolve, reject, timer, match });
    });
  }
  private async send(command: HostCommand): Promise<void> {
    this.dispatch({ type: "command", command });
    await this.transport.write(new TextEncoder().encode(encodeHostCommand(command)));
  }

  /** Start the rail/banner checkpoint. Call only from the Connect → Rail click. */
  async startRail(): Promise<void> {
    const anyHello = (line: DeviceLine): line is Extract<DeviceLine, { t: "hello" }> => line.t === "hello";
    // Only the firmware running now counts: a banner from before the last flash is the old firmware talking.
    let hello = this.state.lines.slice(this.state.flashBoundary).findLast(anyHello);
    for (let attempt = 0; hello === undefined && attempt < 3; attempt += 1) {
      await this.send({ c: "hello" });
      try {
        hello = await this.waitForLine(this.helloWaiters, anyHello, "hello banner", this.helloMs, this.state.flashBoundary);
      } catch {
        if (attempt < 2) continue;
        const bytes = this.bytesSinceFlashValue;
        const detail = `no hello after 3 requests ${this.helloMs} ms apart; ${bytes} byte${bytes === 1 ? "" : "s"} received since the flash`;
        this.log?.("error", `serial: hello timeout (${detail})`);
        throw new BoardCheckError(
          bytes > 0 ? "The board answers, but not with ViBread's safe firmware (maybe your previous sketch is still running). Flash safe firmware again." : "No bytes arrived from the board after the flash. Check the port and the USB cable, then flash again.",
          detail,
        );
      }
    }
    if (!hello) throw new Error("No hello banner arrived from the board.");
    if (hello.design !== this.plan.design || hello.board !== this.plan.board) {
      throw new BoardCheckError(
        "The board runs ViBread firmware for another design or board. Flash safe firmware again.",
        `hello design ${hello.design} board ${hello.board}; expected design ${this.plan.design} board ${this.plan.board}`,
      );
    }
    const from = this.state.lines.length;
    await this.send({ c: "run", test: "rails.vcc" });
    try {
      await this.waitForLine(this.vccWaiters, (line): line is Extract<DeviceLine, { t: "vcc" }> => line.t === "vcc", "VCC reading", this.vccMs, from);
    } catch (error) {
      this.log?.("error", `serial: no VCC reading within ${this.vccMs} ms`, { bytesSinceFlash: this.bytesSinceFlashValue });
      throw error;
    }
  }

  /** Start all planned read-before-drive tests. */
  /** Run the full suite, or selected test IDs for a Build Steps checkpoint. */
  async startSelfTest(tests?: TestId[]): Promise<void> {
    if (!tests || tests.length === 0) {
      await this.send({ c: "run", test: "all" });
      return;
    }
    this.subsetTests = [...tests];
    for (const test of tests) {
      const from = this.state.lines.length;
      await this.send({ c: "run", test });
      await this.waitForLine(this.endWaiters, (line): line is Extract<DeviceLine, { t: "end" }> => line.t === "end" && line.test === test, `${test} test`, 30_000, from);
    }
    this.stateValue = { ...this.stateValue, done: true, phase: "complete" };
    this.onState?.(this.stateValue);
  }

  private async sendTimeoutAnswer(id: string): Promise<void> {
    if (!this.state.asks.some((candidate) => candidate.id === id) || this.state.answers[id] !== undefined) return;
    const timeout = this.askTimeouts.get(id);
    if (timeout !== undefined) {
      clearTimeout(timeout);
      this.askTimeouts.delete(id);
    }
    await this.send({ c: "answer", id, v: "timeout" });
  }

  /** Answer one visible ask button and resume the firmware. */
  async answer(id: string, value: string): Promise<void> {
    const ask = this.state.asks.find((candidate) => candidate.id === id);
    if (!ask) throw new Error(`The device did not ask for ${id}.`);
    const timeout = this.askTimeouts.get(id);
    if (timeout !== undefined) {
      clearTimeout(timeout);
      this.askTimeouts.delete(id);
    }
    const watchdog = this.askWatchdogs.get(id);
    if (watchdog !== undefined) {
      clearTimeout(watchdog);
      this.askWatchdogs.delete(id);
    }
    await this.send({ c: "answer", id, v: value });
  }

  /** Build the exact server request after the device sent `done`. */
  runRequest(kind: BenchRunResult["kind"] = "selftest"): {
    revision: number;
    kind: BenchRunResult["kind"];
    plan: SelfTestPlan;
    lines: DeviceLine[];
    answers: Record<string, string>;
  } {
    // Only the current firmware's lines belong to this run (the old firmware's banner is not part of it).
    return { revision: this.revision, kind, plan: this.subsetTests ? { ...this.plan, tests: [...this.subsetTests] } : this.plan, lines: this.state.lines.slice(this.state.flashBoundary), answers: { ...this.state.answers } };
  }

  fail(message: string): void {
    this.clearAskTimers();
    this.rejectWaiters(new Error(message));
    this.dispatch({ type: "transport-error", message });
  }

  dispose(): void {
    this.clearAskTimers();
    this.rejectWaiters(new Error("Bench connection closed."));
    this.transport.off("data", this.handleData);
  }
}

export function decodedDeviceLine(line: string): DecodedLine {
  return decodeDeviceLine(line);
}

export function createBenchRunner(options: BenchRunnerOptions): BenchRunner {
  return new BenchRunner(options);
}
