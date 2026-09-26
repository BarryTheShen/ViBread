import {
  BOARD_PART,
  BOARD_PROFILES,
  BREADBOARD_PROFILES,
  MODULES,
  WIRE_COLORS,
  boardPin,
  contactGroup,
  hashJson,
  isValidHole,
  modulePins,
  pinKey,
  type BoardPinName,
  type BreadboardProfile,
  type Circuit,
  type Column,
  type Endpoint,
  type HoleId,
  type Jumper,
  type Layout,
  type Part,
  type Placement,
  type WireColor,
} from "@vibread/core";

const LEFT_COLUMNS = ["a", "b", "c", "d", "e"] as const;
const RIGHT_COLUMNS = ["f", "g", "h", "i", "j"] as const;
const SIGNAL_COLORS = ["yellow", "green", "blue", "orange", "white", "purple", "cyan", "magenta", "lime", "teal", "pink", "brown", "gold"] as const;

type Side = "left" | "right";
type NetId = string;
type NetKind = "power" | "ground" | "signal";
type NetPin = { net: NetId; kind: NetKind };
type PendingJumper = { jumper: Jumper; phase: number };

export interface AllocationContext {
  circuit: Circuit;
  profile: BreadboardProfile;
  pinNets: Map<string, NetPin>;
  netKinds: Map<NetId, NetKind>;
  placements: Placement[];
  occupied: Map<HoleId, string>;
  groups: Map<string, string>;
  strips: Map<NetId, HoleId>;
  pending: PendingJumper[];
  cursors: Record<Side, number>;
  nanoPinHoles: Map<BoardPinName, HoleId>;
  boardAnchor?: Layout["boardAnchor"];
}

function sideColumns(side: Side): readonly Column[] {
  return side === "left" ? LEFT_COLUMNS : RIGHT_COLUMNS;
}

function column(side: Side, index: number): Column {
  return sideColumns(side)[index] ?? sideColumns(side).at(-1)!;
}

function stripHole(side: Side, row: number): HoleId {
  return `${side === "left" ? "a" : "f"}${row}`;
}

function firstRailHole(profile: BreadboardProfile, rail: "T+" | "T-"): HoleId {
  const position = profile.railPositions[0];
  if (position === undefined) throw new Error(`Breadboard ${profile.id} has no rail positions`);
  return `${rail}${position}`;
}
function railHoleAtRow(profile: BreadboardProfile, rail: "T+" | "T-", row: number): HoleId {
  const position = [...profile.railPositions].sort((a, b) => Math.abs(a - row) - Math.abs(b - row) || a - b)[0];
  if (position === undefined) throw new Error(`Breadboard ${profile.id} has no rail positions`);
  return `${rail}${position}`;
}

function endpointKey(endpoint: Endpoint): string {
  return "hole" in endpoint ? `hole:${endpoint.hole}` : `board:${endpoint.board}`;
}

function asWireColor(value: string): WireColor {
  return value as unknown as WireColor;
}

function buildPinNets(circuit: Circuit): { pinNets: Map<string, NetPin>; netKinds: Map<NetId, NetKind> } {
  const pinNets = new Map<string, NetPin>();
  const netKinds = new Map<NetId, NetKind>();
  for (const net of circuit.nets) {
    netKinds.set(net.id, net.kind);
    for (const ref of net.pins) pinNets.set(pinKey(ref), { net: net.id, kind: net.kind });
  }
  for (const part of circuit.parts) {
    for (const group of MODULES[part.module].internallyConnected ?? []) {
      const known = group.map((pin) => pinNets.get(`${part.id}.${pin}`)).filter((value): value is NetPin => value !== undefined);
      if (known.length === 0) continue;
      const first = known[0];
      if (known.some((entry) => entry.net !== first.net)) throw new Error(`Part ${part.id} has internally joined pins assigned to different nets`);
      for (const pin of group) pinNets.set(`${part.id}.${pin}`, first);
    }
  }
  return { pinNets, netKinds };
}

function pinNet(ctx: AllocationContext, part: Part, pin: string): NetPin | undefined {
  return ctx.pinNets.get(`${part.id}.${pin}`);
}

