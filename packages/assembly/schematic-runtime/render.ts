import { createInterface } from "node:readline";
import {
  Board,
  Chip,
  Circuit as TscircuitCircuit,
  Led,
  Net,
  NetLabel,
  Potentiometer,
  type Port,
  PushButton,
  Resistor,
  Trace,
} from "@tscircuit/core";
import { convertCircuitJsonToSchematicSvg } from "circuit-to-svg";
import type { AnyCircuitElement } from "circuit-json";
import {
  BOARD_PROFILES,
  MODULES,
  modulePins,
  type Circuit,
  type Part,
  type PinRef,
} from "@vibread/core";

const SVG_WIDTH = 1800;
const SVG_HEIGHT = 1100;
const LED_COLORS = ["red", "yellow", "green", "blue", "white"] as const;
type LedColor = (typeof LED_COLORS)[number];

type SchematicPart = { portMap: unknown };
type Point = { x: number; y: number };
type WorkerRequest = { id: string; circuit: Circuit };
type WorkerResponse = { id: string; svg?: string; error?: string };

const SCHEMATIC_COLORS = {
  background: "#0b1220",
  component_body: "#172033",
  component_outline: "#93c5fd",
  pin: "#fda4af",
  pin_name: "#a7f3d0",
  pin_number: "#fda4af",
  reference: "#f8fafc",
  value: "#fde68a",
  fields: "#c4b5fd",
  wire: "#5eead4",
  wire_crossing: "#99f6e4",
  junction: "#5eead4",
  net_name: "#cbd5e1",
  label_local: "#f8fafc",
  label_global: "#fde68a",
  label_hier: "#fde68a",
  label_background: "rgba(15, 23, 42, 0.9)",
  grid: "#24324a",
  grid_axes: "#3b4d6c",
  sheet_background: "rgba(11, 18, 32, 0)",
  sheet: "#64748b",
  sheet_fields: "#94a3b8",
  sheet_filename: "#cbd5e1",
  sheet_label: "#a7f3d0",
  sheet_name: "#a7f3d0",
  table: "#64748b",
  note: "#bfdbfe",
  no_connect: "#fda4af",
  aux_items: "#94a3b8",
  hidden: "#475569",
  cursor: "#f8fafc",
  brightened: "#f0abfc",
  bus: "#818cf8",
  bus_junction: "#818cf8",
  erc_error: "#f87171",
  erc_warning: "#fbbf24",
  shadow: "rgba(96, 165, 250, 0.35)",
  override_item_colors: true,
} as const;

function tscircuitNetName(netId: string): string {
  if (netId === "5V") return "V5";
  if (/^[A-Za-z]/.test(netId)) return netId;
  return `N_${netId}`;
}

function isLedColor(value: unknown): value is LedColor {
  return typeof value === "string" && LED_COLORS.includes(value as LedColor);
}

