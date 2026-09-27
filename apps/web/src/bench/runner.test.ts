import { describe, expect, it, vi } from "vitest";
import type { Circuit, SelfTestPlan } from "@vibread/core";
import { encodeHostCommand } from "@vibread/core";
import { BenchRunner, type BenchTransport } from "./runner.js";

const circuit = {} as Circuit;
const plan = { design: "hash", board: "uno-r3-atmega328p-5v", tests: [] } as unknown as SelfTestPlan;

class FakeTransport implements BenchTransport {
  readonly writes: string[] = [];
  private readonly listeners = new Set<(data: Uint8Array) => void>();

  async write(data: Uint8Array): Promise<void> {
    this.writes.push(new TextDecoder().decode(data));
  }

  on(_event: "data", handler: (data: Uint8Array) => void): void {
    this.listeners.add(handler);
  }

  off(_event: "data", handler: (data: Uint8Array) => void): void {
    this.listeners.delete(handler);
  }

  async close(): Promise<void> {
    this.listeners.clear();
  }

  receive(line: string): void {
    this.emit(new TextEncoder().encode(`${line}\n`));
  }

  emit(data: Uint8Array): void {
    for (const listener of this.listeners) listener(data);
  }
}

class RailTransport extends FakeTransport {
  override async write(data: Uint8Array): Promise<void> {
    await super.write(data);
    const command = JSON.parse(new TextDecoder().decode(data)) as { c: string; test?: string };
    if (command.c === "hello") this.receive(JSON.stringify({ t: "hello", fw: "vibread-bench", proto: 1, design: "hash", board: "uno-r3-atmega328p-5v" }));
    if (command.c === "run" && command.test === "rails.vcc") this.receive(JSON.stringify({ t: "vcc", mv: 5000 }));
  }
}

class SubsetTransport extends FakeTransport {
  override async write(data: Uint8Array): Promise<void> {
    await super.write(data);
    const command = JSON.parse(new TextDecoder().decode(data)) as { c: string; test?: string };
    if (command.c === "run" && command.test !== undefined && command.test !== "all") {
      this.receive(JSON.stringify({ t: "end", test: command.test, status: "pass" }));
    }
  }
}

/**
 * The virtual board as VirtualBenchTransport delivers it: the simulated UART emits one character per message from the
 * worker, after the command write has returned, with CRLF line ends; setup() prints the banner unprompted.
 */
class VirtualChunkTransport extends FakeTransport {
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();

  boot(): void {
    this.uart({ t: "hello", fw: "vibread-bench", proto: 1, design: "hash", board: "uno-r3-atmega328p-5v" });
  }

  override async write(data: Uint8Array): Promise<void> {
    await super.write(data);
    const command = JSON.parse(new TextDecoder().decode(data)) as { c: string; test?: string };
    if (command.c === "hello") this.boot();
    if (command.c === "run" && command.test === "rails.vcc") {
      this.uart({ t: "begin", test: "rails.vcc" });
      this.uart({ t: "vcc", mv: 5001 });
      this.uart({ t: "end", test: "rails.vcc", status: "pass" });
    }
  }

  private uart(line: object): void {
    for (const char of `${JSON.stringify(line)}\r\n`) {
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        this.emit(new TextEncoder().encode(char));
      }, 0);
      this.timers.add(timer);
    }
  }
}

describe("BenchRunner", () => {
  it("starts tests, exposes asks, sends answers, and builds the run submission", async () => {
    const transport = new FakeTransport();
    const runner = new BenchRunner({ circuit, plan, revision: 3, runId: "run-3", transport });

    await runner.startSelfTest();
    expect(transport.writes).toContain(encodeHostCommand({ c: "run", test: "all" }));
    expect(runner.state.phase).toBe("selftest");

    transport.receive(JSON.stringify({ t: "begin", test: "button.interactive" }));
    transport.receive(JSON.stringify({
      t: "ask",
      id: "btn0-press",
      test: "button.interactive",
      kind: "press-hold",
      choices: ["done"],
      timeoutMs: 1000,
    }));
    expect(runner.state.asks[0]?.id).toBe("btn0-press");

    await runner.answer("btn0-press", "done");
    expect(transport.writes).toContain(encodeHostCommand({ c: "answer", id: "btn0-press", v: "done" }));
    expect(runner.state.answers).toEqual({ "btn0-press": "done" });

    transport.receive(JSON.stringify({ t: "end", test: "button.interactive", status: "pass" }));
    transport.receive(JSON.stringify({ t: "done" }));
    expect(runner.state.phase).toBe("complete");
    expect(runner.runRequest()).toMatchObject({ revision: 3, kind: "selftest", answers: { "btn0-press": "done" } });
  });

  it("answers an expired ask with timeout and keeps only the current prompt", async () => {
    vi.useFakeTimers();
    try {
      const transport = new FakeTransport();
      const runner = new BenchRunner({ circuit, plan, revision: 1, transport });
      await runner.startSelfTest();
      transport.receive(JSON.stringify({ t: "ask", id: "btn0-press", test: "button.interactive", kind: "press-hold", choices: ["done"], timeoutMs: 20 }));
      vi.advanceTimersByTime(20);
      await Promise.resolve();
      expect(transport.writes).toContain(encodeHostCommand({ c: "answer", id: "btn0-press", v: "timeout" }));
      transport.receive(JSON.stringify({ t: "ask", id: "btn0-release", test: "button.interactive", kind: "release", choices: ["done"], timeoutMs: 1000 }));
      expect(runner.state.asks).toHaveLength(1);
      expect(runner.state.asks[0]?.id).toBe("btn0-release");
      runner.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits for the matching hello before sending the rail command", async () => {
    const transport = new RailTransport();
    const runner = new BenchRunner({ circuit, plan, revision: 1, transport });
    await runner.startRail();
    expect(transport.writes).toEqual([
      encodeHostCommand({ c: "hello" }),
      encodeHostCommand({ c: "run", test: "rails.vcc" }),
    ]);
    expect(runner.state.seenVcc?.mv).toBe(5000);
  });

  it("reads VCC from the virtual board's one-character-at-a-time serial (Connect → Skip flash → Check board power)", async () => {
    vi.useFakeTimers();
    try {
      const transport = new VirtualChunkTransport();
      const runner = new BenchRunner({ circuit, plan, revision: 1, transport });
      transport.boot();
      await vi.advanceTimersByTimeAsync(10);
      expect(runner.state.seenHello?.design).toBe("hash");
      const rail = runner.startRail();
      // Past the 5 s VCC wait: the reading must have been matched, not timed out.
      await vi.advanceTimersByTimeAsync(6_000);
      await rail;
      expect(runner.state.seenVcc?.mv).toBe(5001);
      expect(transport.writes).toEqual([encodeHostCommand({ c: "run", test: "rails.vcc" })]);
    } finally {
      vi.useRealTimers();
    }
  });
  it("runs only the requested checkpoint tests and submits the subset plan", async () => {
    const transport = new SubsetTransport();
    const runner = new BenchRunner({ circuit, plan, revision: 2, transport });
    await runner.startSelfTest(["button.interactive", "led.sequence"]);
    expect(transport.writes).toContain(encodeHostCommand({ c: "run", test: "button.interactive" }));
    expect(transport.writes).toContain(encodeHostCommand({ c: "run", test: "led.sequence" }));
    expect(runner.state.phase).toBe("complete");
    expect(runner.runRequest().plan.tests).toEqual(["button.interactive", "led.sequence"]);
  });
});