function pinNetId(ctx: AllocationContext, part: Part, pin: string): string {
  return pinNet(ctx, part, pin)?.net ?? `__floating:${part.id}.${pin}`;
}

function signalIndex(ctx: AllocationContext, net: NetId): number {
  return ctx.circuit.nets.filter((entry) => entry.kind === "signal").sort((a, b) => a.id.localeCompare(b.id)).findIndex((entry) => entry.id === net);
}

function wireColor(ctx: AllocationContext, net: NetId): WireColor {
  const kind = ctx.netKinds.get(net) ?? "signal";
  if (kind === "power") return WIRE_COLORS[0];
  if (kind === "ground") return WIRE_COLORS[1];
  return asWireColor(SIGNAL_COLORS[Math.max(0, signalIndex(ctx, net)) % SIGNAL_COLORS.length]);
}

function groupFor(ctx: AllocationContext, hole: HoleId): string {
  const group = contactGroup(ctx.profile, hole);
  if (group === null) throw new Error(`Invalid hole ${hole} on ${ctx.profile.id}`);
  return group;
}

function reserveStrip(ctx: AllocationContext, net: NetId, side: Side, row: number): HoleId {
  if (row < 1 || row > ctx.profile.rows) throw new Error(`Cannot fit ${net}: strip row ${row} is outside ${ctx.profile.id}`);
  const hole = stripHole(side, row);
  const group = groupFor(ctx, hole);
  const existing = ctx.groups.get(group);
  if (existing !== undefined && existing !== net) throw new Error(`Cannot fit ${net}: ${group} is already occupied by ${existing}`);
  ctx.groups.set(group, net);
  if (!ctx.strips.has(net)) ctx.strips.set(net, hole);
  return hole;
}

function candidateAllowed(ctx: AllocationContext, part: Part, pins: Record<string, HoleId>): boolean {
  const localGroups = new Map<string, string>();
  for (const [pin, hole] of Object.entries(pins)) {
    if (!isValidHole(ctx.profile, hole) || ctx.occupied.has(hole)) return false;
    const group = groupFor(ctx, hole);
    const net = pinNetId(ctx, part, pin);
    const existing = ctx.groups.get(group);
    if (existing !== undefined && existing !== net) return false;
    const local = localGroups.get(group);
    if (local !== undefined && local !== net) return false;
    localGroups.set(group, net);
  }
  return true;
}

function putPlacement(ctx: AllocationContext, part: Part, pins: Record<string, HoleId>): void {
  if (!candidateAllowed(ctx, part, pins)) throw new Error(`Internal allocator error: ${part.id} placement is occupied or shorted`);
  for (const [pin, hole] of Object.entries(pins)) {
    const net = pinNetId(ctx, part, pin);
    ctx.occupied.set(hole, `${part.id}.${pin}`);
    ctx.groups.set(groupFor(ctx, hole), net);
  }
  ctx.placements.push({ part: part.id, pins: { ...pins } });
}

function blockStart(ctx: AllocationContext, side: Side, height: number, bothSides = false): number {
  const minimum = bothSides ? Math.max(ctx.cursors.left, ctx.cursors.right) + 1 : ctx.cursors[side] + 1;
  if (minimum + height - 1 > ctx.profile.rows) {
    throw new Error(`Cannot fit ${height}-row branch on ${ctx.profile.id}: no rows remain; try bb-830 or remove a branch`);
  }
  return minimum;
}

function finishBlock(ctx: AllocationContext, side: Side, end: number, bothSides = false): void {
  if (bothSides) {
    ctx.cursors.left = end + 1;
    ctx.cursors.right = end + 1;
  } else ctx.cursors[side] = end + 1;
}

function addJumper(ctx: AllocationContext, from: Endpoint, to: Endpoint, net: NetId, phase: number): void {
  if (endpointKey(from) === endpointKey(to)) return;
  const color = wireColor(ctx, net);
  const duplicate = ctx.pending.some((entry) => {
    const first = endpointKey(entry.jumper.from);
    const second = endpointKey(entry.jumper.to);
    return entry.jumper.net === net && ((first === endpointKey(from) && second === endpointKey(to)) || (first === endpointKey(to) && second === endpointKey(from)));
  });
  if (duplicate) return;
  ctx.pending.push({ phase, jumper: { id: "", from, to, color, net } });
}

