import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine, type RuleProperties } from "json-rules-engine";
import {
  BOARD_PROFILES,
  boardPin,
  formatOhms,
  ledVf,
  ledVfAssumed,
  modulePins,
  netIndex,
  pinKey,
  type Circuit,
  type CompileResult,
  type ConsoleReport,
  type Finding,
  type FindingRefs,
  type LedVf,
  type ModulePin,
  type Part,
  type PinMode,
  type PinModeObservation,
  type PinRef,
} from "@vibread/core";
import { MODULES } from "@vibread/core";
import type { ElectricalType } from "@vibread/core";
import { verdictOf } from "@vibread/core";

const VCC_MIN = 4.75;
const VCC_MAX = 5.25;
const MAX_BRIGHTNESS_CURRENT_MA = 4;
const SPICE_LOW_CURRENT_FLOOR_MA = 5;
const SPICE_TIMEOUT_MS = 2_000;

interface ResistorInfo {
  part: Part;
  ohms: number;
  tolerancePct: number;
  aNet?: string;
  bNet?: string;
}

interface NetInfo {
  id: string;
  kind: Circuit["nets"][number]["kind"];
  refs: PinRef[];
  boardPins: string[];
  parts: string[];
  has5V: boolean;
  hasGnd: boolean;
}

interface SourceInfo {
  net: string;
  pin: string;
  volts: number;
}

interface LedBranch {
  led: Part;
  anodeNet?: string;
  cathodeNet?: string;
  source?: SourceInfo;
  resistorPath: ResistorInfo[];
  reverse: boolean;
  maxMa: number;
  typicalMa: number;
  brightMa: number;
}

interface BuzzerBranch {
  part: Part;
  source?: SourceInfo;
  resistorPath: ResistorInfo[];
  maxMa: number;
}

interface ButtonFact {
  button: Part;
  inputPin: string;
  inputNet?: string;
  switchedNet?: string;
  switchedRail: "5V" | "GND" | "other" | "unwired";
  roleMode?: PinMode;
  hasExternalPull: boolean;
  floating: boolean;
  needsExternalPulldown: boolean;
  bridgesRails: boolean;
}
interface DividerFact {
  inputPin: string;
  net: string;
  parts: string[];
  highRail?: "5V" | "GND";
  lowRail?: "5V" | "GND";
}


interface FindingData {
  severity: Finding["severity"];
  detail?: string;
  fix?: string;
  refs?: FindingRefs;
}

interface ElectricalFacts {
  currentByPin: Map<string, number>;
  totalCurrentMa: number;
  plannedLoadMa: number;
  ledBranches: LedBranch[];
  buzzerBranches: BuzzerBranch[];
  buttons: ButtonFact[];
  dividers: DividerFact[];
  flags: Record<string, boolean>;
  findingData: Map<string, FindingData>;
  evidence: Record<string, unknown>;
}

interface RuleSpec {
  ruleId: string;
  fact: string;
  severity: Finding["severity"];
  title: string;
  fix: string;
}

/**
 * Electrical rule data. The graph below only computes facts; this table is the
 * policy layer evaluated by json-rules-engine. Keep rule ids stable: they are
 * used by the UI, the fault dictionary, and mission audit logs.
 */
export const ELECTRICAL_RULES: readonly RuleSpec[] = [
  {
    ruleId: "CUR-PIN-DESIGN",
    fact: "curPinDesign",
    severity: "warning",
    title: "This Arduino pin is carrying more than its recommended current.",
    fix: "Raise the series resistor on this pin (the finding names the value), or drive the load through a transistor.",
  },
  {
    ruleId: "CUR-PIN-ABS",
    fact: "curPinAbs",
    severity: "error",
    title: "This Arduino pin would exceed its absolute current limit.",
    fix: "Raise the series resistor on this pin to the value the finding names, or drive the load through a transistor.",
  },
  {
    ruleId: "CUR-VCC-GND",
    fact: "curVccGnd",
    severity: "error",
    title: "The Arduino power pins would carry too much total current.",
    fix: "Raise the LED resistors (for example 220 Ω → 470 Ω) so fewer milliamps flow, or light fewer loads from Arduino pins at once.",
  },
  {
    ruleId: "PWR-USB-FUSE",
    fact: "usbFuse",
    severity: "warning",
    title: "The planned load is too close to the USB power fuse limit.",
    fix: "Keep the USB-powered load below 400 mA, or use an external supply for the load.",
  },
  {
    ruleId: "LED-RESISTOR",
    fact: "ledResistor",
    severity: "error",
    title: "This LED has no series resistor to limit its current.",
    fix: "Put a resistor in series with the LED; 220 Ω is a safe starting value for a 5 V Arduino pin.",
  },
  {
    ruleId: "LED-POLARITY",
    fact: "ledPolarity",
    severity: "error",
    title: "This LED is backwards and cannot light.",
    fix: "Connect the LED anode (+, long leg) toward the driving pin and its cathode (−, short leg) toward GND.",
  },
  {
    ruleId: "LED-CURRENT",
    fact: "ledCurrent",
    severity: "error",
    title: "This LED's resistor is too small: the LED would carry more than its 30 mA maximum.",
    fix: "Use a larger series resistor; 220 Ω is a safe value for a 5 V Arduino pin.",
  },
  {
    ruleId: "LED-DIM",
    fact: "ledDim",
    severity: "warning",
    title: "This LED may be too dim at the conservative voltage corner.",
    fix: "Use a lower-value resistor only within the pin-current limit, or use a transistor/LED driver.",
  },
  {
    ruleId: "LED-VF-ASSUMED",
    fact: "ledVfAssumed",
    severity: "info",
    title: "This LED colour has no forward-voltage data, so a conservative assumption is being used.",
    fix: "Add Vf min, typical, and max values for this colour to make the current and brightness checks more precise.",
  },
  {
    ruleId: "POT-ANALOG-PIN",
    fact: "potAnalogPin",
    severity: "error",
    title: "This knob's middle leg goes to a pin that cannot read in-between values.",
    fix: "Move the knob's middle leg (wiper) to an analog pin (A0–A5) and read it with analogRead().",
  },
  {
    ruleId: "BTN-PULLUP",
    fact: "buttonPullup",
    severity: "error",
    title: "This button input can float or has no pull-down for a 5 V switch.",
    fix: "Use INPUT_PULLUP (the Uno's internal pull-up is about 20–50 kΩ) with the button to GND, or add an external pull-down resistor when the button switches to 5 V.",
  },
  {
    ruleId: "ADC-RANGE",
    fact: "adcRange",
    severity: "error",
    title: "This analog input can be driven outside the Arduino's safe ADC range.",
    fix: "Keep the ADC net between GND and the board reference voltage; add a divider for higher-voltage sources.",
  },
  {
    ruleId: "PWM-PINS",
    fact: "pwmPins",
    severity: "error",
    title: "This PWM role is assigned to a pin that has no PWM hardware.",
    fix: "Move the PWM output to D3, D5, D6, D9, D10, or D11.",
  },
  {
    ruleId: "I2C-PINS",
    fact: "i2cPins",
    severity: "error",
    title: "This I²C signal is on the wrong Arduino pins.",
    fix: "Use A4 for SDA and A5 for SCL on the Uno/Nano.",
  },
  {
    ruleId: "SPI-PINS",
    fact: "spiPins",
    severity: "error",
    title: "This SPI signal is on the wrong Arduino pins.",
    fix: "Use D10–D13 for the Uno/Nano SPI bus (SS, MOSI, MISO, and SCK).",
  },
  {
    ruleId: "SERIAL-USB",
    fact: "serialUsb",
    severity: "warning",
    title: "This pin is shared with the USB serial connection.",
    fix: "Move the circuit to another pin, or expect uploads and USB serial telemetry to be unreliable.",
  },
  {
    ruleId: "OUT-OUT-CONFLICT",
    fact: "outOut",
    severity: "error",
    title: "Two outputs are connected to the same net.",
    fix: "Give each output its own net or make one side an input; never tie two driven pins together.",
  },
  {
    ruleId: "SHORT-GRAPH",
    fact: "shortGraph",
    severity: "error",
    title: "5 V and GND are joined, creating a short circuit.",
    fix: "Separate the power and ground rails; a button may not bridge them directly when pressed.",
  },
  {
    ruleId: "BUZZER-SERIES-R",
    fact: "buzzerSeries",
    severity: "error",
    title: "This passive buzzer needs a series resistor.",
    fix: "Put a resistor of at least 150 Ω (270 Ω keeps the pin under 20 mA) between the Arduino pin and the passive buzzer's + leg.",
  },
  {
    ruleId: "BUZZER-ACTIVE-V",
    fact: "buzzerActiveVoltage",
    severity: "warning",
    title: "This active buzzer may not receive enough voltage through its series resistor.",
    fix: "Remove the series resistor from an active buzzer, or use a driver that can supply its rated voltage and current.",
  },
  {
    ruleId: "PIN-TYPE-CONFLICT",
    fact: "pinType",
    severity: "error",
    title: "The electrical pin types on this net conflict.",
    fix: "Do not connect incompatible power/output drivers together; use a compatible input or a driver stage.",
  },
] as const;

const electricalRuleProperties: RuleProperties[] = ELECTRICAL_RULES.map((rule) => ({
  name: rule.ruleId,
  priority: 1,
  conditions: { all: [{ fact: rule.fact, operator: "equal", value: true }] },
  event: { type: "electrical-finding", params: { ruleId: rule.ruleId } },
}));

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)];
}


