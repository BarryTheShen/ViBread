import { CIRCUIT_SCHEMA, parseSuiteYaml, type Circuit, type InventoryItem, type PinRef } from "@vibread/core";

const sketch = `// Launch Control — ARM, then LAUNCH: a 3-second countdown, then liftoff with light and buzzer.

const uint8_t ARM_PIN = 2;       // button to GND, internal pull-up
const uint8_t LAUNCH_PIN = 3;    // button to GND, internal pull-up
const uint8_t ARMED_LED = 4;     // red
const uint8_t COUNT_LED = 5;     // yellow, blinks once per second during the countdown
const uint8_t LIFTOFF_LED = 6;   // green
const uint8_t BUZZER_PIN = 8;    // active buzzer
const unsigned long DEBOUNCE_MS = 30;
const unsigned long COUNTDOWN_MS = 3000;
const unsigned long LIFTOFF_MS = 1000;

struct Button {
  uint8_t pin;
  bool last;
  bool stable;
  unsigned long changed;
};

Button armButton = {ARM_PIN, HIGH, HIGH, 0};
Button launchButton = {LAUNCH_PIN, HIGH, HIGH, 0};

// Declared before the first function: the Arduino builder inserts function prototypes there.
enum State { IDLE, ARMED, COUNTDOWN, LIFTOFF };
State state = IDLE;
unsigned long stateStart = 0;

// Returns true once per debounced press.
bool pressed(Button &b) {
  bool reading = digitalRead(b.pin);
  if (reading != b.last) {
    b.last = reading;
    b.changed = millis();
  }
  if (millis() - b.changed >= DEBOUNCE_MS && reading != b.stable) {
    b.stable = reading;
    return b.stable == LOW;
  }
  return false;
}

void enter(State next, const __FlashStringHelper *name) {
  state = next;
  stateStart = millis();
  Serial.println(name);
}

void setup() {
  pinMode(ARM_PIN, INPUT_PULLUP);
  pinMode(LAUNCH_PIN, INPUT_PULLUP);
  pinMode(ARMED_LED, OUTPUT);
  pinMode(COUNT_LED, OUTPUT);
  pinMode(LIFTOFF_LED, OUTPUT);
  pinMode(BUZZER_PIN, OUTPUT);
  Serial.begin(115200);
  Serial.println(F("launch-control ready"));
}

void loop() {
  bool arm = pressed(armButton);
  bool launch = pressed(launchButton);
  unsigned long elapsed = millis() - stateStart;

  switch (state) {
    case IDLE:
      if (arm) enter(ARMED, F("armed"));
      break;
    case ARMED:
      if (arm) enter(IDLE, F("disarmed"));
      else if (launch) enter(COUNTDOWN, F("countdown"));
      break;
    case COUNTDOWN:
      if (arm) enter(IDLE, F("aborted"));
      else if (elapsed >= COUNTDOWN_MS) enter(LIFTOFF, F("liftoff"));
      break;
    case LIFTOFF:
      if (elapsed >= LIFTOFF_MS) enter(IDLE, F("safed"));
      break;
  }

  elapsed = millis() - stateStart;
  digitalWrite(ARMED_LED, (state == ARMED || state == COUNTDOWN) ? HIGH : LOW);
  digitalWrite(COUNT_LED, (state == COUNTDOWN && (elapsed % 1000) < 500) ? HIGH : LOW);
  digitalWrite(LIFTOFF_LED, state == LIFTOFF ? HIGH : LOW);
  digitalWrite(BUZZER_PIN, state == LIFTOFF ? HIGH : LOW);
}
`;

const b = (pin: string): PinRef => ({ part: "board", pin });
const p = (part: string, pin: string): PinRef => ({ part, pin });