function addRailJumper(ctx: AllocationContext, strip: HoleId, net: NetId): void {
  const row = Number.parseInt(strip.slice(1), 10);
  const kind = ctx.netKinds.get(net);
  if (kind === "power") addJumper(ctx, { hole: railHoleAtRow(ctx.profile, "T+", row) }, { hole: strip }, net, 2);
  else if (kind === "ground") addJumper(ctx, { hole: strip }, { hole: railHoleAtRow(ctx.profile, "T-", row) }, net, 2);
}

function boardPinsForNet(ctx: AllocationContext, net: NetId): string[] {
  return ctx.circuit.nets.find((entry) => entry.id === net)?.pins.filter((ref) => ref.part === BOARD_PART).map((ref) => ref.pin).sort() ?? [];
}

function boardPinOrder(pin: string): number {
  const match = /^(?:D|A)(\d+)$/.exec(pin);
  if (match) return pin[0] === "D" ? Number(match[1]) : 100 + Number(match[1]);
  return 300;
}

function addBoardNetJumper(ctx: AllocationContext, net: NetId, strip: HoleId): void {
  const kind = ctx.netKinds.get(net);
  if (kind === "power") {
    for (const pin of boardPinsForNet(ctx, net)) addJumper(ctx, { board: pin }, { hole: firstRailHole(ctx.profile, "T+") }, net, 0);
    addJumper(ctx, { hole: firstRailHole(ctx.profile, "T+") }, { hole: strip }, net, 1);
    return;
  }
  if (kind === "ground") {
    for (const pin of boardPinsForNet(ctx, net)) addJumper(ctx, { board: pin }, { hole: firstRailHole(ctx.profile, "T-") }, net, 0);
    return;
  }
  for (const pin of boardPinsForNet(ctx, net)) {
    if (ctx.boardAnchor && ctx.nanoPinHoles.has(pin)) {
      const headerHole = ctx.nanoPinHoles.get(pin)!;
      addJumper(ctx, { board: pin }, { hole: headerHole }, net, 0);
      if (headerHole !== strip && groupFor(ctx, headerHole) !== groupFor(ctx, strip)) addJumper(ctx, { hole: headerHole }, { hole: strip }, net, 1);
    } else addJumper(ctx, { board: pin }, { hole: strip }, net, 0);
  }
}

function renderBranchError(part: Part, ctx: AllocationContext, height: number): never {
  throw new Error(`Cannot fit ${part.id} (${MODULES[part.module].name}) on ${ctx.profile.id}: no legal ${height}-row branch remains; try bb-830 or remove a part`);
}