function partPinNet(pinNets: Map<string, string>, part: string, pin: string): string | undefined {
  return pinNets.get(`${part}.${pin}`);
}

function resistorInfo(part: Part, pinNets: Map<string, string>): ResistorInfo {
  const params = part.params as Record<string, unknown>;
  const ohms = typeof params.ohms === "number" && params.ohms > 0 ? params.ohms : Number.POSITIVE_INFINITY;
  const tolerancePct = typeof params.tolerancePct === "number" && params.tolerancePct >= 0 ? params.tolerancePct : 5;
  return {
    part,
    ohms,
    tolerancePct,
    aNet: partPinNet(pinNets, part.id, "1"),
    bNet: partPinNet(pinNets, part.id, "2"),
  };
}

function resistorPath(
  startNet: string | undefined,
  targetNet: string | undefined,
  resistors: readonly ResistorInfo[],
): ResistorInfo[] | undefined {
  if (!startNet || !targetNet) return undefined;
  if (startNet === targetNet) return [];
  const queue: { net: string; path: ResistorInfo[] }[] = [{ net: startNet, path: [] }];
  const visited = new Set<string>([startNet]);
  while (queue.length) {
    const state = queue.shift();
    if (!state) break;
    for (const resistor of resistors) {
      const next = resistor.aNet === state.net ? resistor.bNet : resistor.bNet === state.net ? resistor.aNet : undefined;
      if (!next || visited.has(next)) continue;
      const path = [...state.path, resistor];
      if (next === targetNet) return path;
      visited.add(next);
      queue.push({ net: next, path });
    }
  }
  return undefined;
}
function resistorPathToRail(
  nets: Map<string, NetInfo>,
  startNet: string | undefined,
  rail: "5V" | "GND",
  resistors: readonly ResistorInfo[],
): ResistorInfo[] | undefined {
  if (!startNet) return undefined;
  if (netHasRail(nets, startNet, rail)) return [];
  for (const net of nets.values()) {
    if (!netHasRail(nets, net.id, rail)) continue;
    const path = resistorPath(startNet, net.id, resistors);
    if (path) return path;
  }
  return undefined;
}

function mergeResistorPaths(...paths: readonly (readonly ResistorInfo[] | undefined)[]): ResistorInfo[] | undefined {
  if (paths.some((path) => path === undefined)) return undefined;
  const merged: ResistorInfo[] = [];
  const seen = new Set<string>();
  for (const path of paths) {
    for (const resistor of path ?? []) {
      if (seen.has(resistor.part.id)) continue;
      seen.add(resistor.part.id);
      merged.push(resistor);
    }
  }
  return merged;
}


function sumResistance(path: readonly ResistorInfo[]): number {
  return path.reduce((sum, resistor) => sum + resistor.ohms, 0);
}

function minResistance(path: readonly ResistorInfo[]): number {
  return path.reduce((sum, resistor) => sum + resistor.ohms * (1 - resistor.tolerancePct / 100), 0);
}

function maxResistance(path: readonly ResistorInfo[]): number {
  return path.reduce((sum, resistor) => sum + resistor.ohms * (1 + resistor.tolerancePct / 100), 0);
}

function currentMa(volts: number, vf: number, resistance: number): number {
  return Math.max(0, ((volts - vf) / Math.max(resistance, 0.001)) * 1_000);
}

/** E12 multipliers: the resistor values sold in beginner kits (100, 120, 150, 180, 220, 270, 330, 390, 470, 560, 680, 820). */
const E12 = [1.0, 1.2, 1.5, 1.8, 2.2, 2.7, 3.3, 3.9, 4.7, 5.6, 6.8, 8.2] as const;

function e12Values(fromOhms: number): number[] {
  const decade = 10 ** Math.floor(Math.log10(Math.max(fromOhms, 1)));
  return [decade / 10, decade, decade * 10].flatMap((scale) => E12.map((m) => Math.round(m * scale * 100) / 100));
}

/** Smallest kit value that is at least `ohms`. */
function kitOhmsAtLeast(ohms: number): number {
  return e12Values(ohms).find((value) => value >= ohms - 1e-9) ?? Math.ceil(ohms);
}

/** Largest kit value that is at most `ohms`, or undefined below 1 Ω. */
function kitOhmsAtMost(ohms: number): number | undefined {
  if (!(ohms >= 1)) return undefined;
  return e12Values(ohms).findLast((value) => value <= ohms + 1e-9);
}

/**
 * Smallest kit resistor that keeps a series LED/coil branch at or under `limitMa` at the conservative corner (5.25 V,
 * minimum Vf, resistor at the low end of its tolerance). `otherOhms` is fixed resistance already in the loop (a coil).
 */
function minSeriesOhmsFor(limitMa: number, vfMin: number, tolerancePct: number, otherOhms = 0): number {
  const needed = ((VCC_MAX - vfMin) / (limitMa / 1_000) - otherOhms) / (1 - tolerancePct / 100);
  return kitOhmsAtLeast(Math.max(1, needed));
}

/** The first board pin from `candidates` that no net uses yet (for "move it to …" fixes). */
function freeBoardPin(circuit: Circuit, candidates: readonly string[]): string | undefined {
  const used = new Set(circuit.nets.flatMap((net) => net.pins.filter((ref) => ref.part === "board").map((ref) => ref.pin)));
  const board = BOARD_PROFILES[circuit.board.profile];
  return candidates.find((pin) => !used.has(pin) && boardPin(board, pin) !== undefined);
}

const FREE_DIGITAL_PINS = ["D2", "D3", "D4", "D5", "D6", "D7", "D8", "D9", "D10", "D11", "D12", "D13", "A1", "A2", "A3"] as const;
const FREE_ANALOG_PINS = ["A0", "A1", "A2", "A3", "A6", "A7", "A4", "A5"] as const;

function modulePin(part: Part, id: string): ModulePin | undefined {
  return modulePins(part).find((pin) => pin.id === id);
}

function boardSourceForNet(
  circuit: Circuit,
  nets: Map<string, NetInfo>,
  roleByPin: Map<string, Circuit["roles"][number]>,
  net: string | undefined,
): SourceInfo | undefined {
  if (!net) return undefined;
  const info = nets.get(net);
  if (!info) return undefined;
  const candidates: SourceInfo[] = [];
  for (const boardPinName of info.boardPins) {
    if (boardPinName === "5V") candidates.push({ net, pin: boardPinName, volts: BOARD_PROFILES[circuit.board.profile].vcc });
    const role = roleByPin.get(boardPinName);
    if (role && (role.mode === "OUTPUT" || role.mode === "PWM_OUT")) {
      candidates.push({ net, pin: boardPinName, volts: BOARD_PROFILES[circuit.board.profile].vcc });
    }
  }
  return candidates[0];
}

function netHasRail(nets: Map<string, NetInfo>, net: string | undefined, rail: "5V" | "GND"): boolean {
  if (!net) return false;
  const info = nets.get(net);
  return rail === "5V" ? Boolean(info?.has5V) : Boolean(info?.hasGnd);
}


function netsOfPin(nets: Map<string, NetInfo>, part: string, pin: string): string | undefined {
  for (const net of nets.values()) {
    if (net.refs.some((ref) => ref.part === part && ref.pin === pin)) return net.id;
  }
  return undefined;
}

function makeNets(circuit: Circuit): { nets: Map<string, NetInfo>; pinNets: Map<string, string> } {
  const nets = new Map<string, NetInfo>();
  const pinNets = netIndex(circuit);
  for (const net of circuit.nets) {
    const boardPins = net.pins.filter((ref) => ref.part === "board").map((ref) => ref.pin);
    nets.set(net.id, {
      id: net.id,
      kind: net.kind,
      refs: net.pins,
      boardPins,
      parts: dedupe(net.pins.filter((ref) => ref.part !== "board").map((ref) => ref.part)),
      has5V: boardPins.includes("5V"),
      hasGnd: boardPins.includes("GND"),
    });
  }
  return { nets, pinNets };
}

function makeSources(circuit: Circuit, nets: Map<string, NetInfo>): { sources: SourceInfo[]; roleByPin: Map<string, Circuit["roles"][number]> } {
  const roleByPin = new Map(circuit.roles.map((role) => [role.pin, role]));
  const sources: SourceInfo[] = [];
  for (const net of nets.values()) {
    const source = boardSourceForNet(circuit, nets, roleByPin, net.id);
    if (source) sources.push(source);
  }
  return { sources, roleByPin };
}

