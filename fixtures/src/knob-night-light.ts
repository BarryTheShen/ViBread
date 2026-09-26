import { CIRCUIT_SCHEMA, parseSuiteYaml, type Circuit, type InventoryItem } from "@vibread/core";

const sketch = `// Knob Night-Light — the knob sets how bright the light glows.

const uint8_t KNOB_PIN = A0;   // potentiometer wiper; outer legs on GND and 5V
const uint8_t LIGHT_PIN = 9;   // PWM pin
const int DEAD_ZONE = 8;       // readings below this count as "off"

void setup() {
  pinMode(LIGHT_PIN, OUTPUT);
  Serial.begin(115200);
  Serial.println(F("knob-night-light ready"));
}

void loop() {
  int knob = analogRead(KNOB_PIN);
  int level = knob < DEAD_ZONE ? 0 : map(knob, DEAD_ZONE, 1023, 1, 255);
  analogWrite(LIGHT_PIN, level);
}
`;

export const knobNightLight: Circuit = {
  schema: CIRCUIT_SCHEMA,
  title: "Knob Night-Light",
  summary: "Turning a knob sets how brightly one light glows, from off to full brightness.",
  board: { profile: "uno-r3-atmega328p-5v" },
  breadboard: { profile: "bb-830" },
  parts: [
    { id: "POT1", module: "potentiometer", label: "Brightness knob", params: { ohms: 10_000 } },
    { id: "LED1", module: "led", label: "Night-light", params: { color: "white" } },
    { id: "R1", module: "resistor", label: "Resistor for the night-light", params: { ohms: 220, tolerancePct: 5 } },
  ],
  nets: [
    { id: "5V", kind: "power", pins: [{ part: "board", pin: "5V" }, { part: "POT1", pin: "B" }] },
    { id: "GND", kind: "ground", pins: [{ part: "board", pin: "GND" }, { part: "POT1", pin: "A" }, { part: "LED1", pin: "K" }] },
    { id: "A0", kind: "signal", pins: [{ part: "board", pin: "A0" }, { part: "POT1", pin: "W" }] },
    { id: "D9", kind: "signal", pins: [{ part: "board", pin: "D9" }, { part: "R1", pin: "1" }] },
    { id: "L1", kind: "signal", pins: [{ part: "R1", pin: "2" }, { part: "LED1", pin: "A" }] },
  ],
  roles: [
    { pin: "A0", mode: "ANALOG_IN", part: "POT1", purpose: "Read the brightness knob" },
    { pin: "D9", mode: "PWM_OUT", part: "LED1", purpose: "Dim or brighten the night-light" },
  ],
  sketch: { source: sketch },
  intent: [
    { id: "C1", text: "Turning the knob sets how bright the night-light glows: all the way to one side it is off, all the way to the other it is fully bright." },
    { id: "C2", text: "With the knob halfway, the light glows at about half brightness." },
  ],
  assumptions: ["Knob leg A is wired to GND, so turning toward leg B brightens the light."],
};

export const knobNightLightInventory: InventoryItem[] = [
  { module: "potentiometer", count: 1, params: { ohms: 10_000 } },
  { module: "led", count: 2, params: { color: "white" } },
  { module: "resistor", count: 5, params: { ohms: 220 } },
];

export const knobNightLightBrief = "A night-light with a knob: turning the knob makes the light brighter or dimmer, down to off.";

export const knobNightLightSuiteYaml = `schema: vibread.sim/v1
author: fixture
scenarios:
  - id: T1
    title: At power-on with the knob all the way down, the light is off
    clauses: [C1]
    categories: [power-on]
    setup: { analog: { POT1: 0 } }
    steps:
      - wait: 200
      - expect-part: { part: LED1, state: off }
      - expect-pwm: { pin: D9, min: 0, max: 0.02 }
  - id: T2
    title: With the knob all the way up, the light is fully bright
    clauses: [C1]
    categories: [edge]
    setup: { analog: { POT1: 1 } }
    steps:
      - wait: 200
      - expect-pwm: { pin: D9, min: 0.97, max: 1 }
      - expect-part: { part: LED1, state: on }
  - id: T3
    title: With the knob halfway, the light glows at about half brightness
    clauses: [C2]
    categories: [normal]
    setup: { analog: { POT1: 0.5 } }
    steps:
      - wait: 200
      - expect-pwm: { pin: D9, min: 0.4, max: 0.6 }
  - id: T4
    title: Turning the knob up and back down again ends with the light off
    clauses: [C1]
    categories: [edge]
    setup: { analog: { POT1: 0 } }
    steps:
      - wait: 100
      - set-analog: { part: POT1, value: 1 }
      - wait: 100
      - expect-pwm: { pin: D9, min: 0.97, max: 1 }
      - set-analog: { part: POT1, value: 0 }
      - wait: 100
      - expect-pwm: { pin: D9, min: 0, max: 0.02 }
`;

export const knobNightLightSuite = parseSuiteYaml(knobNightLightSuiteYaml);