function numericParam(part: Part, key: string, fallback: number): number {
  const value = part.params[key];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function formatOhms(value: number): string {
  if (value >= 1_000 && value % 1_000 === 0) return `${value / 1_000}kΩ`;
  return `${value}Ω`;
}

function partLabel(part: Part): string {
  if (part.label && part.label.trim().length > 0) return part.label;
  return MODULES[part.module].name;
}

function drawingLabel(part: Part): string {
  switch (part.module) {
    case "led":
      return part.id;
    case "resistor":
      return part.id;
    case "photoresistor":
      return part.id;
    case "potentiometer":
      return part.id;
    case "button":
      return part.id;
    case "buzzer-active":
      return part.id;
    case "buzzer-passive":
      return part.id;
    case "generic":
      return part.id;
  }
}

function getPort(component: SchematicPart, name: string): Port {
  const map = component.portMap as Record<string, Port>;
  const port = map[name];
  if (!port) throw new Error(`tscircuit port ${name} is unavailable`);
  return port;
}

function portNameForPartPin(part: Part, pin: string): string {
  switch (part.module) {
    case "led":
      return pin === "A" ? "anode" : pin === "K" ? "cathode" : pin;
    case "resistor":
    case "photoresistor":
      return pin === "1" ? "pin1" : pin === "2" ? "pin2" : pin;
    case "potentiometer":
      return pin === "A" ? "pin1" : pin === "W" ? "pin2" : pin === "B" ? "pin3" : pin;
    case "button":
    case "buzzer-active":
    case "buzzer-passive":
    case "generic":
      return pin;
  }
}

function pinSort(a: string, b: string): number {
  const rank = (pin: string): number => {
    if (pin === "5V") return 3;
    if (pin === "GND") return 4;
    if (pin.startsWith("D")) return 0;
    if (pin.startsWith("A")) return 1;
    return 2;
  };
  const difference = rank(a) - rank(b);
  if (difference !== 0) return difference;
  const aNumber = Number(a.slice(1));
  const bNumber = Number(b.slice(1));
  if (Number.isFinite(aNumber) && Number.isFinite(bNumber)) return aNumber - bNumber;
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

function boardPins(circuit: Circuit): string[] {
  const pins = new Set<string>(["5V", "GND"]);
  for (const net of circuit.nets) {
    for (const pin of net.pins) if (pin.part === "board") pins.add(pin.pin);
  }
  return [...pins].sort(pinSort);
}

function boardArrangement(circuit: Circuit, pins: string[]) {
  const leftSide: string[] = [];
  const rightSide: string[] = [];
  for (const pin of pins) {
    if (pin === "5V" || pin === "GND") continue;
    const role = circuit.roles.find((candidate) => candidate.pin === pin);
    if (role?.mode === "OUTPUT" || role?.mode === "PWM_OUT") rightSide.push(pin);
    else leftSide.push(pin);
  }
  return {
    leftSide: { pins: leftSide, direction: "top-to-bottom" },
    rightSide: { pins: rightSide, direction: "top-to-bottom" },
    topSide: pins.includes("5V") ? { pins: ["5V"], direction: "left-to-right" } : [],
    bottomSide: pins.includes("GND") ? { pins: ["GND"], direction: "left-to-right" } : [],
  };
}

function boardDisplayName(circuit: Circuit): string {
  const profile = BOARD_PROFILES[circuit.board.profile];
  if (profile.name.toLowerCase().includes("uno")) return "Uno R3";
  if (profile.name.toLowerCase().includes("nano")) return "Nano";
  return profile.name;
}

function boardPinAttributes(circuit: Circuit, pin: string): Record<string, unknown> {
  if (pin === "5V") return { providesPower: true, providesVoltage: "5V" };
  if (pin === "GND") return { providesGround: true };
  const role = circuit.roles.find((candidate) => candidate.pin === pin);
  if (role?.mode === "OUTPUT" || role?.mode === "PWM_OUT") return { isOutput: true, isGpio: true };
  if (role?.mode === "ANALOG_IN") return { isInput: true, isGpio: true, requiresVoltage: "0-5V" };
  return { isInput: true, isGpio: true };
}

function makeBoard(circuit: Circuit): Chip {
  const pins = boardPins(circuit);
  const pinLabels: Record<number, string> = {};
  const pinAttributes: Record<string, Record<string, unknown>> = {};
  const pinStyle: Record<string, { marginTop: string; marginBottom: string }> = {};
  pins.forEach((pin, index) => {
    pinLabels[index + 1] = pin;
    pinAttributes[pin] = boardPinAttributes(circuit, pin);
    pinStyle[pin] = { marginTop: "0.8mm", marginBottom: "0.8mm" };
  });
  return new Chip({
    name: "ARDUINO",
    displayName: `ARDUINO ${boardDisplayName(circuit)}`,
    pinLabels,
    pinAttributes,
    schPinArrangement: boardArrangement(circuit, pins),
    schX: 0,
    schY: 0,
    schPinStyle: pinStyle,
    schWidth: "9mm",
    schHeight: "7mm",
  });
}

function partPins(part: Part): string[] {
  return modulePins(part).map((pin) => pin.id);
}

function netForPin(circuit: Circuit, ref: PinRef): string[] {
  return circuit.nets.filter((net) => net.pins.some((pin) => pin.part === ref.part && pin.pin === ref.pin)).map((net) => net.id);
}

function boardSignalForPart(circuit: Circuit, partId: string): string | undefined {
  const queue: string[] = [partId];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || visited.has(current)) continue;
    visited.add(current);
    const refs = circuit.nets.flatMap((net) => net.pins.filter((pin) => pin.part === current && net.kind === "signal"));
    for (const ref of refs) {
      const net = circuit.nets.find((candidate) => candidate.pins.some((pin) => pin.part === ref.part && pin.pin === ref.pin));
      if (!net) continue;
      const board = net.pins.find((pin) => pin.part === "board");
      if (board) return board.pin;
      for (const pin of net.pins) if (pin.part !== current && pin.part !== "board") queue.push(pin.part);
    }
  }
  return undefined;
}