function ledBranches(
  circuit: Circuit,
  nets: Map<string, NetInfo>,
  pinNets: Map<string, string>,
  sources: readonly SourceInfo[],
  resistors: readonly ResistorInfo[],
): LedBranch[] {
  const result: LedBranch[] = [];
  for (const led of circuit.parts.filter((part) => part.module === "led")) {
    const anodeNet = partPinNet(pinNets, led.id, "A");
    const cathodeNet = partPinNet(pinNets, led.id, "K");
    const vf = ledVf(led.params);
    let selected: LedBranch | undefined;
    for (const source of sources) {
      const forwardPath = mergeResistorPaths(
        resistorPath(source.net, anodeNet, resistors),
        resistorPathToRail(nets, cathodeNet, "GND", resistors),
      );
      if (forwardPath) {
        selected = {
          led,
          anodeNet,
          cathodeNet,
          source,
          resistorPath: forwardPath,
          reverse: false,
          maxMa: forwardPath.length ? currentMa(VCC_MAX, vf.min, minResistance(forwardPath)) : 0,
          typicalMa: forwardPath.length ? currentMa(source.volts, vf.typ, sumResistance(forwardPath)) : 0,
          brightMa: forwardPath.length ? currentMa(VCC_MIN, vf.max, maxResistance(forwardPath) + BOARD_PROFILES[circuit.board.profile].driverOhms.effective) : 0,
        };
        break;
      }
      const reversePath = mergeResistorPaths(
        resistorPath(source.net, cathodeNet, resistors),
        resistorPathToRail(nets, anodeNet, "GND", resistors),
      );
      if (reversePath) {
        selected = {
          led,
          anodeNet,
          cathodeNet,
          source,
          resistorPath: reversePath,
          reverse: true,
          maxMa: 0,
          typicalMa: 0,
          brightMa: 0,
        };
        break;
      }
    }
    if (!selected) {
      // Preserve unpowered LEDs for the resistor/polarity rules. A source may
      // be absent when the graph is already malformed, but direct rail facts
      // still give a useful beginner-facing finding.
      const forwardPath = resistorPath(
        nets.get(anodeNet ?? "")?.has5V ? anodeNet : undefined,
        cathodeNet,
        resistors,
      );
      if (forwardPath && netHasRail(nets, cathodeNet, "GND")) {
        selected = {
          led,
          anodeNet,
          cathodeNet,
          resistorPath: forwardPath,
          reverse: false,
          maxMa: 0,
          typicalMa: 0,
          brightMa: 0,
        };
      }
    }
    if (selected) result.push(selected);
  }
  return result;
}

function buzzerBranches(
  circuit: Circuit,
  nets: Map<string, NetInfo>,
  pinNets: Map<string, string>,
  sources: readonly SourceInfo[],
  resistors: readonly ResistorInfo[],
): BuzzerBranch[] {
  const result: BuzzerBranch[] = [];
  for (const buzzer of circuit.parts.filter((part) => part.module === "buzzer-active" || part.module === "buzzer-passive")) {
    const positiveNet = partPinNet(pinNets, buzzer.id, "P");
    const negativeNet = partPinNet(pinNets, buzzer.id, "N");
    if (!positiveNet || !negativeNet) continue;
    for (const source of sources) {
      const path = mergeResistorPaths(
        resistorPath(source.net, positiveNet, resistors),
        resistorPathToRail(nets, negativeNet, "GND", resistors),
      );
      if (!path) continue;
      const electrical = MODULES[buzzer.module].electrical;
      const coil = electrical.coilOhms ?? Number.POSITIVE_INFINITY;
      const load = buzzer.module === "buzzer-active"
        ? electrical.currentMa ?? 0
        : currentMa(VCC_MAX, 0, coil + minResistance(path) + BOARD_PROFILES[circuit.board.profile].driverOhms.min);
      result.push({ part: buzzer, source, resistorPath: path, maxMa: load });
      break;
    }
  }
  return result;
}

function buttonFacts(
  circuit: Circuit,
  nets: Map<string, NetInfo>,
  pinNets: Map<string, string>,
): ButtonFact[] {
  const result: ButtonFact[] = [];
  for (const button of circuit.parts.filter((part) => part.module === "button")) {
    const groups = MODULES.button.internallyConnected ?? [["1", "2"], ["3", "4"]];
    const groupNets = groups.map((group) => dedupe(group.map((pin) => partPinNet(pinNets, button.id, pin)).filter((net): net is string => Boolean(net))));
    const role = circuit.roles.find((candidate) => candidate.part === button.id && (candidate.mode === "INPUT" || candidate.mode === "INPUT_PULLUP"));
    const inputPin = role ? role.pin : "";
    const inputNet = role ? netsOfPin(nets, "board", role.pin) : undefined;
    const inputGroup = groupNets.findIndex((group) => inputNet !== undefined && group.includes(inputNet));
    const switchedNet = inputGroup >= 0 ? groupNets.find((_, index) => index !== inputGroup)?.[0] : groupNets.flat()[0];
    const switchedRail: ButtonFact["switchedRail"] = switchedNet === undefined
      ? "unwired"
      : netHasRail(nets, switchedNet, "5V")
        ? "5V"
        : netHasRail(nets, switchedNet, "GND")
          ? "GND"
          : "other";
    const hasExternalPull = Boolean(inputNet && circuit.parts.some((part) => {
      if (part.module !== "resistor") return false;
      const resistor = resistorInfo(part, pinNets);
      if (resistor.aNet !== inputNet && resistor.bNet !== inputNet) return false;
      const other = resistor.aNet === inputNet ? resistor.bNet : resistor.aNet;
      if (switchedRail === "5V") return netHasRail(nets, other, "GND");
      if (switchedRail === "GND") return netHasRail(nets, other, "5V");
      return netHasRail(nets, other, "5V") || netHasRail(nets, other, "GND");
    }));
    const mode = role?.mode;
    // A6/A7 on the Nano are ADC-only: INPUT_PULLUP there enables nothing, so the input still floats.
    const internalPullup = mode === "INPUT_PULLUP" && boardPin(BOARD_PROFILES[circuit.board.profile], inputPin)?.digital !== false;
    const needsExternalPulldown = switchedRail === "5V" && !hasExternalPull;
    const floating = switchedRail !== "5V" && switchedRail !== "GND"
      ? !hasExternalPull && !internalPullup
      : switchedRail === "GND" && !hasExternalPull && !internalPullup;
    const groupRails = groupNets.map((group) => ({
      fiveV: group.some((net) => netHasRail(nets, net, "5V")),
      gnd: group.some((net) => netHasRail(nets, net, "GND")),
    }));
    const bridgesRails = groupRails.some((group, index) => group.fiveV && groupRails.some((other, otherIndex) => otherIndex !== index && other.gnd));
    result.push({ button, inputPin, inputNet, switchedNet, switchedRail, roleMode: mode, hasExternalPull, floating, needsExternalPulldown, bridgesRails });
  }
  return result;
}

function netPinTypes(
  circuit: Circuit,
  nets: Map<string, NetInfo>,
  roleByPin: Map<string, Circuit["roles"][number]>,
): Map<string, { types: ElectricalType[]; refs: string[] }> {
  const result = new Map<string, { types: ElectricalType[]; refs: string[] }>();
  const board = BOARD_PROFILES[circuit.board.profile];
  for (const net of nets.values()) {
    const types: ElectricalType[] = [];
    const refs: string[] = [];
    for (const ref of net.refs) {
      let type: ElectricalType | undefined;
      if (ref.part === "board") {
        const pin = boardPin(board, ref.pin);
        const role = roleByPin.get(ref.pin);
        type = role && (role.mode === "OUTPUT" || role.mode === "PWM_OUT")
          ? "output"
          : role
            ? "input"
            : pin?.etype;
      } else {
        const part = circuit.parts.find((candidate) => candidate.id === ref.part);
        type = part ? modulePin(part, ref.pin)?.etype : undefined;
      }
      if (type) types.push(type);
      refs.push(pinKey(ref));
    }
    result.set(net.id, { types, refs });
  }
  return result;
}
function dividerFacts(circuit: Circuit, nets: Map<string, NetInfo>, pinNets: Map<string, string>): DividerFact[] {
  const dividers: DividerFact[] = [];
  for (const role of circuit.roles.filter((candidate) => candidate.mode === "ANALOG_IN")) {
    const net = netsOfPin(nets, "board", role.pin);
    if (!net) continue;
    const connectedParts = circuit.parts.filter((part) => nets.get(net)?.parts.includes(part.id));
    const rails = new Set<"5V" | "GND">();
    for (const part of connectedParts) {
      for (const pin of modulePins(part)) {
        const pinNet = partPinNet(pinNets, part.id, pin.id);
        if (!pinNet || pinNet === net) continue;
        if (netHasRail(nets, pinNet, "5V")) rails.add("5V");
        if (netHasRail(nets, pinNet, "GND")) rails.add("GND");
      }
    }
    if (rails.has("5V") && rails.has("GND") && connectedParts.length >= 1) {
      dividers.push({ inputPin: role.pin, net, parts: connectedParts.map((part) => part.id), highRail: "5V", lowRail: "GND" });
    }
  }
  return dividers;
}

function directRailLoadMa(circuit: Circuit, nets: Map<string, NetInfo>, pinNets: Map<string, string>, resistors: readonly ResistorInfo[]): number {
  let load = 0;
  for (const resistor of resistors) {
    const acrossRails = (netHasRail(nets, resistor.aNet, "5V") && netHasRail(nets, resistor.bNet, "GND"))
      || (netHasRail(nets, resistor.bNet, "5V") && netHasRail(nets, resistor.aNet, "GND"));
    if (acrossRails) load += currentMa(VCC_MAX, 0, minResistance([resistor]));
  }
  for (const potentiometer of circuit.parts.filter((part) => part.module === "potentiometer")) {
    const aNet = partPinNet(pinNets, potentiometer.id, "A");
    const bNet = partPinNet(pinNets, potentiometer.id, "B");
    if (!((netHasRail(nets, aNet, "5V") && netHasRail(nets, bNet, "GND")) || (netHasRail(nets, bNet, "5V") && netHasRail(nets, aNet, "GND")))) continue;
    const params = potentiometer.params as Record<string, unknown>;
    const ohms = typeof params.ohms === "number" && params.ohms > 0 ? params.ohms : 10_000;
    load += currentMa(VCC_MAX, 0, ohms * 0.8);
  }
  return load;
}


