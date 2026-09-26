import type { Actor, MissionStore } from "@vibread/core";

export interface BenchAsk {
  missionId: string;
  askId: string;
  test: string;
  kind: string;
  part?: string;
  prompt: string;
  choices: string[];
  createdAt: number;
  expiresAt: number;
  status: "open" | "answered" | "closed";
  answer?: string;
  answeredBy?: Actor;
}

export interface BenchAskStore {
  open(input: Omit<BenchAsk, "createdAt" | "expiresAt" | "status"> & { timeoutMs: number }): BenchAsk;
  answer(missionId: string, askId: string, value: string, actor: Actor): boolean;
  close(missionId: string, askId: string, answer?: string): void;
  get(missionId: string, askId: string): BenchAsk | undefined;
  current(missionId: string): BenchAsk | undefined;
}

export interface BenchAskStoreDependencies {
  store?: MissionStore;
}

export class InMemoryBenchAskStore implements BenchAskStore {
  private readonly asks = new Map<string, BenchAsk>();

  constructor(private readonly deps: BenchAskStoreDependencies = {}) {}

  open(input: Omit<BenchAsk, "createdAt" | "expiresAt" | "status"> & { timeoutMs: number }): BenchAsk {
    const previous = this.asks.get(input.missionId);
    if (previous && previous.status === "open") {
      previous.status = "closed";
      this.emit("bench.ask.closed", previous, "Bench prompt replaced");
    }
    const createdAt = Date.now();
    const ask: BenchAsk = {
      missionId: input.missionId,
      askId: input.askId,
      test: input.test,
      kind: input.kind,
      ...(input.part ? { part: input.part } : {}),
      prompt: input.prompt,
      choices: [...input.choices],
      createdAt,
      expiresAt: createdAt + Math.max(1, input.timeoutMs),
      status: "open",
    };
    this.asks.set(input.missionId, ask);
    this.emit("bench.ask.opened", ask, ask.prompt);
    return structuredClone(ask);
  }

  answer(missionId: string, askId: string, value: string, actor: Actor): boolean {
    const ask = this.asks.get(missionId);
    if (!ask || ask.askId !== askId || !this.openNow(ask) || !ask.choices.includes(value)) return false;
    ask.status = "answered";
    ask.answer = value;
    ask.answeredBy = actor;
    this.emit("bench.ask.answered", ask, `Bench answer: ${value}`);
    return true;
  }

  close(missionId: string, askId: string, answer?: string): void {
    const ask = this.asks.get(missionId);
    if (!ask || ask.askId !== askId || !this.openNow(ask)) return;
    ask.status = answer === undefined ? "closed" : "answered";
    if (answer !== undefined) ask.answer = answer;
    this.emit("bench.ask.closed", ask, answer === undefined ? "Bench prompt closed" : `Bench answer: ${answer}`);
  }

  get(missionId: string, askId: string): BenchAsk | undefined {
    const ask = this.asks.get(missionId);
    if (!ask || ask.askId !== askId) return undefined;
    this.expireIfNeeded(ask);
    return structuredClone(ask);
  }

  current(missionId: string): BenchAsk | undefined {
    const ask = this.asks.get(missionId);
    if (!ask) return undefined;
    this.expireIfNeeded(ask);
    return structuredClone(ask);
  }

  private openNow(ask: BenchAsk): boolean {
    if (ask.status !== "open") return false;
    if (ask.expiresAt <= Date.now()) {
      ask.status = "closed";
      this.emit("bench.ask.closed", ask, "Bench prompt timed out");
      return false;
    }
    return true;
  }

  private expireIfNeeded(ask: BenchAsk): void {
    if (ask.status === "open") this.openNow(ask);
  }

  private emit(kind: string, ask: BenchAsk, text: string): void {
    if (!this.deps.store) return;
    const event = {
      missionId: ask.missionId,
      channel: "system" as const,
      actor: { kind: "system" as const, id: "bench", channel: "system" as const },
      kind,
      text,
      data: { missionId: ask.missionId, ask: structuredClone(ask) },
    };
    void this.deps.store.appendEvent(event).catch(() => undefined);
  }
}

export function createBenchAskStore(deps: BenchAskStoreDependencies = {}): BenchAskStore {
  return new InMemoryBenchAskStore(deps);
}