function centeredSlot(index: number, count: number, gap: number): number {
  return (index - (count - 1) / 2) * gap;
}

function partPositions(circuit: Circuit): Map<string, Point> {
  const positions = new Map<string, Point>();
  const pins = boardPins(circuit).filter((pin) => pin !== "5V" && pin !== "GND");
  const roleOf = (pin: string) => circuit.roles.find((role) => role.pin === pin);
  const outputs = pins.filter((pin) => roleOf(pin)?.mode === "OUTPUT" || roleOf(pin)?.mode === "PWM_OUT");
  const inputs = pins.filter((pin) => !outputs.includes(pin));
  const yByPin = new Map<string, number>();
  outputs.forEach((pin, index) => yByPin.set(pin, -centeredSlot(index, outputs.length, 3.8)));
  inputs.forEach((pin, index) => yByPin.set(pin, -centeredSlot(index, inputs.length, 3.8)));

  for (const part of circuit.parts) {
    const boardPin = boardSignalForPart(circuit, part.id);
    const y = boardPin ? yByPin.get(boardPin) ?? 0 : 0;
    if (part.module === "led" || part.module === "buzzer-active" || part.module === "buzzer-passive") positions.set(part.id, { x: 15, y });
    else if (part.module === "button" || part.module === "potentiometer" || part.module === "photoresistor") positions.set(part.id, { x: -15, y });
  }
  for (const part of circuit.parts) {
    if (part.module !== "resistor") continue;
    const boardPin = boardSignalForPart(circuit, part.id);
    const linked = partPins(part).flatMap((pin) => {
      const netIds = netForPin(circuit, { part: part.id, pin });
      return netIds.flatMap((netId) => circuit.nets.find((net) => net.id === netId)?.pins ?? []);
    }).find((ref) => ref.part !== part.id && ref.part !== "board");
    const linkedY = linked ? positions.get(linked.part)?.y : undefined;
    const y = boardPin ? yByPin.get(boardPin) ?? linkedY ?? 0 : linkedY ?? 0;
    positions.set(part.id, { x: linked && circuit.parts.find((candidate) => candidate.id === linked.part)?.module === "photoresistor" ? -7 : 7, y });
  }
  let fallback = 0;
  for (const part of circuit.parts) {
    if (!positions.has(part.id)) positions.set(part.id, { x: 13, y: centeredSlot(fallback++, circuit.parts.length, 3.8) });
  }
  return positions;
}

function makePart(part: Part, position: Point): SchematicPart {
  const label = drawingLabel(part);
  switch (part.module) {
    case "led":
      return new Led({ name: part.id, displayName: label, color: isLedColor(part.params.color) ? part.params.color : "red", schX: position.x, schY: position.y, footprint: "THT" });
    case "resistor":
      return new Resistor({ name: part.id, displayName: part.id, resistance: numericParam(part, "ohms", 220), schX: position.x, schY: position.y, footprint: "THT" });
    case "photoresistor":
      return new Resistor({ name: part.id, displayName: part.id, resistance: numericParam(part, "ohms", 10_000), schX: position.x, schY: position.y, footprint: "THT" });
    case "button":
      return new PushButton({ name: part.id, displayName: label, pinLabels: { 1: "1", 2: "2", 3: "3", 4: "4" }, internallyConnectedPins: [[1, 2], [3, 4]], schX: position.x, schY: position.y });
    case "potentiometer":
      return new Potentiometer({ name: part.id, displayName: label, maxResistance: numericParam(part, "ohms", 10_000), pinVariant: "three_pin", schX: position.x, schY: position.y });
    case "buzzer-active":
    case "buzzer-passive":
      return new Chip({ name: part.id, displayName: label, pinLabels: { 1: "P", 2: "N" }, pinAttributes: { P: { isPassive: true }, N: { isPassive: true } }, schPinArrangement: { leftSide: ["N"], rightSide: ["P"] }, schX: position.x, schY: position.y });
    case "generic": {
      const pins = part.pinout ?? [];
      const pinLabels: Record<number, string> = {};
      const pinAttributes: Record<string, Record<string, unknown>> = {};
      pins.forEach((pin, index) => {
        pinLabels[index + 1] = pin.id;
        pinAttributes[pin.id] = { isPassive: true };
      });
      return new Chip({ name: part.id, displayName: label, pinLabels, pinAttributes, schX: position.x, schY: position.y });
    }
  }
}

