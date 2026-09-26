import {
  AVRADC,
  AVRIOPort,
  AVRUSART,
  AVRTimer,
  CPU,
  PinState,
  adcConfig,
  avrInstruction,
  portBConfig,
  portCConfig,
  portDConfig,
  timer0Config,
  timer1Config,
  timer2Config,
  usart0Config,
  type AVRPortConfig,
} from "avr8js";
import { parseIntelHex } from "webserial-flasher";
import {
  BOARD_PROFILES,
  MODULES,
  ledVf,
  photoresistorOhms,
  type BoardPin,
  type Circuit,
  type Part,
  type PinMode,
  type PinRef,
  type Scenario,
  type ScenarioStep,
  type TestSuite,
  type Trace,
  type TraceFrame,
  type PinModeObservation,
  type ScenarioResult,
  type Coverage,
  type SimRunResult,
  type ConsoleReport,
  type Finding,
} from "@vibread/core";

const CLOCK_HZ = 16_000_000;
const TRACE_PERIOD_MS = 20;
const LED_LIT_THRESHOLD = 0.02;
const PULLUP_OHMS = 35_000;
const DRIVER_OHMS = 45;
const MAX_SCENARIO_STEPS = 1_000_000;

type Logic = 0 | 1;
type VoltageMap = Map<string, number>;
type PinStateMap = Map<string, Logic>;

type PortName = "B" | "C" | "D";
export interface ScenarioExecution {
  result: ScenarioResult;
  trace: Trace;
  pinModes: PinModeObservation[];
}

interface Dsu {
  parent: Map<string, string>;
}

interface Branch {
  a: string;
  b: string;
  ohms: number;
  vf?: number;
}

interface DiodeBranch {
  branch: Branch;
  vf: number;
  on: boolean;
}

interface SensorValues {
  digital: Map<string, boolean>;
  light: Map<string, number>;
  analog: Map<string, number>;
}

interface PartReading {
  value: number;
  on: boolean;
}

interface PinMapping {
  pin: BoardPin;
  port: AVRIOPort;
  bit: number;
}

interface ModeState {
  mode: PinMode | "UNUSED";
  toggled: boolean;
  firstMs?: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function isFinitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function dsuMake(): Dsu {
  return { parent: new Map() };
}

function dsuAdd(dsu: Dsu, value: string): void {
  if (!dsu.parent.has(value)) dsu.parent.set(value, value);
}

function dsuFind(dsu: Dsu, value: string): string {
  dsuAdd(dsu, value);
  const parent = dsu.parent.get(value) as string;
  if (parent === value) return value;
  const root = dsuFind(dsu, parent);
  dsu.parent.set(value, root);
  return root;
}

function dsuUnion(dsu: Dsu, a: string, b: string): void {
  const rootA = dsuFind(dsu, a);
  const rootB = dsuFind(dsu, b);
  if (rootA !== rootB) dsu.parent.set(rootA, rootB);
}

function pinId(ref: PinRef): string {
  return `${ref.part}.${ref.pin}`;
}

function parseProgram(hex: string): Uint16Array {
  const parsed = parseIntelHex(hex);
  const wordCount = Math.max(0x4000, Math.ceil(parsed.data.length / 2));
  const words = new Uint16Array(wordCount);
  words.fill(0xffff);
  for (let index = 0; index < parsed.data.length; index += 1) {
    const word = index >> 1;
    if ((index & 1) === 0) words[word] = parsed.data[index];
    else words[word] |= parsed.data[index] << 8;
  }
  return words;
}

function portConfig(port: PortName): AVRPortConfig {
  if (port === "B") return portBConfig;
  if (port === "C") return portCConfig;
  return portDConfig;
}

function modeFromRegisters(
  pin: BoardPin,
  cpu: CPU,
  timerPwm: boolean,
  analogExpected: boolean,
): PinMode | "UNUSED" {
  if (!pin.port || pin.bit === undefined || !pin.digital) return "UNUSED";
  const config = portConfig(pin.port);
  const ddr = cpu.data[config.DDR];
  const port = cpu.data[config.PORT];
  const mask = 1 << pin.bit;
  if (ddr & mask) return timerPwm ? "PWM_OUT" : "OUTPUT";
  if (port & mask) return "INPUT_PULLUP";
  if (pin.adc !== undefined && analogExpected) return "ANALOG_IN";
  return "INPUT";
}

function addFixedNode(dsu: Dsu, netId: string, voltage: number, fixed: Map<string, number>): void {
  const root = dsuFind(dsu, netId);
  fixed.set(root, voltage);
}

function solveNodes(
  nodes: string[],
  fixed: Map<string, number>,
  branches: Branch[],
  sources: { node: string; voltage: number; ohms: number }[],
): VoltageMap {
  const values: VoltageMap = new Map();
  for (const node of nodes) values.set(node, fixed.get(node) ?? 2.5);
  const allBranches = branches.filter((branch) => isFinitePositive(branch.ohms));
  for (let iteration = 0; iteration < 30; iteration += 1) {
    let maxDelta = 0;
    for (const node of nodes) {
      const fixedVoltage = fixed.get(node);
      if (fixedVoltage !== undefined) {
        values.set(node, fixedVoltage);
        continue;
      }
      let numerator = 0;
      let denominator = 0;
      for (const branch of allBranches) {
        if (branch.a !== node && branch.b !== node) continue;
        const other = branch.a === node ? branch.b : branch.a;
        const conductance = 1 / branch.ohms;
        const vf = branch.vf ?? 0;
        const signedVf = branch.a === node ? vf : -vf;
        numerator += conductance * ((values.get(other) ?? 0) + signedVf);
        denominator += conductance;
      }
      for (const source of sources) {
        if (source.node !== node || !isFinitePositive(source.ohms)) continue;
        const conductance = 1 / source.ohms;
        numerator += conductance * source.voltage;
        denominator += conductance;
      }
      if (denominator > 0) {
        const next = clamp(numerator / denominator, 0, 5);
        maxDelta = Math.max(maxDelta, Math.abs(next - (values.get(node) ?? 0)));
        values.set(node, next);
      }
    }
    if (maxDelta < 1e-5) break;
  }
  return values;
}

/**
 * Instruction-level ATmega328P simulation plus the small, deterministic protocol-level
 * device model used by the scenario runner. The class intentionally keeps all browser-safe
 * code in this module; worker_threads is only imported by pool.ts.
 */
export class SimMachine {
  readonly circuit: Circuit;
  readonly profile: (typeof BOARD_PROFILES)[keyof typeof BOARD_PROFILES];
  readonly cpu: CPU;
  readonly ports: Record<PortName, AVRIOPort>;
  readonly adc: AVRADC;
  readonly usart: AVRUSART;
  readonly timers: [AVRTimer, AVRTimer, AVRTimer];
  readonly sensors: SensorValues = {
    digital: new Map(),
    light: new Map(),
    analog: new Map(),
  };
  readonly serial: string[] = [];
  private readonly serialListeners: Array<(text: string) => void> = [];
  readonly trace: Trace = { scenario: "", frames: [] };

