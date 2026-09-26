import { Engine, type RuleProperties } from "json-rules-engine";

export type DiagnosisSignature =
  | "buttonStuckLow"
  | "ledMismatch"
  | "lightPinnedRail"
  | "outputStuck"
  | "noBanner";

export interface RuleCause {
  cause: string;
  title: string;
  likelihood: number;
  fix: string;
}

export interface RuleData {
  name: string;
  signature: DiagnosisSignature;
  priority: number;
  attribution: "wiring" | "component";
  causes: RuleCause[];
}

const RULE_DATA: RuleData[] = [
  {
    name: "button-pin-stuck-low",
    signature: "buttonStuckLow",
    priority: 100,
    attribution: "wiring",
    causes: [
      {
        cause: "button-leg-in-gnd-row",
        title: "Button leg is in a GND row",
        likelihood: 0.72,
        fix: "Move the button's signal leg out of the GND row and back to the highlighted signal row.",
      },
      {
        cause: "button-rotated-90",
        title: "Button is rotated 90 degrees",
        likelihood: 0.18,
        fix: "Rotate the four-leg button so it straddles the breadboard center gap.",
      },
      {
        cause: "jumper-to-gnd",
        title: "Button signal jumper is on GND",
        likelihood: 0.1,
        fix: "Move the highlighted button jumper from GND to the Arduino signal pin.",
      },
    ],
  },
  {
    name: "led-sequence-mismatch",
    signature: "ledMismatch",
    priority: 96,
    attribution: "wiring",
    causes: [
      {
        cause: "led-jumpers-swapped",
        title: "Two LED jumpers are swapped",
        likelihood: 0.72,
        fix: "Swap the highlighted LED jumpers so each Arduino pin reaches the matching light.",
      },
      {
        cause: "led-reversed",
        title: "An LED is reversed",
        likelihood: 0.18,
        fix: "Turn the highlighted LED around: its long leg goes toward the resistor and Arduino pin.",
      },
      {
        cause: "led-missing",
        title: "An LED is missing or not seated",
        likelihood: 0.1,
        fix: "Insert the highlighted LED firmly across the row shown in the build step.",
      },
    ],
  },
  {
    name: "light-pinned-rail",
    signature: "lightPinnedRail",
    priority: 94,
    attribution: "wiring",
    causes: [
      {
        cause: "divider-resistor-missing",
        title: "Light-divider resistor is missing",
        likelihood: 0.72,
        fix: "Add the highlighted 10 kΩ partner resistor between the sensor row and GND.",
      },
      {
        cause: "sensor-missing",
        title: "Light sensor is missing or not seated",
        likelihood: 0.18,
        fix: "Insert the highlighted photoresistor in the two holes shown by the build step.",
      },
      {
        cause: "sensor-wrong-row",
        title: "Light sensor is in the wrong row",
        likelihood: 0.1,
        fix: "Move the sensor and its partner resistor back to the highlighted divider row.",
      },
    ],
  },
  {
    name: "output-pin-stuck-at-rail",
    signature: "outputStuck",
    priority: 98,
    attribution: "wiring",
    causes: [
      {
        cause: "output-jumper-in-rail-row",
        title: "Output jumper is in a power-rail row",
        likelihood: 0.95,
        fix: "Unplug the highlighted output jumper from the rail row and use the signal row.",
      },
      {
        cause: "missing-resistor",
        title: "Current-limiting resistor is missing",
        likelihood: 0.05,
        fix: "Add the highlighted resistor in series before trying the output again.",
      },
    ],
  },
  {
    name: "no-banner-or-usb-drop",
    signature: "noBanner",
    priority: 80,
    attribution: "wiring",
    causes: [
      {
        cause: "rail-short",
        title: "5 V and GND may be shorted",
        likelihood: 0.7,
        fix: "Unplug USB, then inspect the highlighted 5 V and GND rail jumpers before reconnecting.",
      },
      {
        cause: "cable",
        title: "USB cable or connection may be the problem",
        likelihood: 0.3,
        fix: "Unplug the board and try a known-good data USB cable and port.",
      },
    ],
  },
];

function ruleFor(data: RuleData): RuleProperties {
  return {
    name: data.name,
    priority: data.priority,
    conditions: {
      all: [{ fact: "signatures", path: `$.${data.signature}`, operator: "equal", value: true }],
    },
    event: {
      type: "diagnosis",
      params: { signature: data.signature, attribution: data.attribution, causes: data.causes },
    },
  };
}

const ENGINE_RULES: RuleProperties[] = RULE_DATA.map(ruleFor);

export interface RuleEvent {
  signature: DiagnosisSignature;
  attribution: "wiring" | "component";
  causes: RuleCause[];
  priority: number;
}

export async function runDiagnosisRules(signatures: Record<DiagnosisSignature, boolean>): Promise<RuleEvent[]> {
  const engine = new Engine(ENGINE_RULES);
  const result = await engine.run({ signatures });
  const events: RuleEvent[] = [];
  for (const event of result.events) {
    const signature = event.params?.signature;
    const attribution = event.params?.attribution;
    const causes = event.params?.causes;
    if (!isDiagnosisSignature(signature) || !isAttribution(attribution) || !isCauseList(causes)) continue;
    const data = RULE_DATA.find((candidate) => candidate.signature === signature);
    if (data === undefined) continue;
    events.push({ signature, attribution, causes, priority: data.priority });
  }
  return events;
}

function isDiagnosisSignature(value: unknown): value is DiagnosisSignature {
  return value === "buttonStuckLow" || value === "ledMismatch" || value === "lightPinnedRail" || value === "outputStuck" || value === "noBanner";
}

function isAttribution(value: unknown): value is "wiring" | "component" {
  return value === "wiring" || value === "component";
}

function isCauseList(value: unknown): value is RuleCause[] {
  if (!Array.isArray(value)) return false;
  return value.every(
    (item): item is RuleCause =>
      typeof item === "object" &&
      item !== null &&
      "cause" in item &&
      "title" in item &&
      "likelihood" in item &&
      "fix" in item &&
      typeof item.cause === "string" &&
      typeof item.title === "string" &&
      typeof item.likelihood === "number" &&
      typeof item.fix === "string",
  );
}
