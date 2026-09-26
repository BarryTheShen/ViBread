import { describe, expect, it } from "vitest";
import type { Circuit, SelfTestPlan } from "@vibread/core";
import { encodeHostCommand } from "@vibread/core";
import { BenchRunner, type BenchTransport } from "./runner.js";

const circuit = {} as Circuit;
const plan = { tests: [] } as unknown as SelfTestPlan;

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
      id: "ask-1",
      test: "button.interactive",
      kind: "press-hold",
      choices: ["pressed", "not-pressed"],
      timeoutMs: 1000,
    }));
    expect(runner.state.asks[0]?.id).toBe("ask-1");

    await runner.answer("ask-1", "pressed");
    expect(transport.writes).toContain(encodeHostCommand({ c: "answer", id: "ask-1", v: "pressed" }));
    expect(runner.state.answers).toEqual({ "ask-1": "pressed" });

    transport.receive(JSON.stringify({ t: "end", test: "button.interactive", status: "pass" }));
    transport.receive(JSON.stringify({ t: "done" }));
    expect(runner.state.phase).toBe("complete");
    expect(runner.runRequest()).toMatchObject({ revision: 3, kind: "selftest", answers: { "ask-1": "pressed" } });
  });
});
