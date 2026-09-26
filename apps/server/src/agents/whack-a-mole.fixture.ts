import { CircuitSchema, TestSuiteSchema, type Circuit, type InventoryItem, type Scenario, type ScenarioStep, type TestSuite } from "@vibread/core";

/**
 * GitHub issue #16 regression fixture: the tester's whack-a-mole (three buttons D2–D4 with pull-ups, three lights D8–D10
 * through 1 kΩ, START_WAIT_MS 1000, a fixed mole order, hit → next mole after 0.5 s, miss → all lights flash). The sketch
 * does what the intent says. `naiveSuite` stacks expect-part windows as if they were simultaneous (the issue's T1 and the
 * after-hit check), so it fails although the firmware is right; `correctedSuite` tests the same intent with the timeline
 * worked out and passes.
 */

const SKETCH = `// Whack-a-mole: a light (the mole) comes on; press the button under it before it goes away.
const int BUTTON_PINS[3] = {2, 3, 4};
const int LIGHT_PINS[3] = {8, 9, 10};
const int ORDER[6] = {0, 2, 1, 0, 1, 2};   // moles 1, 3, 2, 1, 2, 3
const unsigned long START_WAIT_MS = 1000;
const unsigned long MOLE_MS = 1500;
const unsigned long GAP_MS = 500;
const unsigned long FLASH_MS = 200;
const unsigned long LOCKOUT_MS = 30;

enum Phase { WAITING, MOLE_UP, FLASHING, GAP };
Phase phase = WAITING;
unsigned long since = 0;
int turn = 0;
bool down[3] = {false, false, false};
unsigned long changedAt[3] = {0, 0, 0};

void allLights(int level) {
  for (int i = 0; i < 3; i++) digitalWrite(LIGHT_PINS[i], level);
}

// The button whose press edge happened now (-1 if none). Bounces within LOCKOUT_MS of a change are ignored.
int pressEdge(unsigned long now) {
  int pressed = -1;
  for (int i = 0; i < 3; i++) {
    bool isDown = digitalRead(BUTTON_PINS[i]) == LOW;
    if (isDown != down[i] && now - changedAt[i] >= LOCKOUT_MS) {
      down[i] = isDown;
      changedAt[i] = now;
      if (isDown && pressed < 0) pressed = i;
    }
  }
  return pressed;
}

void showMole(unsigned long now) {
  digitalWrite(LIGHT_PINS[ORDER[turn]], HIGH);
  phase = MOLE_UP;
  since = now;
  Serial.print("mole ");
  Serial.println(ORDER[turn] + 1);
}

void setup() {
  for (int i = 0; i < 3; i++) {
    pinMode(BUTTON_PINS[i], INPUT_PULLUP);
    pinMode(LIGHT_PINS[i], OUTPUT);
  }
  allLights(LOW);
  Serial.begin(115200);
  since = millis();
}

void loop() {
  unsigned long now = millis();
  int pressed = pressEdge(now);
  if (phase == WAITING) {
    if (now - since >= START_WAIT_MS) showMole(now);
  } else if (phase == MOLE_UP) {
    if (pressed >= 0) {
      allLights(LOW);
      if (pressed == ORDER[turn]) {
        Serial.println("hit");
        phase = GAP;
      } else {
        Serial.println("miss");
        allLights(HIGH);
        phase = FLASHING;
      }
      since = now;
    } else if (now - since >= MOLE_MS) {
      Serial.println("miss");
      allLights(HIGH);
      phase = FLASHING;
      since = now;
    }
  } else if (phase == FLASHING) {
    if (now - since >= FLASH_MS) {
      allLights(LOW);
      phase = GAP;
      since = now;
    }
  } else if (now - since >= GAP_MS) {
    turn = (turn + 1) % 6;
    showMole(now);
  }
}
`;

const board = (pin: string) => ({ part: "board", pin });
const pin = (part: string, id: string) => ({ part, pin: id });
const moles = [1, 2, 3] as const;
const COLORS = ["red", "green", "yellow"] as const;