export const launchControl: Circuit = {
  schema: CIRCUIT_SCHEMA,
  title: "Launch Control",
  summary: "Press ARM to arm the rocket, then LAUNCH for a 3-second countdown and a liftoff light with a buzzer.",
  board: { profile: "uno-r3-atmega328p-5v" },
  breadboard: { profile: "bb-830" },
  parts: [
    { id: "BTN1", module: "button", label: "ARM button", params: {} },
    { id: "BTN2", module: "button", label: "LAUNCH button", params: {} },
    { id: "LED1", module: "led", label: "Armed light (red)", params: { color: "red" } },
    { id: "LED2", module: "led", label: "Countdown light (yellow)", params: { color: "yellow" } },
    { id: "LED3", module: "led", label: "Liftoff light (green)", params: { color: "green" } },
    { id: "R1", module: "resistor", label: "Resistor for the armed light", params: { ohms: 220, tolerancePct: 5 } },
    { id: "R2", module: "resistor", label: "Resistor for the countdown light", params: { ohms: 220, tolerancePct: 5 } },
    { id: "R3", module: "resistor", label: "Resistor for the liftoff light", params: { ohms: 220, tolerancePct: 5 } },
    { id: "BZ1", module: "buzzer-active", label: "Liftoff buzzer", params: {} },
  ],
  nets: [
    { id: "GND", kind: "ground", pins: [b("GND"), p("BTN1", "3"), p("BTN2", "3"), p("LED1", "K"), p("LED2", "K"), p("LED3", "K"), p("BZ1", "N")] },
    { id: "D2", kind: "signal", pins: [b("D2"), p("BTN1", "1")] },
    { id: "D3", kind: "signal", pins: [b("D3"), p("BTN2", "1")] },
    { id: "D4", kind: "signal", pins: [b("D4"), p("R1", "1")] },
    { id: "D5", kind: "signal", pins: [b("D5"), p("R2", "1")] },
    { id: "D6", kind: "signal", pins: [b("D6"), p("R3", "1")] },
    { id: "L1", kind: "signal", pins: [p("R1", "2"), p("LED1", "A")] },
    { id: "L2", kind: "signal", pins: [p("R2", "2"), p("LED2", "A")] },
    { id: "L3", kind: "signal", pins: [p("R3", "2"), p("LED3", "A")] },
    { id: "D8", kind: "signal", pins: [b("D8"), p("BZ1", "P")] },
  ],
  roles: [
    { pin: "D2", mode: "INPUT_PULLUP", part: "BTN1", purpose: "ARM / disarm" },
    { pin: "D3", mode: "INPUT_PULLUP", part: "BTN2", purpose: "LAUNCH" },
    { pin: "D4", mode: "OUTPUT", part: "LED1", purpose: "Armed light" },
    { pin: "D5", mode: "OUTPUT", part: "LED2", purpose: "Countdown light" },
    { pin: "D6", mode: "OUTPUT", part: "LED3", purpose: "Liftoff light" },
    { pin: "D8", mode: "OUTPUT", part: "BZ1", purpose: "Liftoff buzzer" },
  ],
  sketch: { source: sketch },
  intent: [
    { id: "C1", text: "Pressing ARM turns the red armed light on; pressing ARM again disarms and turns it off." },
    { id: "C2", text: "Pressing LAUNCH while armed starts a 3-second countdown that blinks the yellow light once per second, then the green light and the buzzer mark liftoff for one second." },
    { id: "C3", text: "LAUNCH does nothing unless the rocket is armed." },
  ],
  assumptions: ["The active buzzer draws about 30 mA, which is above the 20 mA design limit per pin but below the 40 mA maximum."],
};

export const launchControlInventory: InventoryItem[] = [
  { module: "button", count: 2 },
  { module: "led", count: 2, params: { color: "red" } },
  { module: "led", count: 2, params: { color: "yellow" } },
  { module: "led", count: 2, params: { color: "green" } },
  { module: "resistor", count: 5, params: { ohms: 220 } },
  { module: "buzzer-active", count: 1 },
];

export const launchControlBrief =
  "Launch control for a toy rocket: an ARM button, a LAUNCH button, a countdown light, and a liftoff light with a buzzer.";

export const launchControlSuiteYaml = `schema: vibread.sim/v1
author: fixture
scenarios:
  - id: T1
    title: At power-on everything is off and LAUNCH alone does nothing
    clauses: [C3]
    categories: [power-on]
    steps:
      - wait: 200
      - press: { part: BTN2 }
      - expect-part: { part: LED1, state: off }
      - expect-part: { part: LED2, state: off }
      - expect-part: { part: LED3, state: off }
      - expect-part: { part: BZ1, state: off }
  - id: T2
    title: Pressing ARM lights the red armed light, and pressing it again turns it off
    clauses: [C1]
    categories: [normal]
    steps:
      - wait: 200
      - press: { part: BTN1 }
      - expect-part: { part: LED1, state: on }
      - expect-serial: { contains: "armed" }
      - press: { part: BTN1 }
      - expect-part: { part: LED1, state: off }
  - id: T3
    title: ARM then LAUNCH blinks the countdown light, then liftoff lights green with the buzzer for one second
    clauses: [C2]
    categories: [normal]
    steps:
      - wait: 200
      - press: { part: BTN1 }
      - press: { part: BTN2, holdMs: 60, gapMs: 0 }
      - wait: 100
      - expect-part: { part: LED2, state: on, windowMs: 200 }
      - wait: 300
      - expect-part: { part: LED2, state: off, windowMs: 300 }
      - wait: 2400
      - expect-part: { part: LED3, state: on, windowMs: 300 }
      - expect-part: { part: BZ1, state: on, windowMs: 200 }
      - wait: 800
      - expect-part: { part: LED3, state: off }
      - expect-part: { part: BZ1, state: off }
      - expect-part: { part: LED1, state: off }
  - id: T4
    title: A bouncy ARM press arms only once
    clauses: [C1]
    categories: [bounce]
    steps:
      - wait: 200
      - bounce: { part: BTN1, to: true }
      - wait: 150
      - bounce: { part: BTN1, to: false }
      - wait: 200
      - expect-part: { part: LED1, state: on }
  - id: T5
    title: Two quick ARM presses arm and then disarm
    clauses: [C1]
    categories: [rapid]
    steps:
      - wait: 200
      - press: { part: BTN1, holdMs: 60, gapMs: 60 }
      - press: { part: BTN1, holdMs: 60, gapMs: 60 }
      - wait: 100
      - expect-part: { part: LED1, state: off }
`;

export const launchControlSuite = parseSuiteYaml(launchControlSuiteYaml);