  private readonly boardPins = new Map<string, PinMapping>();
  private readonly pinToNode = new Map<string, string>();
  private readonly netToNode = new Map<string, string>();
  private readonly nodeFixed = new Map<string, number>();
  private readonly nodes: string[] = [];
  private readonly partsById = new Map<string, Part>();
  private readonly modeStates = new Map<string, ModeState>();
  private readonly outputValues: PinStateMap = new Map();
  private readonly lastPinStates = new Map<string, boolean>();
  private readonly pinSegments = new Map<string, Array<{ start: number; end: number; on: boolean }>>();
  private readonly partSegments = new Map<string, Array<{ start: number; end: number; on: boolean }>>();
  private readonly partValueSegments = new Map<string, Array<{ start: number; end: number; value: number }>>();
  private readonly toneRises = new Map<string, number[]>();
  private readonly partReadings = new Map<string, PartReading>();
  private readonly inputValues = new Map<string, Logic>();
  private readonly voltages: VoltageMap = new Map();
  private readonly portListeners: Array<() => void> = [];
  private readonly rxQueue: number[] = [];
  private physicalPinSyncPending = false;
  private lastAccountingCycle = 0;
  private nextTraceCycle = Math.round((TRACE_PERIOD_MS / 1000) * CLOCK_HZ);
  private nextModeCycle = 0;
  private readonly roleByPin = new Map<string, { mode: PinMode; part: string }>();


  constructor(hex: string, circuit: Circuit, opts: { light?: Record<string, number>; analog?: Record<string, number>; digital?: Record<string, boolean> } = {}) {
    this.circuit = circuit;
    this.profile = BOARD_PROFILES[circuit.board.profile];
    for (const part of circuit.parts) this.partsById.set(part.id, part);
    for (const [part, value] of Object.entries(opts.light ?? {})) this.sensors.light.set(part, clamp(value, 0, 1));
    for (const [part, value] of Object.entries(opts.analog ?? {})) this.sensors.analog.set(part, clamp(value, 0, 1));
    for (const [part, value] of Object.entries(opts.digital ?? {})) this.sensors.digital.set(part, value);
    for (const part of circuit.parts) {
      if (part.module === "photoresistor" && !this.sensors.light.has(part.id)) this.sensors.light.set(part.id, 0.8);
      if (part.module === "potentiometer" && !this.sensors.analog.has(part.id)) this.sensors.analog.set(part.id, 0);
      if ((part.module === "button" || part.module === "generic") && !this.sensors.digital.has(part.id)) this.sensors.digital.set(part.id, false);
      this.partReadings.set(part.id, { value: this.defaultPartValue(part), on: false });
      this.pinSegments.set(part.id, []);
      this.partSegments.set(part.id, []);
      this.partValueSegments.set(part.id, []);
      this.toneRises.set(part.id, []);
    }

    this.cpu = new CPU(parseProgram(hex));
    const portB = new AVRIOPort(this.cpu, portBConfig);
    const portC = new AVRIOPort(this.cpu, portCConfig);
    const portD = new AVRIOPort(this.cpu, portDConfig);
    this.ports = { B: portB, C: portC, D: portD };
    this.timers = [new AVRTimer(this.cpu, timer0Config), new AVRTimer(this.cpu, timer1Config), new AVRTimer(this.cpu, timer2Config)];
    this.adc = new AVRADC(this.cpu, adcConfig);
    this.adc.avcc = this.profile.vcc;
    this.adc.aref = this.profile.vcc;
    this.usart = new AVRUSART(this.cpu, usart0Config, this.profile.clockHz);
    this.usart.onByteTransmit = (value) => {
      const text = String.fromCharCode(value);
      this.serial.push(text);
      for (const listener of this.serialListeners) listener(text);
    };

    this.buildCircuitIndex();
    this.buildBoardIndex();
    for (const port of Object.values(this.ports)) {
      const listener = () => {
        this.physicalPinSyncPending = true;
        this.accountTo(this.cpu.cycles);
        this.updateCircuit();
        this.captureTrace(true);
      };
      port.addListener(listener);
      this.portListeners.push(() => port.removeListener(listener));
    }
    this.updateCircuit();
    this.captureTrace(true);
  }