function selectorForPin(board: SchematicPart, components: Map<string, SchematicPart>, partsById: Map<string, Part>, ref: PinRef): string {
  const component = ref.part === "board" ? board : components.get(ref.part);
  if (!component) throw new Error(`Schematic component ${ref.part} is unavailable`);
  const portName = ref.part === "board" ? ref.pin : portNameForPartPin(partsById.get(ref.part)!, ref.pin);
  return getPort(component, portName).getPortSelector();
}

function addNetConnections(
  circuit: Circuit,
  board: SchematicPart,
  components: Map<string, SchematicPart>,
  partsById: Map<string, Part>,
  tscircuitBoard: Board,
  positions: Map<string, Point>,
): void {
  for (const net of circuit.nets) {
    const selectors = net.pins.map((ref) => selectorForPin(board, components, partsById, ref));
    if (net.kind === "power" || net.kind === "ground") {
      const internalName = tscircuitNetName(net.id);
      tscircuitBoard.add(new Net({ name: internalName, isPowerNet: net.kind === "power", isGroundNet: net.kind === "ground" }));
      for (let index = 0; index < selectors.length; index += 1) {
        const selector = selectors[index];
        const ref = net.pins[index];
        const part = ref?.part === "board" ? undefined : partsById.get(ref?.part ?? "");
        if (part?.module === "led" && net.kind === "ground") {
          const position = positions.get(part.id);
          if (position) tscircuitBoard.add(new NetLabel({ net: internalName, connectsTo: selector, anchorSide: "bottom", schX: position.x, schY: position.y - 2 }));
          else tscircuitBoard.add(new NetLabel({ net: internalName, connectsTo: selector, anchorSide: "bottom" }));
          continue;
        }
        const anchorSide = net.kind === "ground"
          ? ref?.part === "board"
            ? "bottom"
            : part?.module === "potentiometer" || part?.module === "button"
              ? "bottom"
              : "left"
          : "bottom";
        tscircuitBoard.add(new NetLabel({ net: internalName, connectsTo: selector, anchorSide }));
      }
      continue;
    }
    const first = selectors[0];
    if (!first) throw new Error(`Net ${net.id} has no pins`);
    const showNetName = !/^L\d+$/.test(net.id);
    for (const selector of selectors.slice(1)) {
      if (showNetName) tscircuitBoard.add(new Trace({ name: net.id, from: first, to: selector }));
      else tscircuitBoard.add(new Trace({ from: first, to: selector }));
    }
  }
}

function addSyntheticPowerLabels(circuit: Circuit, board: SchematicPart, tscircuitBoard: Board): void {
  const represented = new Set(circuit.nets.filter((net) => net.kind === "power" || net.kind === "ground").map((net) => net.id));
  if (!represented.has("5V")) {
    tscircuitBoard.add(new Net({ name: "V5", isPowerNet: true }));
    tscircuitBoard.add(new NetLabel({ net: "V5", connectsTo: getPort(board, "5V").getPortSelector(), anchorSide: "bottom" }));
  }
  if (!represented.has("GND")) {
    tscircuitBoard.add(new Net({ name: "GND", isGroundNet: true }));
    tscircuitBoard.add(new NetLabel({ net: "GND", connectsTo: getPort(board, "GND").getPortSelector(), anchorSide: "top" }));
  }
}

function hidePhotoresistorValue(elements: AnyCircuitElement[], partId: string): AnyCircuitElement[] {
  const sourceComponent = elements.find((element) => element.type === "source_component" && element.name === partId);
  const sourceId = sourceComponent?.type === "source_component" ? sourceComponent.source_component_id : undefined;
  return elements.map((element) => {
    if (element.type === "source_component" && element.name === partId && "display_resistance" in element) {
      return { ...element, display_resistance: "light sensor" };
    }
    if (element.type === "schematic_component" && sourceId && element.source_component_id === sourceId) {
      return { ...element, symbol_display_value: "light sensor" };
    }
    return element;
  });
}

