import { CIRCUIT_SCHEMA, parseSuiteYaml, type Circuit, type InventoryItem, type PinRef } from "@vibread/core";

const sketch = `// Moon-Phase Lamp — four lights in a row show the moon; a button steps through the phases;
// a light sensor keeps the lamp dark until the room is dark.

// Dark threshold (raw 0-1023 reading) and hysteresis; replaced by bench calibration before the final flash.
#ifndef VB_CAL_LDR1_DARK
#define VB_CAL_LDR1_DARK 300
#endif
#ifndef VB_CAL_LDR1_HYST
#define VB_CAL_LDR1_HYST 40
#endif

const uint8_t LED_PINS[4] = {3, 4, 5, 6};  // LED1 (leftmost) .. LED4 (rightmost)
const uint8_t BUTTON_PIN = 2;               // to GND, uses the internal pull-up
const uint8_t LIGHT_PIN = A0;               // photoresistor to 5V, 10k to GND: brighter room = higher reading
const unsigned long DEBOUNCE_MS = 30;

// Lit lights for each of the 8 phases; bit 0 = LED1 (left) .. bit 3 = LED4 (right).
// Waxing fills in from the right; waning goes dark from the right first (northern-hemisphere sky).
const uint8_t PHASES[8] = {
  0b0000,  // new moon
  0b1000,  // waxing crescent
  0b1100,  // first quarter
  0b1110,  // waxing gibbous
  0b1111,  // full moon
  0b0111,  // waning gibbous
  0b0011,  // last quarter
  0b0001,  // waning crescent
};

uint8_t phase = 0;
bool dark = false;
bool lastReading = HIGH;
bool stableState = HIGH;
unsigned long lastChange = 0;

void setup() {
  for (uint8_t i = 0; i < 4; i++) {
    pinMode(LED_PINS[i], OUTPUT);
    digitalWrite(LED_PINS[i], LOW);
  }
  pinMode(BUTTON_PIN, INPUT_PULLUP);
  Serial.begin(115200);
  Serial.println(F("moon-phase-lamp ready"));
}

void loop() {
  // Debounced button: one phase step per press.
  bool reading = digitalRead(BUTTON_PIN);
  if (reading != lastReading) {
    lastReading = reading;
    lastChange = millis();
  }
  if (millis() - lastChange >= DEBOUNCE_MS && reading != stableState) {
    stableState = reading;
    if (stableState == LOW) {
      phase = (phase + 1) % 8;
      Serial.print(F("phase "));
      Serial.println(phase);
    }
  }

  // Light sensor with hysteresis: dark below the threshold, light again above threshold + hysteresis.
  int light = analogRead(LIGHT_PIN);
  if (!dark && light < VB_CAL_LDR1_DARK) {
    dark = true;
  } else if (dark && light > VB_CAL_LDR1_DARK + VB_CAL_LDR1_HYST) {
    dark = false;
  }

  uint8_t pattern = dark ? PHASES[phase] : 0;
  for (uint8_t i = 0; i < 4; i++) {
    digitalWrite(LED_PINS[i], (pattern >> i) & 1 ? HIGH : LOW);
  }
}
`;

const b = (pin: string): PinRef => ({ part: "board", pin });
const p = (part: string, pin: string): PinRef => ({ part, pin });