  get timeMs(): number {
    return (this.cpu.cycles * 1000) / this.profile.clockHz;
  }

  get currentCycle(): number {
    return this.cpu.cycles;
  }

  get partValues(): ReadonlyMap<string, number> {
    return this.partReadingsAsMap();
  }

  setDigital(part: string, value: boolean): void {
    this.sensors.digital.set(part, value);
    this.accountTo(this.cpu.cycles);
    this.updateCircuit();
    this.captureTrace(true);
  }

  setLight(part: string, level: number): void {
    this.sensors.light.set(part, clamp(level, 0, 1));
    this.accountTo(this.cpu.cycles);
    this.updateCircuit();
    this.captureTrace(true);
  }

  setAnalog(part: string, value: number): void {
    this.sensors.analog.set(part, clamp(value, 0, 1));
    this.accountTo(this.cpu.cycles);
    this.updateCircuit();
    this.captureTrace(true);
  }

  serialWrite(text: string): void {
    for (const char of text) this.rxQueue.push(char.charCodeAt(0));
    this.pumpRx();
  }
  onSerial(listener: (text: string) => void): () => void {
    this.serialListeners.push(listener);
    return () => {
      const index = this.serialListeners.indexOf(listener);
      if (index >= 0) this.serialListeners.splice(index, 1);
    };
  }

  run(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) throw new RangeError("simulation duration must be a non-negative finite number");
    const target = this.cpu.cycles + Math.max(0, Math.round(ms * this.profile.clockHz / 1000));
    const initialCycle = this.cpu.cycles;
    let guard = 0;
    while (this.cpu.cycles < target) {
      avrInstruction(this.cpu);
      this.cpu.tick();
      this.pumpRx();
      if (this.physicalPinSyncPending) {
        this.syncPhysicalPinRegisters();
        this.physicalPinSyncPending = false;
      }
      this.captureTraceIfDue();
      this.observeModesIfDue();
      guard += 1;
      if (guard > target - initialCycle + 1) throw new Error("simulation instruction budget exceeded");
    }
    this.accountTo(this.cpu.cycles);
    this.captureTraceIfDue(true);
  }

  pinLevel(pin: string): Logic | null {
    const mapping = this.boardPins.get(pin);
    if (!mapping) return null;
    const config = portConfig(mapping.pin.port as PortName);
    const mask = 1 << mapping.bit;
    if (this.cpu.data[config.DDR] & mask) {
      const node = this.boardNode(mapping.pin);
      if (node && this.voltages.has(node)) return (this.voltages.get(node) ?? 0) >= this.profile.logic.vihMin ? 1 : 0;
      const state = mapping.port.pinState(mapping.bit);
      return state === PinState.High ? 1 : 0;
    }
    const state = mapping.port.pinState(mapping.bit);
    if (state === PinState.High) return 1;
    if (state === PinState.Low) return 0;
    return null;
  }

  partState(part: string): number {
    this.accountTo(this.cpu.cycles);
    const windowStart = Math.max(0, this.cpu.cycles - Math.round((TRACE_PERIOD_MS / 1000) * CLOCK_HZ));
    const definition = this.partsById.get(part);
    if (definition?.module === "led") {
      const segments = this.partSegments.get(part) ?? [];
      let litCycles = 0;
      let duration = 0;
      for (const segment of segments) {
        const overlapStart = Math.max(windowStart, segment.start);
        const overlapEnd = Math.min(this.cpu.cycles, segment.end);
        if (overlapEnd > overlapStart) {
          if (segment.on) litCycles += overlapEnd - overlapStart;
          duration += overlapEnd - overlapStart;
        }
      }
      if (duration > 0) return litCycles / duration;
      return this.partReadings.get(part)?.on ? 1 : 0;
    }
    const segments = this.partValueSegments.get(part) ?? [];
    let weighted = 0;
    let duration = 0;
    for (const segment of segments) {
      const overlapStart = Math.max(windowStart, segment.start);
      const overlapEnd = Math.min(this.cpu.cycles, segment.end);
      if (overlapEnd > overlapStart) {
        weighted += segment.value * (overlapEnd - overlapStart);
        duration += overlapEnd - overlapStart;
      }
    }
    if (duration > 0) return weighted / duration;
    return this.partReadings.get(part)?.value ?? 0;
  }

  serialText(): string {
    return this.serial.join("");
  }

  serialContains(text: string): boolean {
    return this.serialText().includes(text);
  }

  pinHighFraction(pin: string, startCycle: number): number {
    this.accountTo(this.cpu.cycles);
    const elapsed = this.cpu.cycles - startCycle;
    if (elapsed <= 0) return 0;
    const segments = this.pinSegments.get(pin) ?? [];
    let onCycles = 0;
    for (const segment of segments) {
      const overlapStart = Math.max(startCycle, segment.start);
      const overlapEnd = Math.min(this.cpu.cycles, segment.end);
      if (segment.on && overlapEnd > overlapStart) onCycles += overlapEnd - overlapStart;
    }
    return clamp(onCycles / elapsed, 0, 1);
  }

