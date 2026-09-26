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
    const data = new TextEncoder().encode(`${line}\n`);
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
});