function electricalFacts(circuit: Circuit): ElectricalFacts {
  const { nets, pinNets } = makeNets(circuit);
  const { sources, roleByPin } = makeSources(circuit, nets);
  const resistors = circuit.parts.filter((part) => part.module === "resistor").map((part) => resistorInfo(part, pinNets));
  const leds = ledBranches(circuit, nets, pinNets, sources, resistors);
  const buzzers = buzzerBranches(circuit, nets, pinNets, sources, resistors);
  const buttons = buttonFacts(circuit, nets, pinNets);
  const dividers = dividerFacts(circuit, nets, pinNets);
  const currentByPin = new Map<string, number>();
  const findings = new Map<string, FindingData>();
  const addFinding = (ruleId: string, data: FindingData): void => {
    const previous = findings.get(ruleId);
    if (!previous) {
      findings.set(ruleId, data);
      return;
    }
    const detail = [previous.detail, data.detail].filter((item): item is string => Boolean(item));
    const refs: FindingRefs = {
      parts: dedupe([...(previous.refs?.parts ?? []), ...(data.refs?.parts ?? [])]),
      nets: dedupe([...(previous.refs?.nets ?? []), ...(data.refs?.nets ?? [])]),
      pins: dedupe([...(previous.refs?.pins ?? []), ...(data.refs?.pins ?? [])]),
    };
    const fix = previous.fix && data.fix && previous.fix !== data.fix ? `${previous.fix} ${data.fix}` : previous.fix ?? data.fix;
    findings.set(ruleId, { ...previous, detail: detail.join("; "), refs, ...(fix ? { fix } : {}) });
  };
  for (const led of circuit.parts.filter((part) => part.module === "led")) {
    if (ledVfAssumed(led.params)) {
      addFinding("LED-VF-ASSUMED", {
        severity: "info",
        detail: `${led.id} uses the conservative assumed Vf range 1.8–2.6–3.4 V.`,
        refs: { parts: [led.id] },
      });
    }
  }
  const board = BOARD_PROFILES[circuit.board.profile];
  /** `corner` names the assumptions behind `current`, in words that fit the part (an LED has Vf; a buzzer has a coil). */
  const addPinCurrent = (pin: string | undefined, current: number, corner: string, refs: FindingRefs, fix?: string): void => {
    if (!pin) return;
    currentByPin.set(pin, (currentByPin.get(pin) ?? 0) + current);
    const boardSourcePin = boardPin(board, pin);
    if (!boardSourcePin || (boardSourcePin.kind !== "digital" && boardSourcePin.kind !== "analog")) return;
    const detail = `${pin} is planned at ${current.toFixed(2)} mA ${corner}.`;
    if (current > board.limits.pinDesignMa) {
      addFinding("CUR-PIN-DESIGN", { severity: "warning", detail, refs, ...(fix ? { fix } : {}) });
    }
    if (current > board.limits.pinAbsMa) {
      addFinding("CUR-PIN-ABS", { severity: "error", detail, refs, ...(fix ? { fix } : {}) });
    }
  };
  const ledIfAbsMa = MODULES.led.electrical.ifAbsMa ?? 30;

  for (const branch of leds) {
    const refs: FindingRefs = {
      parts: [branch.led.id, ...branch.resistorPath.map((resistor) => resistor.part.id)],
      nets: [branch.anodeNet, branch.cathodeNet, branch.source?.net].filter((net): net is string => Boolean(net)),
      pins: [branch.source?.pin ? `board.${branch.source.pin}` : "", `${branch.led.id}.A`, `${branch.led.id}.K`].filter(Boolean),
    };
    const from = branch.source?.pin ?? "the 5 V pin";
    const vf = ledVf(branch.led.params);
    if (!branch.resistorPath.length) {
      const suggested = minSeriesOhmsFor(board.limits.pinDesignMa, vf.min, 5);
      addFinding("LED-RESISTOR", {
        severity: "error",
        detail: `${branch.led.id} has no series resistor on its LED branch.`,
        fix: `Put a ${formatOhms(Math.max(220, suggested))} resistor between ${from} and ${branch.led.id}'s long leg (anode).`,
        refs,
      });
    }
    if (branch.reverse) {
      addFinding("LED-POLARITY", {
        severity: "error",
        detail: `${branch.led.id} cathode is toward ${branch.source?.pin ?? "the driving source"} while its anode is on GND.`,
        refs,
      });
      continue;
    }
    if (branch.resistorPath.length) {
      const tolerancePct = branch.resistorPath[0]?.tolerancePct ?? 5;
      const suggested = minSeriesOhmsFor(board.limits.pinDesignMa, vf.min, tolerancePct);
      const present = branch.resistorPath.map((resistor) => `${resistor.part.id} (${formatOhms(resistor.ohms)})`).join(" + ");
      const raiseFix = branch.resistorPath.length === 1
        ? `Change ${present} to ${formatOhms(suggested)} or more for ${branch.led.id}.`
        : `Raise ${present} to ${formatOhms(suggested)} or more in total for ${branch.led.id}.`;
      addPinCurrent(branch.source?.pin, branch.maxMa, "at the conservative maximum-current corner (5.25 V, minimum Vf, minimum resistor)", refs, raiseFix);
      if (branch.maxMa > ledIfAbsMa) {
        addFinding("LED-CURRENT", {
          severity: "error",
          detail: `${branch.led.id} (${String(branch.led.params.color ?? "red")}) would carry ${branch.maxMa.toFixed(2)} mA through ${present} at the conservative corner; LEDs are rated ${ledIfAbsMa} mA maximum.`,
          fix: raiseFix,
          refs,
        });
      }
      if (branch.brightMa < MAX_BRIGHTNESS_CURRENT_MA) {
        const brightest = kitOhmsAtMost(((VCC_MIN - vf.max) / (MAX_BRIGHTNESS_CURRENT_MA / 1_000) - board.driverOhms.effective) / (1 + tolerancePct / 100));
        const safe = brightest !== undefined && brightest >= suggested;
        addFinding("LED-DIM", {
          severity: "warning",
          detail: `${branch.led.id} is only ${branch.brightMa.toFixed(2)} mA at 4.75 V with a 45 Ω driver and maximum Vf.`,
          fix: safe
            ? `Change ${present} to about ${formatOhms(brightest)} (brighter, still under ${board.limits.pinDesignMa} mA).`
            : `No single resistor makes ${branch.led.id} both bright and pin-safe; drive it through a transistor from ${from}.`,
          refs,
        });
      }
    }
  }
  for (const branch of buzzers) {
    const refs: FindingRefs = {
      parts: [branch.part.id, ...branch.resistorPath.map((resistor) => resistor.part.id)],
      nets: [branch.source?.net].filter((net): net is string => Boolean(net)),
      pins: [branch.source?.pin ? `board.${branch.source.pin}` : "", `${branch.part.id}.P`, `${branch.part.id}.N`].filter(Boolean),
    };
    const electrical = MODULES[branch.part.module].electrical;
    if (branch.part.module === "buzzer-active" && branch.resistorPath.length) {
      const current = (electrical.currentMa ?? 30) / 1_000;
      const seriesOhms = sumResistance(branch.resistorPath) + BOARD_PROFILES[circuit.board.profile].driverOhms.effective;
      const buzzerVolts = VCC_MIN - current * seriesOhms;
      if (buzzerVolts < 3) {
        addFinding("BUZZER-ACTIVE-V", {
          severity: "warning",
          detail: `${branch.part.id} would receive about ${Math.max(0, buzzerVolts).toFixed(2)} V through ${sumResistance(branch.resistorPath).toFixed(1)} Ω of series resistance; active buzzers need about 3 V.`,
          refs,
        });
      }
    }
    const minSeries = electrical.minSeriesOhms ?? 0;
    const cleanSeries = minSeriesOhmsFor(board.limits.pinDesignMa, 0, 5, electrical.coilOhms ?? 0);
    const buzzerFix = `Put a ${formatOhms(cleanSeries)} resistor between ${branch.source?.pin ?? "the pin"} and ${branch.part.id}'s + leg (at least ${formatOhms(minSeries)}).`;
    if (branch.part.module === "buzzer-passive" && branch.resistorPath.length && sumResistance(branch.resistorPath) < minSeries) {
      addFinding("BUZZER-SERIES-R", {
        severity: "error",
        detail: `${branch.part.id} has ${sumResistance(branch.resistorPath).toFixed(1)} Ω in series; it needs at least ${minSeries} Ω.`,
        fix: buzzerFix,
        refs,
      });
    } else if (branch.part.module === "buzzer-passive" && !branch.resistorPath.length) {
      addFinding("BUZZER-SERIES-R", {
        severity: "error",
        detail: `${branch.part.id} has no series resistor; its ${electrical.coilOhms ?? 0} Ω coil would overload the pin.`,
        fix: buzzerFix,
        refs,
      });
    }
    addPinCurrent(
      branch.source?.pin,
      branch.maxMa,
      branch.part.module === "buzzer-passive"
        ? branch.resistorPath.length
          ? `at the conservative maximum-current corner (5.25 V, ${electrical.coilOhms ?? 0} Ω coil, series resistor at the low end of its tolerance)`
          : `at the conservative maximum-current corner (5.25 V, ${electrical.coilOhms ?? 0} Ω coil, no series resistor)`
        : `at its rated draw (active buzzers pull about ${electrical.currentMa ?? 30} mA whatever the series resistance)`,
      refs,
      branch.part.module === "buzzer-passive"
        ? buzzerFix
        : `${branch.part.id} draws about ${electrical.currentMa ?? 30} mA: switch it through an NPN transistor (e.g. 2N2222 with a 1 kΩ base resistor) from ${branch.source?.pin ?? "the pin"}.`,
    );
  }

  for (const button of buttons) {
    if (button.floating || button.needsExternalPulldown) {
      const pin = button.inputPin || "the input pin";
      // pinMode() takes 2 for D2 but A0 for A0.
      const pinArg = /^D\d+$/.test(pin) ? pin.slice(1) : pin;
      const noInternal = button.roleMode === "INPUT_PULLUP" && boardPin(board, button.inputPin)?.digital === false;
      addFinding("BTN-PULLUP", {
        severity: "error",
        detail: button.needsExternalPulldown
          ? `${button.button.id} switches ${button.inputPin} to 5 V but has no external pull-down resistor.`
          : noInternal
            ? `${button.button.id} is on ${button.inputPin}, which is analog-input only and has no internal pull-up, so INPUT_PULLUP does nothing.`
            : `${button.button.id} on ${button.inputPin || "an input"} has neither INPUT_PULLUP nor an external pull resistor.`,
        fix: button.needsExternalPulldown
          ? `Add a 10 kΩ resistor from ${pin} to GND, or move ${button.button.id}'s other leg from 5 V to GND and use pinMode(${pinArg}, INPUT_PULLUP).`
          : noInternal
            ? `Move ${button.button.id} from ${pin} to ${freeBoardPin(circuit, FREE_DIGITAL_PINS) ?? "a D pin"} and use INPUT_PULLUP, or add a 10 kΩ resistor from ${pin} to 5 V.`
            : button.switchedRail === "GND"
              // hasExternalPull only counts a resistor to the rail opposite the switched one: 5 V here.
              ? `Set ${pin} to INPUT_PULLUP (pinMode(${pinArg}, INPUT_PULLUP)), or add a 10 kΩ pull-up resistor from ${pin} to 5 V.`
              : `Set ${pin} to INPUT_PULLUP (pinMode(${pinArg}, INPUT_PULLUP)) with ${button.button.id}'s other leg on GND, or add a 10 kΩ pull-down resistor from ${pin} to GND with the other leg on 5 V.`,
        refs: {
          parts: [button.button.id],
          nets: [button.inputNet, button.switchedNet].filter((net): net is string => Boolean(net)),
          pins: button.inputPin ? [`board.${button.inputPin}`] : [],
        },
      });
    }
  }

  const pinTypeFacts = netPinTypes(circuit, nets, roleByPin);

  const outOutNets: string[] = [];
  const outOutPins: string[] = [];
  for (const net of nets.values()) {
    const outputs = net.boardPins.filter((pin) => {
      const role = roleByPin.get(pin);
      return role?.mode === "OUTPUT" || role?.mode === "PWM_OUT";
    });
    const moduleOutputs = net.refs.filter((ref) => {
      if (ref.part === "board") return false;
      const part = circuit.parts.find((candidate) => candidate.id === ref.part);
      return Boolean(part && (modulePin(part, ref.pin)?.etype === "output" || modulePin(part, ref.pin)?.etype === "power_out"));
    });
    if (outputs.length + moduleOutputs.length > 1) {
      outOutNets.push(net.id);
      outOutPins.push(...outputs.map((pin) => `board.${pin}`), ...moduleOutputs.map((ref) => pinKey(ref)));
    }
  }
  if (outOutNets.length) {
    addFinding("OUT-OUT-CONFLICT", {
      severity: "error",
      detail: `Nets ${outOutNets.join(", ")} have multiple driven outputs (${outOutPins.join(", ")}).`,
      refs: { nets: outOutNets, pins: outOutPins },
    });
  }
  const outOutNetSet = new Set(outOutNets);
  const typeConflictRefs: FindingRefs = { nets: [], pins: [] };
  for (const [netId, value] of pinTypeFacts) {
    const net = nets.get(netId);
    const drivers = value.types.filter((type) => type === "output" || type === "power_out");
    if (drivers.length > 1 && !outOutNetSet.has(netId) && !(net?.has5V && net.hasGnd)) {
      typeConflictRefs.nets?.push(netId);
      typeConflictRefs.pins?.push(...value.refs);
    }
  }
  if (typeConflictRefs.nets?.length) {
    addFinding("PIN-TYPE-CONFLICT", {
      severity: "error",
      detail: "A net contains more than one active power/output driver according to the KiCad-style electrical type matrix.",
      refs: typeConflictRefs,
    });
  }

  const pwmBad: string[] = [];
  const i2cBad: string[] = [];
  const spiBad: string[] = [];
  const serialPins: string[] = [];
  const adcBad: string[] = [];
  for (const role of circuit.roles) {
    const pin = boardPin(board, role.pin);
    const purpose = role.purpose.toLowerCase();
    if (role.mode === "PWM_OUT" && !pin?.pwm) pwmBad.push(role.pin);
    if (/\b(i2c|sda|scl)\b/.test(purpose)) {
      const expected = /sda/.test(purpose) ? "A4" : /scl/.test(purpose) ? "A5" : undefined;
      if ((expected && role.pin !== expected) || (!expected && role.pin !== "A4" && role.pin !== "A5")) i2cBad.push(role.pin);
    }
    if (/\bspi\b|\b(ss|mosi|miso|sck)\b/.test(purpose) && !["D10", "D11", "D12", "D13"].includes(role.pin)) spiBad.push(role.pin);
    if (["D0", "D1"].includes(role.pin)) serialPins.push(role.pin);
    if (role.mode === "ANALOG_IN") {
      const net = netsOfPin(nets, "board", role.pin);
      const info = nets.get(net ?? "");
      if (!pin || pin.adc === undefined || info?.boardPins.includes("VIN")) adcBad.push(role.pin);
    }
  }
  const potsOnDigital: { pot: string; pins: string[] }[] = [];
  for (const pot of circuit.parts.filter((part) => part.module === "potentiometer")) {
    const wiperNet = partPinNet(pinNets, pot.id, "W");
    const pins = (wiperNet ? nets.get(wiperNet)?.boardPins ?? [] : []).filter((name) => {
      const pin = boardPin(board, name);
      if (!pin || (pin.kind !== "digital" && pin.kind !== "analog")) return false;
      const mode = roleByPin.get(name)?.mode;
      // A pin driving the wiper uses the pot as a rheostat (e.g. an LED dimmer), which needs no analog read.
      if (mode === "OUTPUT" || mode === "PWM_OUT") return false;
      return pin.adc === undefined || mode !== "ANALOG_IN";
    });
    if (pins.length) potsOnDigital.push({ pot: pot.id, pins });
  }
  const freeAnalog = freeBoardPin(circuit, FREE_ANALOG_PINS);
  for (const { pot, pins } of potsOnDigital) {
    const onAnalog = pins.find((name) => boardPin(board, name)?.adc !== undefined);
    const target = onAnalog ?? freeAnalog ?? "A0";
    addFinding("POT-ANALOG-PIN", {
      severity: "error",
      detail: `${pot}'s middle leg (wiper) is on ${pins.join(", ")}, read as a plain on/off input, so turning the knob gives only HIGH or LOW.`,
      fix: onAnalog
        ? `Give ${onAnalog} an ANALOG_IN role and read ${pot} with analogRead(${onAnalog}).`
        : `Move ${pot}'s middle leg to ${target}, give ${target} an ANALOG_IN role, and read it with analogRead(${target}).`,
      refs: { parts: [pot], pins: pins.map((pin) => `board.${pin}`) },
    });
  }
  if (pwmBad.length) {
    const freePwm = freeBoardPin(circuit, ["D3", "D5", "D6", "D9", "D10", "D11"]);
    addFinding("PWM-PINS", {
      severity: "error",
      detail: `PWM roles use non-PWM pins: ${pwmBad.join(", ")}.`,
      fix: `Move ${pwmBad.join(", ")} to a PWM pin${freePwm ? ` such as ${freePwm}` : ""} (D3, D5, D6, D9, D10, or D11).`,
      refs: { pins: pwmBad.map((pin) => `board.${pin}`) },
    });
  }
  if (i2cBad.length) addFinding("I2C-PINS", { severity: "error", detail: `I²C roles are on ${i2cBad.join(", ")} instead of A4/A5.`, refs: { pins: i2cBad.map((pin) => `board.${pin}`) } });
  if (spiBad.length) addFinding("SPI-PINS", { severity: "error", detail: `SPI roles are on ${spiBad.join(", ")} instead of D10–D13.`, refs: { pins: spiBad.map((pin) => `board.${pin}`) } });
  if (serialPins.length) {
    const onSerial = circuit.roles.filter((role) => serialPins.includes(role.pin));
    const taken = new Set<string>();
    const nextFree = () => {
      const pin = freeBoardPin(circuit, FREE_DIGITAL_PINS.filter((candidate) => !taken.has(candidate)));
      if (pin) taken.add(pin);
      return pin ?? "a free pin from D2 to D13";
    };
    // A UART module (on both D0 and D1, or described as serial) cannot just move one pin: it needs SoftwareSerial.
    const uartParts = new Set(onSerial
      .filter((role) => /\b(uart|serial|rx|tx|rxd|txd)\b/i.test(role.purpose) || onSerial.some((other) => other.part === role.part && other.pin !== role.pin))
      .map((role) => role.part));
    const moves: string[] = [];
    const rewired = new Set<string>();
    for (const role of onSerial) {
      if (!uartParts.has(role.part)) moves.push(`move ${role.part} from ${role.pin} to ${nextFree()}`);
      else if (!rewired.has(role.part)) {
        rewired.add(role.part);
        moves.push(`use SoftwareSerial on two free pins (${nextFree()} and ${nextFree()}) for ${role.part} instead of D0/D1`);
      }
    }
    const fix = moves.join("; ");
    addFinding("SERIAL-USB", {
      severity: "warning",
      detail: `The sketch assigns ${serialPins.join(" and ")} to circuit roles while USB serial uses D0/D1.`,
      fix: `${fix.charAt(0).toUpperCase()}${fix.slice(1)}; D0/D1 carry uploads and USB serial.`,
      refs: { pins: serialPins.map((pin) => `board.${pin}`) },
    });
  }
  if (adcBad.length) addFinding("ADC-RANGE", { severity: "error", detail: `Analog role ${adcBad.join(", ")} is not guaranteed to stay between 0 V and the ADC reference.`, refs: { pins: adcBad.map((pin) => `board.${pin}`) } });

  const shortNets = [...nets.values()].filter((net) => net.has5V && net.hasGnd).map((net) => net.id);
  const buttonShorts = buttons.filter((button) => button.bridgesRails || (
    (button.switchedRail === "5V" && Boolean(button.inputNet && netHasRail(nets, button.inputNet, "GND")))
    || (button.switchedRail === "GND" && Boolean(button.inputNet && netHasRail(nets, button.inputNet, "5V")))
  ));
  if (shortNets.length || buttonShorts.length) {
    addFinding("SHORT-GRAPH", {
      severity: "error",
      detail: shortNets.length
        ? `Net ${shortNets.join(", ")} directly joins the 5 V and GND rails.`
        : `${buttonShorts.map((button) => button.button.id).join(", ")} can join 5 V to GND when pressed.`,
      refs: {
        parts: buttonShorts.map((button) => button.button.id),
        nets: [...shortNets, ...buttonShorts.map((button) => button.switchedNet).filter((net): net is string => Boolean(net))],
      },
    });
  }

  const railLoadMa = directRailLoadMa(circuit, nets, pinNets, resistors);
  let totalCurrentMa = railLoadMa;
  for (const current of currentByPin.values()) totalCurrentMa += current;
  for (const branch of buzzers) {
    if (branch.source && !currentByPin.has(branch.source.pin)) totalCurrentMa += branch.maxMa;
  }
  const plannedLoadMa = totalCurrentMa;
  // The ATmega328P's 200 mA VCC/GND limit covers current its I/O pins source; loads fed straight from the board's
  // 5 V header (rail LEDs, dividers, pots) bypass the chip and only count toward the USB fuse below.
  const mcuPins = [...currentByPin.entries()].filter(([pin]) => {
    const kind = boardPin(board, pin)?.kind;
    return kind === "digital" || kind === "analog";
  });
  const mcuCurrentMa = mcuPins.reduce((sum, [, current]) => sum + current, 0);
  const limits = board.limits;
  if (mcuCurrentMa > limits.vccGndTotalMa) {
    const perPin = mcuPins.length ? mcuCurrentMa / mcuPins.length : 0;
    const perPinBudget = Math.min(limits.pinDesignMa, limits.vccGndTotalMa / Math.max(1, mcuPins.length));
    addFinding("CUR-VCC-GND", {
      severity: "error",
      detail: `The Arduino pins together would source ${mcuCurrentMa.toFixed(2)} mA (${mcuPins.length} pins, about ${perPin.toFixed(1)} mA each at the conservative corner); the ATmega328P's VCC/GND limit is ${limits.vccGndTotalMa} mA.`,
      fix: `Keep each of the ${mcuPins.length} loads under about ${Math.floor(perPinBudget)} mA: for red/yellow LEDs use ${formatOhms(minSeriesOhmsFor(perPinBudget, 1.8, 5))} or more (blue/white: ${formatOhms(minSeriesOhmsFor(perPinBudget, 2.8, 5))}), or power the extra loads through transistors from the 5 V pin.`,
      refs: { pins: ["board.5V", "board.GND", ...mcuPins.map(([pin]) => `board.${pin}`)] },
    });
  }
  if (plannedLoadMa > limits.usbFuseMa * 0.8) {
    addFinding("PWR-USB-FUSE", {
      severity: plannedLoadMa > limits.usbFuseMa ? "error" : "warning",
      detail: `The planned USB 5 V load is ${plannedLoadMa.toFixed(2)} mA against a ${limits.usbFuseMa} mA fuse path (80% advisory threshold: ${limits.usbFuseMa * 0.8} mA).`,
      refs: { pins: ["board.5V"] },
    });
  }

  const flags: Record<string, boolean> = {};
  for (const rule of ELECTRICAL_RULES) flags[rule.fact] = findings.has(rule.ruleId);
  return {
    currentByPin,
    totalCurrentMa,
    plannedLoadMa,
    ledBranches: leds,
    buzzerBranches: buzzers,
    buttons,
    dividers,
    flags,
    findingData: findings,
    evidence: {
      totalCurrentMa: Number(totalCurrentMa.toFixed(3)),
      mcuCurrentMa: Number(mcuCurrentMa.toFixed(3)),
      plannedLoadMa: Number(plannedLoadMa.toFixed(3)),
      railLoadsMa: Number(railLoadMa.toFixed(3)),
      pinCurrentsMa: Object.fromEntries([...currentByPin.entries()].map(([pin, value]) => [pin, Number(value.toFixed(3))])),
      ledBranches: leds.map((branch) => ({
        part: branch.led.id,
        source: branch.source?.pin,
        resistorParts: branch.resistorPath.map((resistor) => resistor.part.id),
        maxMa: Number(branch.maxMa.toFixed(3)),
        typicalMa: Number(branch.typicalMa.toFixed(3)),
        brightMa: Number(branch.brightMa.toFixed(3)),
      })),
      buttons: buttons.map((button) => ({ part: button.button.id, inputPin: button.inputPin, switchedRail: button.switchedRail, bridgesRails: button.bridgesRails })),
      dividers: dividers.map((divider) => ({ inputPin: divider.inputPin, net: divider.net, parts: divider.parts, highRail: divider.highRail, lowRail: divider.lowRail })),
      nets: [...nets.values()].map((net) => ({ id: net.id, kind: net.kind, pins: net.refs.map((ref) => pinKey(ref)), boardPins: net.boardPins, has5V: net.has5V, hasGnd: net.hasGnd })),
    },
  };
}