export const moonPhaseLamp: Circuit = {
  schema: CIRCUIT_SCHEMA,
  title: "Moon-Phase Lamp",
  summary:
    "Four lights in a row show the moon's lit side the way the sky does. A button steps through the eight phases, and a light sensor keeps the lamp dark until the room is dark.",
  board: { profile: "uno-r3-atmega328p-5v" },
  breadboard: { profile: "bb-830" },
  parts: [
    { id: "LED1", module: "led", label: "Moon light 1 (leftmost)", params: { color: "yellow" } },
    { id: "LED2", module: "led", label: "Moon light 2", params: { color: "yellow" } },
    { id: "LED3", module: "led", label: "Moon light 3", params: { color: "yellow" } },
    { id: "LED4", module: "led", label: "Moon light 4 (rightmost)", params: { color: "yellow" } },
    { id: "R1", module: "resistor", label: "Resistor for moon light 1", params: { ohms: 220, tolerancePct: 5 } },
    { id: "R2", module: "resistor", label: "Resistor for moon light 2", params: { ohms: 220, tolerancePct: 5 } },
    { id: "R3", module: "resistor", label: "Resistor for moon light 3", params: { ohms: 220, tolerancePct: 5 } },
    { id: "R4", module: "resistor", label: "Resistor for moon light 4", params: { ohms: 220, tolerancePct: 5 } },
    { id: "BTN1", module: "button", label: "Next-phase button", params: {} },
    { id: "LDR1", module: "photoresistor", label: "Room light sensor", params: {} },
    { id: "R5", module: "resistor", label: "Light sensor partner resistor", params: { ohms: 10_000, tolerancePct: 5 } },
  ],
  nets: [
    { id: "5V", kind: "power", pins: [b("5V"), p("LDR1", "1")] },
    {
      id: "GND",
      kind: "ground",
      pins: [b("GND"), p("LED1", "K"), p("LED2", "K"), p("LED3", "K"), p("LED4", "K"), p("BTN1", "3"), p("R5", "2")],
    },
    { id: "D2", kind: "signal", pins: [b("D2"), p("BTN1", "1")] },
    { id: "D3", kind: "signal", pins: [b("D3"), p("R1", "1")] },
    { id: "D4", kind: "signal", pins: [b("D4"), p("R2", "1")] },
    { id: "D5", kind: "signal", pins: [b("D5"), p("R3", "1")] },
    { id: "D6", kind: "signal", pins: [b("D6"), p("R4", "1")] },
    { id: "L1", kind: "signal", pins: [p("R1", "2"), p("LED1", "A")] },
    { id: "L2", kind: "signal", pins: [p("R2", "2"), p("LED2", "A")] },
    { id: "L3", kind: "signal", pins: [p("R3", "2"), p("LED3", "A")] },
    { id: "L4", kind: "signal", pins: [p("R4", "2"), p("LED4", "A")] },
    { id: "A0", kind: "signal", pins: [b("A0"), p("LDR1", "2"), p("R5", "1")] },
  ],
  roles: [
    { pin: "D2", mode: "INPUT_PULLUP", part: "BTN1", purpose: "Step to the next moon phase" },
    { pin: "D3", mode: "OUTPUT", part: "LED1", purpose: "Moon light 1 (leftmost)" },
    { pin: "D4", mode: "OUTPUT", part: "LED2", purpose: "Moon light 2" },
    { pin: "D5", mode: "OUTPUT", part: "LED3", purpose: "Moon light 3" },
    { pin: "D6", mode: "OUTPUT", part: "LED4", purpose: "Moon light 4 (rightmost)" },
    { pin: "A0", mode: "ANALOG_IN", part: "LDR1", purpose: "Measure how dark the room is" },
  ],
  sketch: { source: sketch },
  // "Four lights in a row", moon light 1 on the left (issue #26: an order the idea implies is stated explicitly).
  placement: { groups: [["LED1", "LED2", "LED3", "LED4"]] },
  intent: [
    { id: "C1", text: "The lamp lights up only when the room is dark." },
    { id: "C2", text: "Each press of the button moves the moon to its next phase, cycling through 8 phases from new moon back to new moon." },
    {
      id: "C3",
      text: "The four lights in a row show the moon's lit side the way the sky does: while waxing, light fills in from the right; while waning, the right side goes dark first.",
    },
  ],
  assumptions: [
    "Northern-hemisphere sky: the waxing moon is lit on its right side.",
    "The dark threshold is calibrated on the bench from the room's real light before the final flash.",
  ],
};

export const moonPhaseInventory: InventoryItem[] = [
  { module: "led", count: 5, params: { color: "yellow" } },
  { module: "led", count: 5, params: { color: "red" } },
  { module: "resistor", count: 10, params: { ohms: 220 } },
  { module: "resistor", count: 5, params: { ohms: 10_000 } },
  { module: "button", count: 2 },
  { module: "photoresistor", count: 1 },
];

export const moonPhaseBrief =
  "A moon-phase lamp: four lights in a row that show the moon's phase. A button moves to the next day's phase. It should only light up when the room is dark.";

