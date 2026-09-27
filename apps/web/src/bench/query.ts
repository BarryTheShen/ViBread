import { TEST_IDS, type TestId } from "@vibread/core";

export interface BenchQuery {
  tests: TestId[];
  returnTo?: string;
}

export function parseBenchQuery(search: string): BenchQuery {
  const params = new URLSearchParams(search);
  const tests = (params.get("tests") ?? "").split(",").filter((value): value is TestId => (TEST_IDS as readonly string[]).includes(value));
  const returnToValue = params.get("returnTo") ?? undefined;
  const returnTo = returnToValue?.startsWith("/m/") ? returnToValue : undefined;
  return { tests: [...new Set(tests)], returnTo };
}

export function testLabel(test: TestId): string {
  const labels: Record<TestId, string> = {
    "rails.vcc": "power",
    "pins.readonly": "safe pins",
    "digital.stuck": "stuck pins",
    "button.interactive": "buttons",
    "light.relative": "light sensor",
    "pot.sweep": "knob",
    "led.sequence": "lights",
    "buzzer.confirm": "buzzer",
    "net.continuity": "continuity",
  };
  return labels[test];
}