/** One natural sentence under the verdict chip: the first problem by name, not a count the chip already shows. */
function summaryOf(consoleId: "EECOM" | "GUIDO", findings: Finding[]): string {
  const area = consoleId === "EECOM" ? "electrical" : "firmware";
  const errors = findings.filter((finding) => finding.severity === "error");
  const warnings = findings.filter((finding) => finding.severity === "warning");
  const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? "" : "s"}`;
  if (errors.length) {
    const also = warnings.length ? ` (and ${plural(warnings.length, "warning")})` : "";
    return `${plural(errors.length, "error")}${also}: ${errors[0]!.title}${errors.length > 1 ? ", and more" : ""}.`;
  }
  if (warnings.length) return `${plural(warnings.length, "warning")}: ${warnings[0]!.title}${warnings.length > 1 ? ", and more" : ""}.`;
  return `All ${area} checks pass.`;
}

function reportFromFindings(
  consoleId: "EECOM" | "GUIDO",
  revisionHash: string,
  findings: Finding[],
  evidence?: Record<string, unknown>,
): ConsoleReport {
  return {
    console: consoleId,
    verdict: verdictOf(findings),
    summary: summaryOf(consoleId, findings),
    findings,
    evidence,
    revisionHash,
    at: new Date().toISOString(),
  };
}

/** Run the data-driven ERC and conservative current checks for one circuit. */
export async function runElectricalChecks(circuit: Circuit, revisionHash: string): Promise<ConsoleReport> {
  const facts = electricalFacts(circuit);
  const engine = new Engine(electricalRuleProperties);
  for (const [fact, value] of Object.entries(facts.flags)) engine.addFact(fact, value);
  const result = await engine.run();
  const findings: Finding[] = [];
  for (const event of result.events) {
    const ruleId = typeof event.params?.ruleId === "string" ? event.params.ruleId : undefined;
    if (!ruleId) continue;
    const rule = ELECTRICAL_RULES.find((candidate) => candidate.ruleId === ruleId);
    const data = facts.findingData.get(ruleId);
    if (!rule || !data) continue;
    findings.push({
      console: "EECOM",
      ruleId,
      severity: data.severity,
      title: rule.title,
      detail: data.detail,
      fix: data.fix ?? rule.fix,
      refs: data.refs,
    });
  }
  findings.sort((a, b) => a.ruleId.localeCompare(b.ruleId));
  return reportFromFindings("EECOM", revisionHash, findings, facts.evidence);
}

interface CompileWarningCounts {
  sketch: number;
  other: number;
}

interface CompileFindingResult {
  findings: Finding[];
  warningCounts: CompileWarningCounts;
}

function isSketchDiagnostic(file: string | undefined): boolean {
  if (!file) return false;
  const normalized = file.replaceAll("\\", "/").toLowerCase();
  const basename = normalized.slice(normalized.lastIndexOf("/") + 1);
  if (/(^|\/)(?:cores|libraries|framework|toolchain)\//.test(normalized)) return false;
  return basename.endsWith(".ino") || basename === "sketch.cpp";
}

function compileFinding(compile: CompileResult): CompileFindingResult {
  const findings: Finding[] = [];
  const errors = compile.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  const warnings = compile.diagnostics.filter((diagnostic) => diagnostic.severity === "warning");
  const sketchWarnings = warnings.filter((diagnostic) => isSketchDiagnostic(diagnostic.file));
  if (!compile.ok || errors.length) {
    findings.push({
      console: "GUIDO",
      ruleId: "FW-COMPILE",
      severity: "error",
      title: "The Arduino sketch did not compile.",
      detail: errors.map((diagnostic) => diagnostic.message).join("; ") || compile.log,
      fix: "Fix the compiler errors, then compile again before flashing.",
    });
  }
  if (sketchWarnings.length) {
    findings.push({
      console: "GUIDO",
      ruleId: "FW-WARNING",
      severity: "warning",
      title: "The sketch compiler reported a warning.",
      detail: sketchWarnings.map((diagnostic) => diagnostic.message).join("; "),
      fix: "Review the warning in your sketch and remove it where practical.",
    });
  }
  return { findings, warningCounts: { sketch: sketchWarnings.length, other: warnings.length - sketchWarnings.length } };
}


/** Compare compile output and simulator-observed pin modes with the circuit IR. */
export function runFirmwareChecks(input: {
  circuit: Circuit;
  compile: CompileResult;
  pinModes: PinModeObservation[];
  revisionHash: string;
}): ConsoleReport {
  const compileReport = compileFinding(input.compile);
  const findings = compileReport.findings;
  const sizes = input.compile.sizes;
  if (sizes) {
    const flashRatio = sizes.flashBytes / Math.max(1, sizes.flashMax);
    const ramRatio = sizes.ramBytes / Math.max(1, sizes.ramMax);
    if (flashRatio > 0.8) findings.push({ console: "GUIDO", ruleId: "FW-FLASH", severity: flashRatio > 0.95 ? "error" : "warning", title: "The sketch is close to the board's flash limit.", detail: `Flash use is ${sizes.flashBytes}/${sizes.flashMax} bytes (${(flashRatio * 100).toFixed(1)}%).`, fix: "Remove unused code or data before adding more features." });
    if (ramRatio > 0.8) findings.push({ console: "GUIDO", ruleId: "FW-RAM", severity: ramRatio > 0.95 ? "error" : "warning", title: "The sketch is close to the board's RAM limit.", detail: `RAM use is ${sizes.ramBytes}/${sizes.ramMax} bytes (${(ramRatio * 100).toFixed(1)}%).`, fix: "Reduce global buffers and temporary strings before adding more features." });
  }
  const observed = new Map(input.pinModes.map((observation) => [observation.pin, observation]));
  const roles = new Map(input.circuit.roles.map((role) => [role.pin, role]));
  for (const role of input.circuit.roles) {
    const observation = observed.get(role.pin);
    if (!observation || observation.mode === "UNUSED") {
      findings.push({ console: "GUIDO", ruleId: "PIN-UNUSED-ROLE", severity: "warning", title: "A circuit role was never configured by the sketch.", detail: `${role.pin} is assigned to ${role.part} (${role.purpose}), but simulation never configured it.`, fix: `Configure ${role.pin} in setup() with the role's expected mode.`, refs: { parts: [role.part], pins: [`board.${role.pin}`] } });
      continue;
    }
    const expected = role.mode;
    const actual = observation.mode;
    // A PWM_OUT role driven as a plain OUTPUT is still the same push-pull driver on the same load: the Servo library
    // bit-bangs its pulse from a timer interrupt, and analogWrite(pin, 0 or 255) falls back to digitalWrite.
    const bothDriven = (expected === "OUTPUT" || expected === "PWM_OUT") && (actual === "OUTPUT" || actual === "PWM_OUT");
    const compatible = expected === actual || bothDriven;
    if (!compatible) {
      const pinArg = /^D\d+$/.test(role.pin) ? role.pin.slice(1) : role.pin;
      const fix = expected === "ANALOG_IN"
        ? `Read ${role.pin} with analogRead(${role.pin}) and remove any pinMode(${pinArg}, ${actual}) for it, or change the circuit role to ${actual}.`
        : `Call pinMode(${pinArg}, ${expected === "PWM_OUT" ? "OUTPUT" : expected}) in setup() instead of ${actual}, or change the circuit role to ${actual}.`;
      findings.push({ console: "GUIDO", ruleId: "PIN-MODE-MISMATCH", severity: "error", title: "The sketch's pin mode does not match the circuit role.", detail: `${role.pin} is declared ${expected} in the circuit but simulation observed ${actual}.`, fix, refs: { parts: [role.part], pins: [`board.${role.pin}`] } });
    }
  }
  for (const observation of input.pinModes) {
    if ((observation.mode === "OUTPUT" || observation.mode === "PWM_OUT") && !roles.has(observation.pin)) {
      findings.push({ console: "GUIDO", ruleId: "PIN-UNDECLARED-OUTPUT", severity: "error", title: "The sketch drives a pin that the circuit did not declare.", detail: `${observation.pin} became ${observation.mode} in simulation without a circuit role.`, fix: "Add the pin and its load to the circuit roles, or stop driving that pin.", refs: { pins: [`board.${observation.pin}`] } });
    }
  }
  findings.sort((a, b) => a.ruleId.localeCompare(b.ruleId) || (a.refs?.pins?.[0] ?? "").localeCompare(b.refs?.pins?.[0] ?? ""));
  const compilerWarnings = {
    sketchWarnings: compileReport.warningCounts.sketch,
    otherWarnings: compileReport.warningCounts.other,
  };
  const evidence = sizes
    ? { flashBytes: sizes.flashBytes, flashMax: sizes.flashMax, ramBytes: sizes.ramBytes, ramMax: sizes.ramMax, observedPinModes: input.pinModes, compilerWarnings }
    : { observedPinModes: input.pinModes, compilerWarnings };
  return reportFromFindings("GUIDO", input.revisionHash, findings, evidence);
}

