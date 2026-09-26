import type { BenchRunResult, Circuit, DeviceLine, DecodedLine, HostCommand, SelfTestPlan } from "@vibread/core";
import { decodeDeviceLine, encodeHostCommand } from "@vibread/core";
import { LineDecoder } from "@vibread/bench";

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
  seenHello: Extract<DeviceLine, { t: "hello" }> | undefined;
  seenVcc: Extract<DeviceLine, { t: "vcc" }> | undefined;
  done: boolean;
  error?: string;
}

type TimerHandle = number | NodeJS.Timeout;

interface PendingLine<T extends DeviceLine> {
  resolve: (line: T) => void;
  reject: (reason: Error) => void;
  timer: TimerHandle;
}

export type BenchRunnerEvent =
  | { type: "connected" }
  | { type: "command"; command: HostCommand }
  | { type: "line"; line: DecodedLine }
  | { type: "transport-error"; message: string }
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
      if (event.line.t === "ask") next.asks = [...state.asks, event.line];
      if (event.line.t === "done") {
        next.done = true;
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
  private readonly decoder = new LineDecoder();
  private readonly onState?: (state: BenchRunnerState) => void;
  private readonly handleData = (data: Uint8Array): void => {
    const text = new TextDecoder().decode(data);
    for (const line of this.decoder.push(text)) this.dispatch({ type: "line", line });
  };
  private stateValue = initialRunnerState();
  private readonly helloWaiters: PendingLine<Extract<DeviceLine, { t: "hello" }>>[] = [];
  private readonly vccWaiters: PendingLine<Extract<DeviceLine, { t: "vcc" }>>[] = [];
  private readonly askTimers = new Map<string, TimerHandle>();

  constructor(options: BenchRunnerOptions) {
    this.plan = options.plan;
    this.circuit = options.circuit;
    this.revision = options.revision;
    this.runId = options.runId ?? `bench-${Date.now().toString(36)}`;
    this.onState = options.onState;
    options.transport.on("data", this.handleData);
    this.transport = options.transport;
    this.dispatch({ type: "connected" });
  }

  private readonly transport: BenchTransport;

  get state(): BenchRunnerState {
    return this.stateValue;
  }

  private dispatch(event: BenchRunnerEvent): void {
    this.stateValue = runnerReducer(this.stateValue, event);
    if (event.type === "line" && event.line.t !== "invalid") {
      if (event.line.t === "hello") this.resolveWaiters(this.helloWaiters, event.line);
      if (event.line.t === "vcc") this.resolveWaiters(this.vccWaiters, event.line);
      if (event.line.t === "ask") {
        const ask = event.line;
        const timer = setTimeout(() => {
          if (this.state.answers[ask.id] === undefined) this.fail(`Self-test timed out waiting for ${ask.id}.`);
        }, ask.timeoutMs + 5_000);
        this.askTimers.set(ask.id, timer);
      }
      if (event.line.t === "done") this.clearAskTimers();
    }
    if (event.type === "transport-error") this.rejectWaiters(new Error(event.message));
    this.onState?.(this.stateValue);
  }

  private resolveWaiters<T extends DeviceLine>(waiters: PendingLine<T>[], line: T): void {
    const pending = waiters.splice(0, waiters.length);
    for (const waiter of pending) {
      clearTimeout(waiter.timer);
      waiter.resolve(line);
    }
  }

  private rejectWaiters(reason: Error): void {
    const waiters = [...this.helloWaiters, ...this.vccWaiters];
    this.helloWaiters.splice(0, this.helloWaiters.length);
    this.vccWaiters.splice(0, this.vccWaiters.length);
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(reason);
    }
  }

  private clearAskTimers(): void {
    for (const timer of this.askTimers.values()) clearTimeout(timer);
    this.askTimers.clear();
  }

  private waitForLine<T extends DeviceLine>(
    waiters: PendingLine<T>[],
    match: (line: DeviceLine) => line is T,
    name: string,
    timeoutMs: number,
  ): Promise<T> {
    const existing = this.state.lines.find(match);
    if (existing !== undefined) return Promise.resolve(existing);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = waiters.findIndex((waiter) => waiter.timer === timer);
        if (index >= 0) waiters.splice(index, 1);
        reject(new Error(`Timed out waiting for ${name}.`));
      }, timeoutMs);
      waiters.push({ resolve, reject, timer });
    });
  }
  private async send(command: HostCommand): Promise<void> {
    this.dispatch({ type: "command", command });
    await this.transport.write(new TextEncoder().encode(encodeHostCommand(command)));
  }

  /** Start the rail/banner checkpoint. Call only from the Connect → Rail click. */
  async startRail(): Promise<void> {
    const matchesRevision = (line: DeviceLine): line is Extract<DeviceLine, { t: "hello" }> => line.t === "hello" && line.design === this.plan.design && line.board === this.plan.board;
    let hello = this.state.lines.find(matchesRevision);
    if (hello === undefined) {
      await this.send({ c: "hello" });
      hello = await this.waitForLine(this.helloWaiters, matchesRevision, "matching hello banner", 5_000);
    }
    if (hello.design !== this.plan.design || hello.board !== this.plan.board) throw new Error("Board banner does not match this revision.");
    await this.send({ c: "run", test: "rails.vcc" });
    await this.waitForLine(
      this.vccWaiters,
      (line): line is Extract<DeviceLine, { t: "vcc" }> => line.t === "vcc",
      "VCC reading",
      5_000,
    );
  }

  /** Start all planned read-before-drive tests. */
  async startSelfTest(): Promise<void> {
    await this.send({ c: "run", test: "all" });
  }

  /** Answer one visible ask button and resume the firmware. */
  async answer(id: string, value: string): Promise<void> {
    const ask = this.state.asks.find((candidate) => candidate.id === id);
    if (!ask) throw new Error(`The device did not ask for ${id}.`);
    const timer = this.askTimers.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.askTimers.delete(id);
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
    return { revision: this.revision, kind, plan: this.plan, lines: this.state.lines, answers: { ...this.state.answers } };
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