function ledBranches(ctx: AllocationContext, used: Set<string>): void {
  const leds = ctx.circuit.parts.filter((part) => part.module === "led").sort((a, b) => {
    const aNet = pinNet(ctx, a, "A")?.net ?? a.id;
    const bNet = pinNet(ctx, b, "A")?.net ?? b.id;
    const aPins = boardPinsForNet(ctx, [...ctx.circuit.nets.filter((net) => net.id === aNet)][0]?.id ?? aNet);
    const bPins = boardPinsForNet(ctx, [...ctx.circuit.nets.filter((net) => net.id === bNet)][0]?.id ?? bNet);
    return (aPins[0] ? boardPinOrder(aPins[0]) : 500) - (bPins[0] ? boardPinOrder(bPins[0]) : 500) || a.id.localeCompare(b.id);
  });
  const resistors = ctx.circuit.parts.filter((part) => part.module === "resistor");
  const buttonCount = ctx.circuit.parts.filter((part) => part.module === "button").length;
  const buttonReserve = buttonCount > 0 ? buttonCount * 4 - 1 : 0;
  const canFinish = (side: Side): boolean => {
    const nextCursor = ctx.cursors[side] + 1 + 5 + 1;
    const other = side === "left" ? ctx.cursors.right : ctx.cursors.left;
    return Math.max(nextCursor, other) + buttonReserve <= ctx.profile.rows;
  };
  for (const led of leds) {
    const anodeNet = pinNet(ctx, led, "A")?.net;
    const resistor = resistors.find((part) => pinNet(ctx, part, "2")?.net === anodeNet && !used.has(part.id));
    if (!anodeNet || !resistor) continue;
    const signalNet = pinNet(ctx, resistor, "1")?.net;
    const groundNet = pinNet(ctx, led, "K")?.net;
    if (!signalNet || !groundNet) continue;
    const side: Side = canFinish("left") ? "left" : canFinish("right") ? "right" : (renderBranchError(led, ctx, 6) as never);
    const base = blockStart(ctx, side, 6);
    const ledStrip = reserveStrip(ctx, anodeNet, side, base + 4);
    const signalStrip = reserveStrip(ctx, signalNet, side, base);
    const groundStrip = reserveStrip(ctx, groundNet, side, base + 5);
    const resistorColumn = side === "left" ? "e" : "j";
    const ledColumn = side === "left" ? "d" : "i";
    const resistorPins = { "1": `${resistorColumn}${base}`, "2": `${resistorColumn}${base + 4}` };
    const ledPins = { A: `${ledColumn}${base + 4}`, K: `${ledColumn}${base + 5}` };
    if (!candidateAllowed(ctx, resistor, resistorPins) || !candidateAllowed(ctx, led, ledPins)) renderBranchError(led, ctx, 6);
    putPlacement(ctx, resistor, resistorPins);
    putPlacement(ctx, led, ledPins);
    addRailJumper(ctx, groundStrip, groundNet);
    finishBlock(ctx, side, base + 5);
    used.add(led.id);
    used.add(resistor.id);
    // The names make the direct-strip invariant explicit for later fallback
    // branches, even when a net appears in more than one physical branch.
    void ledStrip;
    void signalStrip;
  }
}

function dividerBranches(ctx: AllocationContext, used: Set<string>): void {
  const sensors = ctx.circuit.parts.filter((part) => part.module === "photoresistor").sort((a, b) => a.id.localeCompare(b.id));
  const resistors = ctx.circuit.parts.filter((part) => part.module === "resistor");
  for (const sensor of sensors) {
    const sensorSignal = pinNet(ctx, sensor, "2")?.net;
    const resistor = resistors.find((part) => pinNet(ctx, part, "1")?.net === sensorSignal && !used.has(part.id));
    if (!sensorSignal || !resistor) continue;
    const powerNet = pinNet(ctx, sensor, "1")?.net;
    const groundNet = pinNet(ctx, resistor, "2")?.net;
    if (!powerNet || !groundNet) continue;
    const side: Side = ctx.cursors.right <= ctx.profile.rows - 6 ? "right" : "left";
    const base = blockStart(ctx, side, 7);
    const powerStrip = reserveStrip(ctx, powerNet, side, base);
    const sensorStrip = reserveStrip(ctx, sensorSignal, side, base + 2);
    const groundStrip = reserveStrip(ctx, groundNet, side, base + 6);
    const sensorColumn = side === "left" ? "d" : "i";
    const resistorColumn = side === "left" ? "c" : "h";
    const sensorPins = { "1": `${sensorColumn}${base}`, "2": `${sensorColumn}${base + 2}` };
    const resistorPins = { "1": `${resistorColumn}${base + 2}`, "2": `${resistorColumn}${base + 6}` };
    if (!candidateAllowed(ctx, sensor, sensorPins) || !candidateAllowed(ctx, resistor, resistorPins)) renderBranchError(sensor, ctx, 7);
    putPlacement(ctx, sensor, sensorPins);
    putPlacement(ctx, resistor, resistorPins);
    addRailJumper(ctx, powerStrip, powerNet);
    addRailJumper(ctx, groundStrip, groundNet);
    finishBlock(ctx, side, base + 6);
    used.add(sensor.id);
    used.add(resistor.id);
    void sensorStrip;
  }
}