interface SpiceDiodeModel {
  is: string;
  n: number;
  rs: number;
}

type SpiceModelCorner = "min" | "typ" | "max";

/**
 * Fixed per-color/per-corner diode models. Is/N/Rs were chosen once at 27 C
 * so each model's 20 mA forward voltage matches the corresponding
 * MODULES.led.electrical.vf corner; none is fitted to the circuit under test.
 */
const SPICE_MODELS: Record<string, Record<SpiceModelCorner, SpiceDiodeModel>> = {
  red: {
    min: { is: "7.254071e-16", n: 2, rs: 10 },
    typ: { is: "1.515395e-17", n: 2, rs: 10 },
    max: { is: "3.165700e-19", n: 2, rs: 10 },
  },
  yellow: {
    min: { is: "1.048465e-16", n: 2, rs: 10 },
    typ: { is: "2.190271e-18", n: 2, rs: 10 },
    max: { is: "6.613232e-21", n: 2, rs: 10 },
  },
  green: {
    min: { is: "1.048465e-16", n: 2, rs: 10 },
    typ: { is: "3.165700e-19", n: 2, rs: 10 },
    max: { is: "1.259475e-27", n: 2, rs: 10 },
  },
  blue: {
    min: { is: "2.886036e-24", n: 2, rs: 10 },
    typ: { is: "8.714002e-27", n: 2, rs: 10 },
    max: { is: "2.631077e-29", n: 2, rs: 10 },
  },
  white: {
    min: { is: "2.886036e-24", n: 2, rs: 10 },
    typ: { is: "8.714002e-27", n: 2, rs: 10 },
    max: { is: "2.631077e-29", n: 2, rs: 10 },
  },
  orange: {
    min: { is: "7.254071e-16", n: 2, rs: 10 },
    typ: { is: "1.515395e-17", n: 2, rs: 10 },
    max: { is: "3.165700e-19", n: 2, rs: 10 },
  },
  pink: {
    min: { is: "7.254071e-16", n: 2, rs: 10 },
    typ: { is: "3.165700e-19", n: 2, rs: 10 },
    max: { is: "1.381522e-22", n: 2, rs: 10 },
  },
  purple: {
    min: { is: "6.613232e-21", n: 2, rs: 10 },
    typ: { is: "6.029005e-26", n: 2, rs: 10 },
    max: { is: "2.631077e-29", n: 2, rs: 10 },
  },
  "warm-white": {
    min: { is: "2.886036e-24", n: 2, rs: 10 },
    typ: { is: "8.714002e-27", n: 2, rs: 10 },
    max: { is: "2.631077e-29", n: 2, rs: 10 },
  },
};