  partOnFraction(part: string, startCycle: number): number {
    this.accountTo(this.cpu.cycles);
    const elapsed = this.cpu.cycles - startCycle;
    if (elapsed <= 0) return 0;
    const segments = this.partSegments.get(part) ?? [];
    let onCycles = 0;
    for (const segment of segments) {
      const overlapStart = Math.max(startCycle, segment.start);
      const overlapEnd = Math.min(this.cpu.cycles, segment.end);
      if (segment.on && overlapEnd > overlapStart) onCycles += overlapEnd - overlapStart;
    }
    return clamp(onCycles / elapsed, 0, 1);
  }

  toneFrequency(part: string, startCycle: number): number {
    const elapsed = this.cpu.cycles - startCycle;
    if (elapsed <= 0) return 0;
    const rises = this.toneRises.get(part) ?? [];
    let count = 0;
    for (const cycle of rises) if (cycle >= startCycle && cycle <= this.cpu.cycles) count += 1;
    return Math.max(0, (count * this.profile.clockHz) / elapsed);
  }

  /**
   * Live pitch of a tone() output (passive buzzer / generic): Hz from the spacing of the rising edges in the last
   * `windowMs`, 0 once the edges stop for three periods (noTone(), tone() duration over). Scans from the newest edge.
   */
  recentToneFrequency(part: string, windowMs: number): number {
    const rises = this.toneRises.get(part) ?? [];
    const now = this.cpu.cycles;
    const start = now - Math.round((windowMs / 1000) * this.profile.clockHz);
    let first = -1;
    let count = 0;
    for (let i = rises.length - 1; i >= 0 && rises[i] >= start; i -= 1) {
      first = rises[i];
      count += 1;
    }
    if (count < 2) return 0;
    const last = rises[rises.length - 1];
    const period = (last - first) / (count - 1);
    return period > 0 && now - last <= 3 * period ? this.profile.clockHz / period : 0;
  }

  pinModes(): PinModeObservation[] {
    this.observeModesIfDue(true);
    return [...this.modeStates.entries()]
      .filter(([pin]) => this.roleByPin.has(pin) || this.boardPins.has(pin))
      .map(([pin, state]) => ({ pin, mode: state.mode, toggled: state.toggled, ...(state.firstMs === undefined ? {} : { firstMs: state.firstMs }) }))
      .sort((a, b) => a.pin.localeCompare(b.pin, undefined, { numeric: true }));
  }

  finishTrace(scenario: string): Trace {
    this.accountTo(this.cpu.cycles);
    this.captureTrace(true);
    this.trace.scenario = scenario;
    return { scenario, frames: this.trace.frames.map((frame) => ({ t: frame.t, parts: { ...frame.parts }, pins: { ...frame.pins } })) };
  }

  private readonly defaultPartValue = (part: Part): number => {
    if (part.module === "photoresistor") return this.sensors.light.get(part.id) ?? 0.8;
    if (part.module === "potentiometer") return this.sensors.analog.get(part.id) ?? 0;
    if (part.module === "button") return this.sensors.digital.get(part.id) ? 1 : 0;
    return 0;
  };

  private partReadingsAsMap(): Map<string, number> {
    const values = new Map<string, number>();
    for (const [part, reading] of this.partReadings) values.set(part, reading.value);
    return values;
  }

  private buildCircuitIndex(): void {
    const dsu = dsuMake();
    for (const net of this.circuit.nets) {
      dsuAdd(dsu, `net:${net.id}`);
      for (const ref of net.pins) {
        const key = pinId(ref);
        this.pinToNode.set(key, `net:${net.id}`);
        dsuAdd(dsu, key);
        dsuUnion(dsu, key, `net:${net.id}`);
      }
    }
    for (const part of this.circuit.parts) {
      const pins = MODULES[part.module]?.pins ?? part.pinout ?? [];
      for (const pin of pins) {
        const key = `${part.id}.${pin.id}`;
        dsuAdd(dsu, key);
        if (!this.pinToNode.has(key)) this.pinToNode.set(key, key);
      }
      const internals = MODULES[part.module]?.internallyConnected ?? [];
      for (const group of internals) {
        for (let index = 1; index < group.length; index += 1) dsuUnion(dsu, `${part.id}.${group[0]}`, `${part.id}.${group[index]}`);
      }
    }
    const roots = new Map<string, string>();
    for (const key of dsu.parent.keys()) {
      const root = dsuFind(dsu, key);
      if (!roots.has(root)) roots.set(root, `node:${roots.size}`);
      const node = roots.get(root) as string;
      if (key.startsWith("net:")) this.netToNode.set(key.slice(4), node);
      else if (key.includes(".")) this.pinToNode.set(key, node);
    }
    for (const node of roots.values()) this.nodes.push(node);
    for (const net of this.circuit.nets) {
      const node = this.netToNode.get(net.id);
      if (!node) continue;
      if (net.kind === "ground") this.nodeFixed.set(node, 0);
      if (net.kind === "power") {
        const boardPower = net.pins.find((pin) => pin.part === "board");
        const boardPin = boardPower ? this.profile.pins.find((pin) => pin.name === boardPower.pin) : undefined;
        this.nodeFixed.set(node, boardPin?.volts ?? 5);
      }
    }
  }