export const WHACK_A_MOLE: Circuit = CircuitSchema.parse({
  schema: "vibread.circuit/0.1",
  title: "Whack-a-mole",
  summary: "Three lights take turns as the mole; press the button under the lit one before it goes away.",
  board: { profile: "uno-r3-atmega328p-5v" },
  breadboard: { profile: "bb-830" },
  parts: [
    ...moles.map((i) => ({ id: `BTN${i}`, module: "button", label: `Button ${i}`, params: {} })),
    ...moles.map((i) => ({ id: `R${i}`, module: "resistor", label: `Light ${i} resistor`, params: { ohms: 1000, tolerancePct: 5 } })),
    ...moles.map((i) => ({ id: `LED${i}`, module: "led", label: `Mole ${i} light (${COLORS[i - 1]})`, params: { color: COLORS[i - 1] } })),
  ],
  nets: [
    { id: "GND", kind: "ground", pins: [board("GND"), ...moles.map((i) => pin(`BTN${i}`, "3")), ...moles.map((i) => pin(`LED${i}`, "K"))] },
    ...moles.map((i) => ({ id: `B${i}`, kind: "signal", pins: [board(`D${i + 1}`), pin(`BTN${i}`, "1")] })),
    ...moles.map((i) => ({ id: `L${i}`, kind: "signal", pins: [board(`D${i + 7}`), pin(`R${i}`, "1")] })),
    ...moles.map((i) => ({ id: `A${i}`, kind: "signal", pins: [pin(`R${i}`, "2"), pin(`LED${i}`, "A")] })),
  ],
  roles: [
    ...moles.map((i) => ({ pin: `D${i + 1}`, mode: "INPUT_PULLUP", part: `BTN${i}`, purpose: `Button ${i}` })),
    ...moles.map((i) => ({ pin: `D${i + 7}`, mode: "OUTPUT", part: `LED${i}`, purpose: `Mole ${i} light` })),
  ],
  sketch: { source: SKETCH },
  intent: [
    { id: "C1", text: "At power-on all three lights are off; 1 second later the first mole (light 1, red) lights up." },
    { id: "C2", text: "Pressing the button under the lit mole is a hit: that light goes off, and 0.5 s later the next mole in the order 1, 3, 2, 1, 2, 3 lights up." },
    { id: "C3", text: "Pressing a different button, or not pressing within 1.5 s, is a miss: all three lights flash on together for 0.2 s, then 0.5 s later the next mole lights up." },
    { id: "C4", text: "Each press counts once, even a bouncy press." },
  ],
  assumptions: ["The mole order is fixed: 1, 3, 2, 1, 2, 3, then it repeats.", "Presses while no mole is lit are ignored."],
});

const off = (part: string, windowMs = 50): ScenarioStep => ({ "expect-part": { part, state: "off", windowMs } });
const on = (part: string, windowMs = 100): ScenarioStep => ({ "expect-part": { part, state: "on", windowMs } });