function buttonBranches(ctx: AllocationContext, used: Set<string>): void {
  const buttons = ctx.circuit.parts.filter((part) => part.module === "button").sort((a, b) => a.id.localeCompare(b.id));
  for (const button of buttons) {
    const signalNet = pinNet(ctx, button, "1")?.net;
    const groundNet = pinNet(ctx, button, "3")?.net;
    if (!signalNet || !groundNet) continue;
    const base = blockStart(ctx, "left", 3, true);
    const signalStrip = reserveStrip(ctx, signalNet, "left", base);
    reserveStrip(ctx, signalNet, "right", base);
    const groundStrip = reserveStrip(ctx, groundNet, "left", base + 2);
    reserveStrip(ctx, groundNet, "right", base + 2);
    const pins = { "1": `e${base}`, "2": `f${base}`, "3": `e${base + 2}`, "4": `f${base + 2}` };
    if (!candidateAllowed(ctx, button, pins)) renderBranchError(button, ctx, 3);
    putPlacement(ctx, button, pins);
    void signalStrip;
    addRailJumper(ctx, groundStrip, groundNet);
    finishBlock(ctx, "left", base + 2, true);
    used.add(button.id);
  }
}

function fallbackParts(ctx: AllocationContext, used: Set<string>): void {
  const parts = ctx.circuit.parts.filter((part) => !used.has(part.id)).sort((a, b) => a.id.localeCompare(b.id));
  for (const part of parts) {
    const footprint = MODULES[part.module].footprint;
    if (footprint.kind === "button4") continue;
    const side: Side = ctx.cursors.right < ctx.cursors.left ? "right" : "left";
    const span = footprint.kind === "two-lead" ? footprint.preferredSpan : footprint.kind === "inline3" ? 2 : Math.max(0, modulePins(part).length - 1);
    const base = blockStart(ctx, side, span + 1);
    const pins: Record<string, HoleId> = {};
    if (footprint.kind === "two-lead") {
      pins[footprint.pins[0]] = `${column(side, 4)}${base}`;
      pins[footprint.pins[1]] = `${column(side, 4)}${base + footprint.preferredSpan}`;
    } else if (footprint.kind === "inline3") {
      footprint.pins.forEach((pin, index) => (pins[pin] = `${column(side, 3)}${base + index}`));
    } else {
      modulePins(part).forEach((pin, index) => (pins[pin.id] = `${column(side, 3)}${base + index}`));
    }
    if (!candidateAllowed(ctx, part, pins)) renderBranchError(part, ctx, span + 1);
    putPlacement(ctx, part, pins);
    for (const [pin, hole] of Object.entries(pins)) {
      const net = pinNet(ctx, part, pin);
      if (!net) continue;
      const row = Number.parseInt(hole.slice(1), 10);
      const strip = reserveStrip(ctx, net.net, side, row);
      if (net.kind === "power" || net.kind === "ground") addRailJumper(ctx, strip, net.net);
    }
    finishBlock(ctx, side, base + span);
    used.add(part.id);
  }
}

function reserveNano(ctx: AllocationContext): void {
  const board = BOARD_PROFILES[ctx.circuit.board.profile];
  if (board.placement !== "straddle") return;
  const topRow = ctx.profile.rows <= 30 ? 1 : 2;
  const columns: [Column, Column] = ["e", "f"];
  ctx.boardAnchor = { topRow, columns };
  const header = board.headers[0]?.pins ?? [];
  header.forEach((pin, index) => {
    const side = index < 15 ? columns[0] : columns[1];
    const offset = index < 15 ? index : 29 - index;
    const hole = `${side}${topRow + offset}`;
    if (!isValidHole(ctx.profile, hole)) return;
    ctx.occupied.set(hole, `board.${pin}`);
    ctx.groups.set(groupFor(ctx, hole), "__board");
    if (!ctx.nanoPinHoles.has(pin)) ctx.nanoPinHoles.set(pin, hole);
  });
  ctx.cursors.left = 15;
  ctx.cursors.right = 15;
}