  private buildBoardIndex(): void {
    for (const pin of this.profile.pins) {
      if (!pin.port || pin.bit === undefined) continue;
      const mapping = { pin, port: this.ports[pin.port], bit: pin.bit };
      this.boardPins.set(pin.name, mapping);
      this.lastPinStates.set(pin.name, mapping.port.pinState(mapping.bit) === PinState.High);
    }
    for (const role of this.circuit.roles) {
      this.roleByPin.set(role.pin, { mode: role.mode, part: role.part });
    }
    for (const pin of this.profile.pins) {
      this.modeStates.set(pin.name, { mode: this.roleByPin.has(pin.name) ? "INPUT" : "UNUSED", toggled: false });
    }
  }

  private boardNode(pin: BoardPin): string | undefined {
    return this.pinToNode.get(`board.${pin.name}`);
  }

  private timerPwmActive(pin: BoardPin): boolean {
    if (!pin.pwm || !pin.port || pin.bit === undefined) return false;
    // ATmega328P OC mappings: D3=OC2B, D5=OC0B, D6=OC0A, D9=OC1A, D10=OC1B, D11=OC2A.
    const timerConfig = pin.name === "D3" || pin.name === "D11" ? this.cpu.data[timer2Config.TCCRA] : pin.name === "D5" || pin.name === "D6" ? this.cpu.data[timer0Config.TCCRA] : this.cpu.data[timer1Config.TCCRA];
    const com = pin.name === "D3" || pin.name === "D5" || pin.name === "D10" ? (timerConfig >> 4) & 0x3 : (timerConfig >> 6) & 0x3;
    return com !== 0;
  }

  private observeModesIfDue(force = false): void {
    if (!force && this.cpu.cycles < this.nextModeCycle) return;
    for (const [name, mapping] of this.boardPins) {
      const previous = this.modeStates.get(name);
      const mode = modeFromRegisters(mapping.pin, this.cpu, this.timerPwmActive(mapping.pin), this.roleByPin.get(name)?.mode === "ANALOG_IN");
      const used = this.roleByPin.has(name);
      const actual: PinMode | "UNUSED" = used ? mode : mode === "OUTPUT" || mode === "PWM_OUT" || mode === "INPUT_PULLUP" ? mode : "UNUSED";
      const currentLevel = this.pinLevel(name);
      const toggled = Boolean(previous?.toggled || (previous && currentLevel !== null && this.outputValues.get(name) !== undefined && currentLevel !== this.outputValues.get(name)));
      if (currentLevel !== null) this.outputValues.set(name, currentLevel);
      this.modeStates.set(name, {
        mode: actual,
        toggled,
        ...(previous?.firstMs === undefined && actual !== "UNUSED" ? { firstMs: this.timeMs } : previous?.firstMs === undefined ? {} : { firstMs: previous.firstMs }),
      });
    }
    this.nextModeCycle = this.cpu.cycles + Math.round(CLOCK_HZ / 1000);
  }