/** Scenarios that are right in both suites (misses, bounce, rapid presses). */
const SHARED: Scenario[] = [
  {
    id: "T3",
    title: "Pressing the wrong button flashes all three lights, then the next mole (3) lights up",
    clauses: ["C3"],
    categories: ["normal"],
    setup: {},
    steps: [{ wait: 1100 }, { press: { part: "BTN2", holdMs: 60, gapMs: 0 } }, on("LED1", 30), on("LED2", 30), on("LED3", 30), { wait: 150 }, off("LED3"), { wait: 450 }, on("LED3")],
  },
  {
    id: "T4",
    title: "Not pressing within 1.5 s is a miss: all lights flash, then mole 3 lights up",
    clauses: ["C3"],
    categories: ["normal"],
    setup: {},
    steps: [{ wait: 2550 }, on("LED1", 40), on("LED2", 40), on("LED3", 40), { wait: 300 }, off("LED3"), { wait: 300 }, on("LED3")],
  },
  {
    id: "T5",
    title: "A bouncy press on the red mole counts as one hit",
    clauses: ["C2", "C4"],
    categories: ["bounce"],
    setup: {},
    steps: [
      { wait: 1100 },
      { bounce: { part: "BTN1", to: true, edges: 6, ms: 8 } },
      { wait: 100 },
      { bounce: { part: "BTN1", to: false, edges: 6, ms: 8 } },
      { wait: 100 },
      off("LED1"),
      off("LED3"),
      { wait: 300 },
      on("LED3"),
    ],
  },
  {
    id: "T6",
    title: "Quick taps on a wrong button give one miss, then mole 3 lights up",
    clauses: ["C3", "C4"],
    categories: ["rapid"],
    setup: {},
    steps: [
      { wait: 1100 },
      { press: { part: "BTN3", holdMs: 40, gapMs: 40 } },
      { press: { part: "BTN3", holdMs: 40, gapMs: 40 } },
      { press: { part: "BTN3", holdMs: 40, gapMs: 40 } },
      off("LED3"),
      { wait: 500 },
      on("LED3"),
    ],
  },
];

/** The issue's mistake: consecutive expect-part steps treated as one moment, so the waits after them are too long. */
const NAIVE: Scenario[] = [
  {
    id: "T1",
    title: "At power-on all lights are off, then 1 second later the first mole (red) lights up",
    clauses: ["C1"],
    categories: ["power-on"],
    setup: {},
    // Author's belief: all three checks at t=0, wait 900 → t=900 (red still off). Really t=1050, after red came on.
    steps: [off("LED1"), off("LED2"), off("LED3"), { wait: 900 }, off("LED1"), { wait: 100 }, on("LED1")],
  },
  {
    id: "T2",
    title: "Hitting the red mole turns it off, and 0.5 s later mole 3 lights up",
    clauses: ["C2"],
    categories: ["normal"],
    setup: {},
    // Hit at t=1100 → mole 3 at t=1600. The author checks "still in the gap" at t=1500; really t=1650.
    steps: [{ wait: 1100 }, { press: { part: "BTN1", holdMs: 100, gapMs: 0 } }, off("LED1"), off("LED2"), off("LED3"), { wait: 300 }, off("LED3"), { wait: 100 }, on("LED3")],
  },
];

/** The same intent with the timeline worked out (every expect window advances the clock). */
export const CORRECTED: Scenario[] = [
  {
    id: "T1",
    title: "At power-on all lights are off, then 1 second later the first mole (red) lights up",
    clauses: ["C1"],
    categories: ["power-on"],
    setup: {},
    steps: [off("LED1", 30), off("LED2", 30), off("LED3", 30), { wait: 710 }, off("LED1"), { wait: 350 }, on("LED1")],
  },
  {
    id: "T2",
    title: "Hitting the red mole turns it off, and 0.5 s later mole 3 lights up",
    clauses: ["C2"],
    categories: ["normal"],
    setup: {},
    steps: [{ wait: 1100 }, { press: { part: "BTN1", holdMs: 100, gapMs: 0 } }, off("LED1", 30), off("LED2", 30), off("LED3", 30), { wait: 110 }, off("LED3"), { wait: 250 }, on("LED3")],
  },
];

export const NAIVE_SUITE: TestSuite = TestSuiteSchema.parse({ schema: "vibread.sim/v1", author: "test-author", scenarios: [...NAIVE, ...SHARED] });
export const CORRECTED_SUITE: TestSuite = TestSuiteSchema.parse({ schema: "vibread.sim/v1", author: "test-author", scenarios: [...CORRECTED, ...SHARED] });

export const WHACK_A_MOLE_INVENTORY: InventoryItem[] = [
  { module: "button", count: 3 },
  { module: "resistor", count: 3, params: { ohms: 1000 } },
  { module: "led", count: 1, params: { color: "red" } },
  { module: "led", count: 1, params: { color: "green" } },
  { module: "led", count: 1, params: { color: "yellow" } },
];