function postProcessSvg(svg: string): string {
  return svg
    .replaceAll(">V5<", ">5V<")
    .replaceAll("rgb(169, 0, 0)", "#fda4af")
    .replaceAll("rgb(132, 0, 0)", "#fda4af")
    .replaceAll("rgb(0, 100, 100)", "#a7f3d0");
}

function cropSvg(svg: string): string {
  const bodyStart = svg.indexOf('<rect class="boundary"');
  const body = bodyStart >= 0 ? svg.slice(svg.indexOf(">", bodyStart) + 1) : svg;
  const values: number[] = [];
  const attrPattern = /\b(?:x|x1|x2|y|y1|y2)="(-?\d+(?:\.\d+)?)"/g;
  for (const match of body.matchAll(attrPattern)) values.push(Number(match[1]));
  const pathPattern = /\bd="([^"]+)"/g;
  for (const match of body.matchAll(pathPattern)) {
    for (const number of match[1].matchAll(/-?\d+(?:\.\d+)?/g)) values.push(Number(number[0]));
  }
  if (values.length < 4) return svg;
  const xValues = values.filter((_, index) => index % 2 === 0);
  const yValues = values.filter((_, index) => index % 2 === 1);
  const minX = Math.max(0, Math.min(...xValues) - 28);
  const minY = Math.max(0, Math.min(...yValues) - 28);
  const maxX = Math.min(SVG_WIDTH, Math.max(...xValues) + 28);
  const maxY = Math.min(SVG_HEIGHT, Math.max(...yValues) + 28);
  const viewBox = `${minX} ${minY} ${Math.max(1, maxX - minX)} ${Math.max(1, maxY - minY)}`;
  const withViewBox = svg.replace(/<svg ([^>]+)>/, `<svg $1 viewBox="${viewBox}">`);
  const croppedHeight = Math.max(1, Math.round((maxY - minY) * SVG_WIDTH / Math.max(1, maxX - minX)));
  const withCroppedHeight = withViewBox.replace(/(<svg [^>]*?)height="1100"/, `$1height="${croppedHeight}"`);
  return withCroppedHeight.replace('<rect class="boundary" x="0" y="0" width="1800" height="1100"/>', `<rect class="boundary" x="${minX}" y="${minY}" width="${maxX - minX}" height="${maxY - minY}"/>`);
}

async function renderCircuit(circuit: Circuit): Promise<string> {
  const tscircuit = new TscircuitCircuit();
  const tscircuitBoard = new Board({ width: "80mm", height: "55mm" });
  const board = makeBoard(circuit);
  const positions = partPositions(circuit);
  const components = new Map<string, SchematicPart>();
  const partsById = new Map<string, Part>();
  tscircuitBoard.add(board);
  for (const part of circuit.parts) {
    const component = makePart(part, positions.get(part.id) ?? { x: 0, y: 0 });
    tscircuitBoard.add(component);
    components.set(part.id, component);
    partsById.set(part.id, part);
  }
  addNetConnections(circuit, board, components, partsById, tscircuitBoard, positions);
  addSyntheticPowerLabels(circuit, board, tscircuitBoard);
  tscircuit.add(tscircuitBoard);
  const circuitJson = hidePhotoresistorValue(tscircuit.getCircuitJson(), "LDR1");
  const svg = convertCircuitJsonToSchematicSvg(circuitJson, { width: SVG_WIDTH, height: SVG_HEIGHT, includeVersion: true, colorOverrides: { schematic: SCHEMATIC_COLORS }, css: "text { font-size: 24px !important; }" });
  return cropSvg(postProcessSvg(svg));
}

function isWorkerRequest(value: unknown): value is WorkerRequest {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { id?: unknown; circuit?: unknown };
  return typeof candidate.id === "string" && typeof candidate.circuit === "object" && candidate.circuit !== null;
}

function writeResponse(response: WorkerResponse): void {
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  if (!line.trim()) continue;
  let requestId = "unknown";
  try {
    const parsed: unknown = JSON.parse(line);
    if (!isWorkerRequest(parsed)) throw new Error("invalid schematic worker request");
    requestId = parsed.id;
    const svg = await renderCircuit(parsed.circuit);
    writeResponse({ id: requestId, svg });
  } catch (error) {
    writeResponse({ id: requestId, error: error instanceof Error ? error.message : String(error) });
  }
}