  private updateCircuit(): void {
    const branches: Branch[] = [];
    const diodes: DiodeBranch[] = [];
    const sources: { node: string; voltage: number; ohms: number }[] = [];
    const addBranch = (aPin: string, bPin: string, ohms: number, vf?: number, active = true): void => {
      const a = this.pinToNode.get(aPin);
      const b = this.pinToNode.get(bPin);
      if (a && b && active && isFinitePositive(ohms)) branches.push({ a, b, ohms, vf });
    };
    const addSource = (pinName: string, voltage: number, ohms: number): void => {
      const node = this.boardNode(this.profile.pins.find((pin) => pin.name === pinName) as BoardPin);
      if (node) sources.push({ node, voltage, ohms });
    };
    for (const pin of this.profile.pins) {
      if (!pin.port || pin.bit === undefined) continue;
      const node = this.boardNode(pin);
      if (!node) continue;
      const mapping = this.boardPins.get(pin.name) as PinMapping;
      const state = mapping.port.pinState(mapping.bit);
      const config = portConfig(pin.port);
      const mask = 1 << pin.bit;
      const output = Boolean(this.cpu.data[config.DDR] & mask);
      if (output && (state === PinState.High || state === PinState.Low)) addSource(pin.name, state === PinState.High ? this.profile.vcc : 0, DRIVER_OHMS);
      else if (!output && (this.cpu.data[config.PORT] & mask) !== 0) sources.push({ node, voltage: this.profile.vcc, ohms: PULLUP_OHMS });
    }
    for (const part of this.circuit.parts) {
      const params = part.params as Record<string, unknown>;
      if (part.module === "resistor") {
        const ohms = typeof params.ohms === "number" ? params.ohms : 10_000;
        addBranch(`${part.id}.1`, `${part.id}.2`, ohms);
      } else if (part.module === "led") {
        const vf = ledVf(params).typ;
        const a = this.pinToNode.get(`${part.id}.A`);
        const b = this.pinToNode.get(`${part.id}.K`);
        if (a && b) {
          const branch: Branch = { a, b, ohms: 1_000_000, vf: 0 };
          branches.push(branch);
          diodes.push({ branch, vf, on: false });
        }
      } else if (part.module === "button") {
        const pressed = this.sensors.digital.get(part.id) ?? false;
        addBranch(`${part.id}.1`, `${part.id}.3`, pressed ? 1 : 1e12);
      } else if (part.module === "photoresistor") {
        const level = this.sensors.light.get(part.id) ?? 0.8;
        addBranch(`${part.id}.1`, `${part.id}.2`, photoresistorOhms(level));
      } else if (part.module === "potentiometer") {
        const position = this.sensors.analog.get(part.id) ?? 0;
        const ohms = typeof params.ohms === "number" ? params.ohms : 10_000;
        addBranch(`${part.id}.A`, `${part.id}.W`, Math.max(1, ohms * position));
        addBranch(`${part.id}.W`, `${part.id}.B`, Math.max(1, ohms * (1 - position)));
      } else if (part.module === "buzzer-active") {
        addBranch(`${part.id}.P`, `${part.id}.N`, 5 / 0.03);
      } else if (part.module === "buzzer-passive") {
        addBranch(`${part.id}.P`, `${part.id}.N`, MODULES[part.module].electrical.coilOhms ?? 16);
      } else if (part.module === "generic") {
        const role = typeof params.role === "string" ? params.role : "";
        const pins = part.pinout ?? [];
        if (role === "digital-sensor" && pins.length > 0) {
          const node = this.pinToNode.get(`${part.id}.${pins[0].id}`);
          if (node) sources.push({ node, voltage: this.sensors.digital.get(part.id) ? 5 : 0, ohms: DRIVER_OHMS });
        } else if (role === "analog-sensor" && pins.length > 0) {
          const node = this.pinToNode.get(`${part.id}.${pins[0].id}`);
          if (node) sources.push({ node, voltage: (this.sensors.analog.get(part.id) ?? 0) * 5, ohms: DRIVER_OHMS });
        }
      }
    }
    let values = solveNodes(this.nodes, this.nodeFixed, branches, sources);
    for (let iteration = 0; iteration < 8; iteration += 1) {
      let changed = false;
      for (const diode of diodes) {
        const voltage = (values.get(diode.branch.a) ?? 0) - (values.get(diode.branch.b) ?? 0);
        const nextOn = diode.on ? voltage >= diode.vf - 0.01 : voltage >= diode.vf;
        if (nextOn !== diode.on) {
          diode.on = nextOn;
          diode.branch.ohms = nextOn ? 0.5 : 1_000_000;
          diode.branch.vf = nextOn ? diode.vf : 0;
          changed = true;
        }
      }
      if (!changed) break;
      values = solveNodes(this.nodes, this.nodeFixed, branches, sources);
    }
    this.voltages.clear();
    for (const [node, value] of values) this.voltages.set(node, value);
    this.adc.avcc = this.profile.vcc;
    for (const pin of this.profile.pins) {
      if (pin.adc === undefined) continue;
      const node = this.boardNode(pin);
      this.adc.channelValues[pin.adc] = node ? this.voltages.get(node) ?? 0 : 0;
    }
    for (const pin of this.profile.pins) {
      if (!pin.port || pin.bit === undefined || !pin.digital) continue;
      const config = portConfig(pin.port);
      const mask = 1 << pin.bit;
      if (this.cpu.data[config.DDR] & mask) continue;
      const node = this.boardNode(pin);
      const voltage = node ? this.voltages.get(node) ?? 0 : 0;
      const previous = this.inputValues.get(pin.name);
      const input = voltage >= this.profile.logic.vihMin ? 1 : voltage <= this.profile.logic.vilMax ? 0 : previous ?? (this.cpu.data[config.PORT] & mask ? 1 : 0);
      this.inputValues.set(pin.name, input);
      this.ports[pin.port].setPin(pin.bit, input === 1);
    }
    for (const pin of this.profile.pins) {
      if (!pin.port || pin.bit === undefined || !pin.digital) continue;
      const config = portConfig(pin.port);
      const mask = 1 << pin.bit;
      if (!(this.cpu.data[config.DDR] & mask)) continue;
      const node = this.boardNode(pin);
      const voltage = node ? this.voltages.get(node) : undefined;
      if (voltage === undefined) continue;
      const pinValue = voltage >= this.profile.logic.vihMin ? this.cpu.data[config.PIN] | mask : this.cpu.data[config.PIN] & ~mask;
      this.cpu.data[config.PIN] = pinValue;
    }
    this.updatePartReadings(branches, values);
    this.observeModesIfDue(true);
  }