function finalizeJumpers(ctx: AllocationContext): Jumper[] {
  const signalStrips = new Map(ctx.strips);
  for (const net of ctx.circuit.nets.filter((entry) => entry.kind === "signal").sort((a, b) => a.id.localeCompare(b.id))) {
    const strip = signalStrips.get(net.id);
    if (strip === undefined) throw new Error(`Cannot fit ${net.id}: no five-hole strip was allocated`);
    addBoardNetJumper(ctx, net.id, strip);
  }
  for (const net of ctx.circuit.nets.filter((entry) => entry.kind !== "signal").sort((a, b) => a.id.localeCompare(b.id))) {
    const boardPins = boardPinsForNet(ctx, net.id);
    if (net.kind === "power") {
      for (const pin of boardPins) {
        if (ctx.boardAnchor && ctx.nanoPinHoles.has(pin)) {
          const hole = ctx.nanoPinHoles.get(pin)!;
          addJumper(ctx, { board: pin }, { hole }, net.id, 0);
        } else addJumper(ctx, { board: pin }, { hole: firstRailHole(ctx.profile, "T+") }, net.id, 0);
      }
    } else {
      for (const pin of boardPins) {
        if (ctx.boardAnchor && ctx.nanoPinHoles.has(pin)) addJumper(ctx, { board: pin }, { hole: ctx.nanoPinHoles.get(pin)! }, net.id, 0);
        else addJumper(ctx, { board: pin }, { hole: firstRailHole(ctx.profile, "T-") }, net.id, 0);
      }
    }
  }
  ctx.pending.sort((a, b) => a.phase - b.phase || a.jumper.net.localeCompare(b.jumper.net) || endpointKey(a.jumper.from).localeCompare(endpointKey(b.jumper.from)) || endpointKey(a.jumper.to).localeCompare(endpointKey(b.jumper.to)));
  return ctx.pending.map((entry, index) => ({ ...entry.jumper, id: `W${index + 1}` }));
}

export function layoutBoard(circuit: Circuit): Layout {
  const profile = BREADBOARD_PROFILES[circuit.breadboard.profile];
  const board = BOARD_PROFILES[circuit.board.profile];
  if (!profile) throw new Error(`Unknown breadboard profile ${circuit.breadboard.profile}`);
  if (!board) throw new Error(`Unknown board profile ${circuit.board.profile}`);
  const { pinNets, netKinds } = buildPinNets(circuit);
  const ctx: AllocationContext = { circuit, profile, pinNets, netKinds, placements: [], occupied: new Map(), groups: new Map(), strips: new Map(), pending: [], cursors: { left: 0, right: 0 }, nanoPinHoles: new Map() };
  reserveNano(ctx);
  const used = new Set<string>();
  // Reserve compact divider and LED branches first so a half-size board has
  // enough rows for the required one-row spacers. Buttons are deliberately
  // last because their footprint consumes both halves of a row.
  dividerBranches(ctx, used);
  ledBranches(ctx, used);
  fallbackParts(ctx, used);
  buttonBranches(ctx, used);
  // Every net with a board pin must have a strip/rail endpoint. Branch helpers
  // already created signal strips; this catches a board-only signal clearly.
  for (const net of circuit.nets.filter((entry) => entry.kind === "signal")) {
    if (!ctx.strips.has(net.id)) {
      const side: Side = ctx.cursors.left <= ctx.cursors.right ? "left" : "right";
      const row = blockStart(ctx, side, 1);
      reserveStrip(ctx, net.id, side, row);
      finishBlock(ctx, side, row);
    }
  }
  return { schema: "vibread.layout/1", board: circuit.board.profile, breadboard: circuit.breadboard.profile, placements: ctx.placements.sort((a, b) => a.part.localeCompare(b.part)), jumpers: finalizeJumpers(ctx), ...(ctx.boardAnchor ? { boardAnchor: ctx.boardAnchor } : {}) };
}

export function layoutHash(layout: Layout): string {
  return hashJson(layout);
}

export function layoutPinNet(circuit: Circuit): Map<string, NetPin> {
  return buildPinNets(circuit).pinNets;
}

export function railAnchor(profile: BreadboardProfile, kind: "power" | "ground"): HoleId {
  return firstRailHole(profile, kind === "power" ? "T+" : "T-");
}

export function signalColor(index: number): string {
  return SIGNAL_COLORS[index % SIGNAL_COLORS.length];
}

export function breadboardSideColumns(side: Side): readonly Column[] {
  return sideColumns(side);
}

export function endpointHoleId(endpoint: Endpoint): HoleId | undefined {
  return "hole" in endpoint ? endpoint.hole : undefined;
}
