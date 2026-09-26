import type { Circuit, PinModeObservation, Scenario, ScenarioResult, Trace } from "@vibread/core";
import { SimMachine, runScenarioCore } from "./engine.js";

export class SimSession {
  private readonly machine: SimMachine;

  constructor(opts: { circuit: Circuit; hex: string; light?: Record<string, number>; analog?: Record<string, number> }) {
    this.machine = new SimMachine(opts.hex, opts.circuit, { light: opts.light, analog: opts.analog });
  }

  run(ms: number): void {
    this.machine.run(ms);
  }

  get timeMs(): number {
    return this.machine.timeMs;
  }

  setDigital(part: string, value: boolean): void {
    this.machine.setDigital(part, value);
  }

  setLight(part: string, level: number): void {
    this.machine.setLight(part, level);
  }

  setAnalog(part: string, value: number): void {
    this.machine.setAnalog(part, value);
  }

  partState(part: string): number {
    return this.machine.partState(part);
  }

  pinLevel(pin: string): 0 | 1 | null {
    return this.machine.pinLevel(pin);
  }

  serialWrite(text: string): void {
    this.machine.serialWrite(text);
  }

  onSerial(callback: (text: string) => void): () => void {
    return this.machine.onSerial(callback);
  }
}

export async function runScenario(input: { circuit: Circuit; hex: string; scenario: Scenario }): Promise<{ result: ScenarioResult; trace: Trace; pinModes: PinModeObservation[] }> {
  return runScenarioCore(input);
}