  private updatePartReadings(branches: Branch[], values: VoltageMap): void {
    for (const part of this.circuit.parts) {
      const previous = this.partReadings.get(part.id) ?? { value: 0, on: false };
      let value = 0;
      let on = false;
      if (part.module === "led") {
        const a = this.pinToNode.get(`${part.id}.A`);
        const k = this.pinToNode.get(`${part.id}.K`);
        const vf = ledVf(part.params).typ;
        const voltage = (a ? values.get(a) ?? 0 : 0) - (k ? values.get(k) ?? 0 : 0);
        const current = Math.max(0, (voltage - vf) / 0.5);
        value = clamp(current / 0.02, 0, 1);
        on = value >= LED_LIT_THRESHOLD;
      } else if (part.module === "button") {
        value = this.sensors.digital.get(part.id) ? 1 : 0;
        on = value > 0;
      } else if (part.module === "photoresistor") {
        value = this.sensors.light.get(part.id) ?? 0.8;
      } else if (part.module === "potentiometer") {
        value = this.sensors.analog.get(part.id) ?? 0;
      } else if (part.module === "buzzer-active") {
        const p = this.pinToNode.get(`${part.id}.P`);
        const n = this.pinToNode.get(`${part.id}.N`);
        value = (p ? values.get(p) ?? 0 : 0) - (n ? values.get(n) ?? 0 : 0) >= 3 ? 1 : 0;
        on = value > 0;
      } else if (part.module === "buzzer-passive") {
        const p = this.pinToNode.get(`${part.id}.P`);
        const n = this.pinToNode.get(`${part.id}.N`);
        const coilOhms = MODULES[part.module].electrical.coilOhms ?? 16;
        const voltage = Math.abs((p ? values.get(p) ?? 0 : 0) - (n ? values.get(n) ?? 0 : 0));
        const current = voltage / coilOhms;
        const ratedCurrent = 0.02;
        value = clamp(current / ratedCurrent, 0, 1);
        on = current >= 0.001;
      } else if (part.module === "generic") {
        const role = typeof part.params.role === "string" ? part.params.role : "";
        value = role === "analog-sensor" ? this.sensors.analog.get(part.id) ?? 0 : this.sensors.digital.get(part.id) ? 1 : 0;
        on = value > 0;
      }
      if (previous.on !== on) {
        this.accountTo(this.cpu.cycles);
        if (on && !previous.on && (part.module === "buzzer-passive" || part.module === "generic")) {
          const rises = this.toneRises.get(part.id) ?? [];
          rises.push(this.cpu.cycles);
          this.toneRises.set(part.id, rises);
        }
      }
      this.partReadings.set(part.id, { value, on });
    }
    void branches;
  }


  private accountTo(cycle: number): void {
    const target = Math.max(this.lastAccountingCycle, cycle);
    const delta = target - this.lastAccountingCycle;
    if (delta > 0) {
      for (const [pin, mapping] of this.boardPins) {
        const state = mapping.port.pinState(mapping.bit);
        const previousHigh = this.lastPinStates.get(pin) ?? false;
        const segments = this.pinSegments.get(pin) ?? [];
        segments.push({ start: this.lastAccountingCycle, end: target, on: previousHigh });
        this.pinSegments.set(pin, segments);
        this.lastPinStates.set(pin, state === PinState.High);
      }
      for (const [part, reading] of this.partReadings) {
        const segments = this.partSegments.get(part) ?? [];
        segments.push({ start: this.lastAccountingCycle, end: target, on: reading.on });
        this.partSegments.set(part, segments);
        const valueSegments = this.partValueSegments.get(part) ?? [];
        valueSegments.push({ start: this.lastAccountingCycle, end: target, value: reading.value });
        this.partValueSegments.set(part, valueSegments);
      }
      this.lastAccountingCycle = target;
    }
  }

  private syncPhysicalPinRegisters(): void {
    for (const pin of this.profile.pins) {
      if (!pin.port || pin.bit === undefined || !pin.digital) continue;
      const config = portConfig(pin.port);
      const mask = 1 << pin.bit;
      if (!(this.cpu.data[config.DDR] & mask)) continue;
      const node = this.boardNode(pin);
      const voltage = node ? this.voltages.get(node) : undefined;
      if (voltage === undefined) continue;
      if (voltage >= this.profile.logic.vihMin) this.cpu.data[config.PIN] |= mask;
      else this.cpu.data[config.PIN] &= ~mask;
    }
  }

  private pumpRx(): void {
    const rxCompleteMask = 0x80;
    while (
      this.rxQueue.length > 0 &&
      !this.usart.rxBusy &&
      this.usart.rxEnable &&
      (this.cpu.data[usart0Config.UCSRA] & rxCompleteMask) === 0
    ) {
      const next = this.rxQueue.shift();
      if (next === undefined) break;
      this.usart.writeByte(next);
    }
  }

  private captureTraceIfDue(force = false): void {
    if (force || this.cpu.cycles >= this.nextTraceCycle) {
      this.captureTrace(false);
      while (this.nextTraceCycle <= this.cpu.cycles) this.nextTraceCycle += Math.round((TRACE_PERIOD_MS / 1000) * CLOCK_HZ);
    }
  }

  private captureTrace(force: boolean): void {
    const frame: TraceFrame = {
      t: Math.max(0, Math.round(this.timeMs)),
      parts: {},
      pins: {},
    };
    for (const part of this.circuit.parts) frame.parts[part.id] = this.partState(part.id);
    for (const pin of this.profile.pins) {
      const level = this.pinLevel(pin.name);
      if (level !== null) frame.pins[pin.name] = level;
    }
    const previous = this.trace?.frames[this.trace.frames.length - 1];
    const changed = !previous || JSON.stringify(previous.parts) !== JSON.stringify(frame.parts) || JSON.stringify(previous.pins) !== JSON.stringify(frame.pins);
    if (force || changed || !previous || frame.t - previous.t >= TRACE_PERIOD_MS) this.trace.frames.push(frame);
  }

}

/** Build a machine and run one exact scenario. */
export function executeScenario(input: { circuit: Circuit; hex: string; scenario: Scenario }): ScenarioExecution {
  const machine = new SimMachine(input.hex, input.circuit, {
    light: input.scenario.setup.light,
    analog: input.scenario.setup.analog,
    digital: input.scenario.setup.digital,
  });
  const stepResults: ScenarioResult["steps"] = [];
  let index = 0;
  for (const step of input.scenario.steps) {
    if (index >= MAX_SCENARIO_STEPS) throw new Error("scenario step budget exceeded");
    const atMs = machine.timeMs;
    const outcome = executeStep(machine, step);
    stepResults.push({ index, step, ok: outcome.ok, message: outcome.message, atMs });
    index += 1;
  }
  const trace = machine.finishTrace(input.scenario.id);
  return {
    result: {
      id: input.scenario.id,
      title: input.scenario.title,
      clauses: [...input.scenario.clauses],
      ok: stepResults.every((step) => step.ok),
      steps: stepResults,
      durationMs: machine.timeMs,
      serial: machine.serialText(),
      traceKey: input.scenario.id,
    },
    trace,
    pinModes: machine.pinModes(),
  };
}