const allLeds = (state: "on" | "off") =>
  ["LED1", "LED2", "LED3", "LED4"].map((part) => `      - expect-part: { part: ${part}, state: ${state} }`).join("\n");

const lit = (pattern: [boolean, boolean, boolean, boolean]) =>
  pattern.map((on, i) => `      - expect-part: { part: LED${i + 1}, state: ${on ? "on" : "off"} }`).join("\n");

const presses = (n: number, extra = "") => Array.from({ length: n }, () => `      - press: { part: BTN1${extra} }`).join("\n");

export const moonPhaseSuiteYaml = `schema: vibread.sim/v1
author: fixture
scenarios:
  - id: T1
    title: In a bright room the lamp stays dark, even after pressing the button
    clauses: [C1]
    categories: [power-on, normal]
    setup: { light: { LDR1: 0.8 } }
    steps:
      - wait: 300
${allLeds("off")}
      - press: { part: BTN1 }
${allLeds("off")}
  - id: T2
    title: In the dark the lamp starts at new moon, and one press shows a waxing crescent (only the rightmost light)
    clauses: [C1, C2, C3]
    categories: [power-on, normal]
    setup: { light: { LDR1: 0.05 } }
    steps:
      - wait: 300
${allLeds("off")}
      - press: { part: BTN1 }
${lit([false, false, false, true])}
      - expect-serial: { contains: "phase 1" }
  - id: T3
    title: In the dark, two presses light the right half (first quarter)
    clauses: [C2, C3]
    categories: [normal]
    setup: { light: { LDR1: 0.05 } }
    steps:
      - wait: 300
${presses(2)}
${lit([false, false, true, true])}
  - id: T4
    title: Four presses give a full moon, and the fifth press darkens the rightmost light first (waning)
    clauses: [C2, C3]
    categories: [normal]
    setup: { light: { LDR1: 0.05 } }
    steps:
      - wait: 300
${presses(4)}
${allLeds("on")}
      - press: { part: BTN1 }
${lit([true, true, true, false])}
  - id: T5
    title: Eight presses bring the moon back to new moon, with all lights off
    clauses: [C2]
    categories: [edge]
    setup: { light: { LDR1: 0.05 } }
    steps:
      - wait: 300
${presses(7)}
${lit([true, false, false, false])}
      - press: { part: BTN1 }
${allLeds("off")}
  - id: T6
    title: A bouncy button press still moves the moon only one step
    clauses: [C2]
    categories: [bounce]
    setup: { light: { LDR1: 0.05 } }
    steps:
      - wait: 300
      - bounce: { part: BTN1, to: true }
      - wait: 150
      - bounce: { part: BTN1, to: false }
      - wait: 200
${lit([false, false, false, true])}
  - id: T7
    title: Three quick presses in a row count as three steps
    clauses: [C2]
    categories: [rapid]
    setup: { light: { LDR1: 0.05 } }
    steps:
      - wait: 300
${presses(3, ", holdMs: 60, gapMs: 60")}
      - wait: 100
${lit([false, true, true, true])}
  - id: T8
    title: When the room turns bright the lamp goes dark, and it comes back with the same phase when the room is dark again
    clauses: [C1]
    categories: [threshold]
    setup: { light: { LDR1: 0.05 } }
    steps:
      - wait: 300
${presses(4)}
${allLeds("on")}
      - set-light: { part: LDR1, level: 0.8 }
      - wait: 100
${allLeds("off")}
      - set-light: { part: LDR1, level: 0.05 }
      - wait: 100
${allLeds("on")}
  - id: T9
    title: Near the dark threshold the lamp holds its state instead of flickering
    clauses: [C1]
    categories: [hysteresis]
    setup: { light: { LDR1: 0.05 } }
    steps:
      - wait: 300
${presses(4)}
      - set-light: { part: LDR1, level: 0.614 }
      - wait: 200
${allLeds("on")}
      - set-light: { part: LDR1, level: 0.8 }
      - wait: 100
${allLeds("off")}
      - set-light: { part: LDR1, level: 0.614 }
      - wait: 200
${allLeds("off")}
`;

export const moonPhaseSuite = parseSuiteYaml(moonPhaseSuiteYaml);
