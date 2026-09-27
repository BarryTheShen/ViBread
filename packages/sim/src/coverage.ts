import type { Circuit, Coverage, Scenario, TestSuite } from "@vibread/core";

const OUTPUT_MODULES = new Set(["led", "buzzer-active", "buzzer-passive"]);
const INPUT_MODULES = new Set(["button", "photoresistor", "potentiometer"]);

function isOutputPart(part: Circuit["parts"][number]): boolean {
  if (OUTPUT_MODULES.has(part.module)) return true;
  return part.module === "generic" && part.params.role === "digital-actuator";
}

function isInputPart(part: Circuit["parts"][number]): boolean {
  if (INPUT_MODULES.has(part.module)) return true;
  return part.module === "generic" && part.params.role !== "digital-actuator";
}
function scenarioUsesPart(scenario: Scenario, part: string): boolean {
  for (const step of scenario.steps) {
    if ("set-digital" in step && step["set-digital"].part === part) return true;
    if ("press" in step && step.press.part === part) return true;
    if ("bounce" in step && step.bounce.part === part) return true;
    if ("set-light" in step && step["set-light"].part === part) return true;
    if ("set-analog" in step && step["set-analog"].part === part) return true;
  }
  return false;
}

function outputAsserted(circuit: Circuit, scenario: Scenario, part: string): boolean {
  for (const step of scenario.steps) {
    if ("expect-part" in step && step["expect-part"].part === part) return true;
    if ("expect-parts" in step && step["expect-parts"].checks.some((check) => check.part === part)) return true;
    if ("kind" in step && step.kind === "expect-parts" && step.checks.some((check) => check.part === part)) return true;
    if ("expect-tone" in step && step["expect-tone"].part === part) return true;
    if ("expect-pwm" in step) {
      const role = circuit.roles.find((entry) => entry.pin === step["expect-pwm"].pin);
      if (role?.part === part) return true;
    }
  }
  return false;
}

export function coverageOf(circuit: Circuit, suite: TestSuite): Coverage {
  const scenarios = suite.scenarios;
  const outputsAsserted: Record<string, boolean> = {};
  const inputsExercised: Record<string, boolean> = {};
  const clausesCovered: Record<string, string[]> = {};
  const categories = new Set<string>();
  for (const clause of circuit.intent) clausesCovered[clause.id] = [];
  for (const scenario of scenarios) {
    for (const category of scenario.categories) categories.add(category);
    for (const clause of scenario.clauses) {
      const scenariosForClause = clausesCovered[clause] ?? [];
      scenariosForClause.push(scenario.id);
      clausesCovered[clause] = scenariosForClause;
    }
  }
  for (const part of circuit.parts) {
    if (isOutputPart(part)) outputsAsserted[part.id] = scenarios.some((scenario) => outputAsserted(circuit, scenario, part.id));
    if (isInputPart(part)) inputsExercised[part.id] = scenarios.some((scenario) => scenarioUsesPart(scenario, part.id));
  }
  // Only a power-on test is required. Edge cases (bounce, rapid presses, light hysteresis, knob ends) are welcome but
  // optional, so the suite doesn't demand harsh tests the brief never asked for.
  const required = new Set<string>(["power-on"]);
  const missing: string[] = [];
  for (const [part, asserted] of Object.entries(outputsAsserted)) if (!asserted) missing.push(`${part} is never checked`);
  for (const [part, exercised] of Object.entries(inputsExercised)) if (!exercised) missing.push(`${part} is never exercised`);
  for (const clause of circuit.intent) if (!(clausesCovered[clause.id]?.length ?? 0)) missing.push(`${clause.id} is never covered`);
  for (const category of required) if (!categories.has(category)) missing.push(`no ${category} test`);
  return {
    ok: missing.length === 0,
    outputsAsserted,
    inputsExercised,
    clausesCovered,
    categoriesPresent: [...categories].sort(),
    categoriesRequired: [...required].sort(),
    missing,
  };
}