function executeStep(machine: SimMachine, step: ScenarioStep): { ok: boolean; message: string } {
  if ("wait" in step) {
    machine.run(step.wait);
    return { ok: true, message: `waited ${step.wait} ms` };
  }
  if ("set-digital" in step) {
    machine.setDigital(step["set-digital"].part, step["set-digital"].value);
    return { ok: true, message: "digital input set" };
  }
  if ("press" in step) {
    const { part, holdMs, gapMs } = step.press;
    machine.setDigital(part, true);
    machine.run(holdMs);
    machine.setDigital(part, false);
    machine.run(gapMs);
    return { ok: true, message: "button press applied" };
  }
  if ("bounce" in step) {
    const { part, to, edges, ms } = step.bounce;
    machine.setDigital(part, !to);
    const edgeMs = ms / edges;
    let value = !to;
    for (let edge = 0; edge < edges; edge += 1) {
      value = edge === edges - 1 ? to : !value;
      machine.setDigital(part, value);
      machine.run(edgeMs);
    }
    return { ok: true, message: `bounced ${edges} edges over ${ms} ms` };
  }
  if ("set-light" in step) {
    machine.setLight(step["set-light"].part, step["set-light"].level);
    return { ok: true, message: "light level set" };
  }
  if ("set-analog" in step) {
    machine.setAnalog(step["set-analog"].part, step["set-analog"].value);
    return { ok: true, message: "analog input set" };
  }
  if ("expect-pin" in step) {
    const { pin, level } = step["expect-pin"];
    const actual = machine.pinLevel(pin);
    const expected = level === "high" ? 1 : 0;
    return actual === expected ? { ok: true, message: `${pin} is ${level}` } : { ok: false, message: `${pin} is ${actual === null ? "not an output" : actual ? "high" : "low"}; expected ${level}` };
  }
  if ("expect-part" in step) {
    const { part, state, windowMs } = step["expect-part"];
    const start = machine.currentCycle;
    machine.run(windowMs);
    const onFraction = machine.partOnFraction(part, start);
    const ok = state === "on" ? onFraction >= 0.9 : onFraction <= 0.1;
    const percentage = (onFraction * 100).toFixed(0);
    const message = ok
      ? `${part} was ${state} as expected (lit ${percentage}% of the window)`
      : `${part} should be ${state} (lit ${state === "on" ? "≥ 90%" : "≤ 10%"} of the window) but was lit ${percentage}%`;
    return { ok, message };
  }
  if ("expect-pwm" in step) {
    const { pin, min, max, windowMs } = step["expect-pwm"];
    const start = machine.currentCycle;
    machine.run(windowMs);
    const fraction = machine.pinHighFraction(pin, start);
    return fraction >= min && fraction <= max ? { ok: true, message: `${pin} duty ${(fraction * 100).toFixed(1)}%` } : { ok: false, message: `${pin} duty ${(fraction * 100).toFixed(1)}% outside ${(min * 100).toFixed(1)}–${(max * 100).toFixed(1)}%` };
  }
  if ("expect-tone" in step) {
    const { part, minHz, maxHz, windowMs } = step["expect-tone"];
    const start = machine.currentCycle;
    machine.run(windowMs);
    const hz = machine.toneFrequency(part, start);
    return hz >= minHz && hz <= maxHz ? { ok: true, message: `${part} tone ${hz.toFixed(1)} Hz` } : { ok: false, message: `${part} tone ${hz.toFixed(1)} Hz outside ${minHz}–${maxHz} Hz` };
  }
  if ("expect-serial" in step) {
    const { contains, withinMs } = step["expect-serial"];
    const deadline = machine.currentCycle + Math.round(withinMs * CLOCK_HZ / 1000);
    while (!machine.serialContains(contains) && machine.currentCycle < deadline) machine.run(Math.min(1, (deadline - machine.currentCycle) * 1000 / CLOCK_HZ));
    return machine.serialContains(contains) ? { ok: true, message: `serial contains ${JSON.stringify(contains)}` } : { ok: false, message: `serial did not contain ${JSON.stringify(contains)}` };
  }
  return { ok: false, message: "unsupported scenario step" };
}

export function observePinModesCore(input: { circuit: Circuit; hex: string; ms?: number }): PinModeObservation[] {
  const analog: Record<string, number> = {};
  for (const part of input.circuit.parts) if (part.module === "potentiometer") analog[part.id] = 0.5;
  const machine = new SimMachine(input.hex, input.circuit, { analog });
  machine.run(input.ms ?? 100);
  return machine.pinModes();
}

export function runScenarioCore(input: { circuit: Circuit; hex: string; scenario: Scenario }): Promise<{ result: ScenarioResult; trace: Trace; pinModes: PinModeObservation[] }> {
  return Promise.resolve(executeScenario(input));
}

export function partStateForMachine(machine: SimMachine, part: string): number {
  return machine.partState(part);
}