function spiceModelFromVf(vf: number): SpiceDiodeModel {
  const n = 2;
  const rs = 10;
  const thermalV = 0.02585;
  const is = 0.02 / (Math.exp((vf - 0.02 * rs) / (n * thermalV)) - 1);
  return { is: is.toExponential(6), n, rs };
}

function spiceModel(color: string, corner: SpiceModelCorner, vf: LedVf, useFixedModel: boolean): SpiceDiodeModel {
  return useFixedModel && SPICE_MODELS[color] ? SPICE_MODELS[color][corner] : spiceModelFromVf(vf[corner]);
}

function spiceDeck(color: string, corner: SpiceModelCorner, resistance: number, volts: number, vf: LedVf, useFixedModel: boolean): string {
  const model = spiceModel(color, corner, vf, useFixedModel);
  return `* ViBread server-owned LED branch cross-check
VVB source 0 ${volts}
RLED source led ${resistance}
DLED led 0 D_${color}
.model D_${color} D(Is=${model.is} N=${model.n} Rs=${model.rs})
.control
set noaskquit
set filetype=ascii
op
print vvb#branch
.endc
.end
`;
}

function parseSpiceCurrent(output: string): number | undefined {
  const match = output.match(/(?:vvb#branch|i\(vvb\)|i\(vvb\))\s*[=:]\s*([-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)/i);
  if (!match) return undefined;
  const amps = Number(match[1]);
  return Number.isFinite(amps) ? Math.abs(amps) * 1_000 : undefined;
}

function runNgspice(deckPath: string, cwd: string, rawPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("ngspice", ["-b", "-r", rawPath, deckPath], { cwd });
    let output = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`ngspice timed out after ${SPICE_TIMEOUT_MS} ms`));
    }, SPICE_TIMEOUT_MS);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { output += chunk; });
    child.stderr.on("data", (chunk: string) => { output += chunk; });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`ngspice exited with code ${code}: ${output.slice(-2_000)}`));
      else resolve(output);
    });
  });
}

interface SpiceBranch {
  part: Part;
  color: string;
  vf: LedVf;
  useFixedModel: boolean;
  resistance: number;
  minResistance: number;
  maxResistance: number;
  analyticMa: number;
  analyticMaxMa: number;
  analyticMinMa: number;
}

export interface SpiceCrossCheckOptions {
  /** Test seam for auditing a deliberately wrong analytic Vf assumption. */
  analyticVf?: Record<string, number>;
}

type SpiceCornerName = "nominal" | "maximum" | "minimum";

function spiceBranches(circuit: Circuit, options: SpiceCrossCheckOptions): SpiceBranch[] {
  const { nets, pinNets } = makeNets(circuit);
  const { sources } = makeSources(circuit, nets);
  const resistors = circuit.parts.filter((part) => part.module === "resistor").map((part) => resistorInfo(part, pinNets));
  const branches: SpiceBranch[] = [];
  for (const led of circuit.parts.filter((part) => part.module === "led")) {
    const anode = partPinNet(pinNets, led.id, "A");
    const cathode = partPinNet(pinNets, led.id, "K");
    const sourcePath = sources.map((candidate) => ({
      path: mergeResistorPaths(
        resistorPath(candidate.net, anode, resistors),
        resistorPathToRail(nets, cathode, "GND", resistors),
      ),
    })).find((entry) => entry.path?.length);
    if (!sourcePath?.path) continue;
    const path = sourcePath.path;
    const color = typeof led.params.color === "string" ? led.params.color : "red";
    const vfCorners = ledVf(led.params);
    const nominalVf = options.analyticVf?.[color] ?? vfCorners.typ;
    const maximumCurrentVf = options.analyticVf?.[color] ?? vfCorners.min;
    const minimumCurrentVf = options.analyticVf?.[color] ?? vfCorners.max;
    const resistance = sumResistance(path);
    const minimumResistance = minResistance(path);
    const maximumResistance = maxResistance(path);
    branches.push({
      part: led,
      color,
      vf: vfCorners,
      useFixedModel: !Object.hasOwn(led.params, "vf"),
      resistance,
      minResistance: minimumResistance,
      maxResistance: maximumResistance,
      analyticMa: currentMa(5, nominalVf, resistance),
      analyticMaxMa: currentMa(VCC_MAX, maximumCurrentVf, minimumResistance),
      analyticMinMa: currentMa(VCC_MIN, minimumCurrentVf, maximumResistance + BOARD_PROFILES[circuit.board.profile].driverOhms.effective),
    });
  }
  return branches;
}

function missingNgspice(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  return error.code === "ENOENT";
}

/** Cross-check every forward-biased LED branch against bounded ngspice corner runs. */
export async function spiceCrossCheck(circuit: Circuit, options: SpiceCrossCheckOptions = {}): Promise<{
  ok: boolean;
  findings: Finding[];
  rows: {
    part: string;
    analyticMa: number;
    spiceMa: number;
    analyticMaxMa: number;
    spiceMaxMa: number;
    analyticMinMa: number;
    spiceMinMa: number;
  }[];
}> {
  const branches = spiceBranches(circuit, options);
  if (!branches.length) return { ok: true, findings: [], rows: [] };
  const work = await mkdtemp(join(tmpdir(), "vibread-spice-"));
  const findings: Finding[] = [];
  const rows: {
    part: string;
    analyticMa: number;
    spiceMa: number;
    analyticMaxMa: number;
    spiceMaxMa: number;
    analyticMinMa: number;
    spiceMinMa: number;
  }[] = [];
  try {
    for (const branch of branches) {
      const corners: { name: SpiceCornerName; model: SpiceModelCorner; volts: number; resistance: number; analyticMa: number }[] = [
        { name: "nominal", model: "typ", volts: 5, resistance: branch.resistance, analyticMa: branch.analyticMa },
        { name: "maximum", model: "min", volts: VCC_MAX, resistance: branch.minResistance, analyticMa: branch.analyticMaxMa },
        { name: "minimum", model: "max", volts: VCC_MIN, resistance: branch.maxResistance + BOARD_PROFILES[circuit.board.profile].driverOhms.effective, analyticMa: branch.analyticMinMa },
      ];
      const measured: Partial<Record<SpiceCornerName, number>> = {};
      let branchFailed = false;
      for (const corner of corners) {
        const deckPath = join(work, `${branch.part.id}-${corner.name}.cir`);
        const rawPath = join(work, `${branch.part.id}-${corner.name}.raw`);
        await writeFile(deckPath, spiceDeck(branch.color, corner.model, corner.resistance, corner.volts, branch.vf, branch.useFixedModel), "utf8");
        try {
          const output = await runNgspice(deckPath, work, rawPath);
          const spiceMa = parseSpiceCurrent(output);
          if (spiceMa === undefined) throw new Error(`could not parse source current from ngspice output: ${output.slice(-1_000)}`);
          measured[corner.name] = spiceMa;
        } catch (error) {
          branchFailed = true;
          const unavailable = missingNgspice(error);
          findings.push({
            console: "EECOM",
            ruleId: unavailable ? "SPICE-UNAVAILABLE" : "SPICE-RUN",
            severity: unavailable ? "info" : "error",
            title: unavailable ? "The optional SPICE cross-check is unavailable." : "The SPICE cross-check could not run this LED branch.",
            detail: error instanceof Error ? error.message : String(error),
            fix: unavailable ? "Install ngspice to add independent current evidence; electrical checks still use the analytic limits." : "Check that the generated branch has a valid ngspice operating point.",
            refs: { parts: [branch.part.id] },
          });
          break;
        }
      }
      const nominal = measured.nominal;
      const maximum = measured.maximum;
      const minimum = measured.minimum;
      if (branchFailed || nominal === undefined || maximum === undefined || minimum === undefined) continue;
      rows.push({
        part: branch.part.id,
        analyticMa: Number(branch.analyticMa.toFixed(3)),
        spiceMa: Number(nominal.toFixed(3)),
        analyticMaxMa: Number(branch.analyticMaxMa.toFixed(3)),
        spiceMaxMa: Number(maximum.toFixed(3)),
        analyticMinMa: Number(branch.analyticMinMa.toFixed(3)),
        spiceMinMa: Number(minimum.toFixed(3)),
      });
      for (const corner of corners) {
        const spiceMa = measured[corner.name];
        if (spiceMa === undefined) continue;
        const deviation = Math.abs(spiceMa - corner.analyticMa) / Math.max(corner.analyticMa, 0.001);
        // Below the 5 mA visibility floor, the LED-DIM rule is the actionable signal;
        // avoid a duplicate model-spread warning for that already-dim corner.
        const lowCurrentCorner = corner.name === "minimum" && corner.analyticMa < SPICE_LOW_CURRENT_FLOOR_MA;
        if (deviation > 0.2 && !lowCurrentCorner) {
          findings.push({
            console: "EECOM",
            ruleId: "SPICE-DEVIATION",
            severity: "warning",
            title: "The analytic LED current differs from ngspice by more than 20%.",
            detail: `${branch.part.id} ${corner.name} corner: analytic ${corner.analyticMa.toFixed(2)} mA versus ngspice ${spiceMa.toFixed(2)} mA (${(deviation * 100).toFixed(1)}% apart).`,
            fix: "Review the LED model, resistor value, and voltage/current corner assumptions.",
            refs: { parts: [branch.part.id] },
          });
        }
      }
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  return { ok: findings.every((finding) => finding.severity !== "error"), findings, rows };
}
