import {
  BOARD_PART,
  BOARD_PROFILES,
  BREADBOARD_PROFILES,
  MODULES,
  WIRE_COLORS,
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
const SIGNAL_COLORS = [
  "yellow",
  "green",
  "blue",
  "orange",
  "white",
  "purple",
  "cyan",
  "magenta",
  "lime",
  "teal",
  "pink",
  "brown",
  "gold",
] as const;

type Side = "left" | "right";
type NetId = string;
type NetKind = "power" | "ground" | "signal";

type InternalPinNet = {
  net: NetId;
  kind: NetKind;
};

type Candidate = {
  side: Side;
  start: number;
  end: number;
  pins: Record<string, HoleId>;
};

export interface AllocationContext {
  circuit: Circuit;
  profile: BreadboardProfile;
  pinNets: Map<string, InternalPinNet>;
  netKinds: Map<NetId, NetKind>;
  placements: Placement[];
  occupied: Map<HoleId, string>;
  groups: Map<string, string>;
  nanoPinHoles: Map<BoardPinName, HoleId>;
  boardAnchor?: Layout["boardAnchor"];
}

function endpointKey(endpoint: Endpoint): string {
  return "hole" in endpoint ? `hole:${endpoint.hole}` : `board:${endpoint.board}`;
}

function sideColumns(side: Side): readonly Column[] {
  return side === "left" ? LEFT_COLUMNS : RIGHT_COLUMNS;
}

function rowHole(side: Side, row: number, columnOffset = 0): HoleId {
  return `${sideColumns(side)[columnOffset]}${row}`;
}

function endpointHole(endpoint: Endpoint): HoleId | undefined {
  return "hole" in endpoint ? endpoint.hole : undefined;
}

function asWireColor(color: string): WireColor {
  // The frozen core palette predates the larger signal palette.  The runtime SVG
  // renderer supports the additional named colors while callers still see the
  // public WireColor type.
  return color as unknown as WireColor;
}

function netColor(net: NetId, kind: NetKind, signalIndex: number): WireColor {
  if (kind === "power") return WIRE_COLORS[0];
  if (kind === "ground") return WIRE_COLORS[1];
  return asWireColor(SIGNAL_COLORS[signalIndex % SIGNAL_COLORS.length]);
}

function firstRailHole(profile: BreadboardProfile, rail: "T+" | "T-"): HoleId {
  const position = profile.railPositions[0];
  if (position === undefined) throw new Error(`Breadboard ${profile.id} has no rail positions`);
  return `${rail}${position}`;
}

function netOfPin(pinNets: Map<string, InternalPinNet>, part: string, pin: string): InternalPinNet | undefined {
  return pinNets.get(`${part}.${pin}`);
}


function buildPinNets(circuit: Circuit): { pinNets: Map<string, InternalPinNet>; netKinds: Map<NetId, NetKind> } {
  const pinNets = new Map<string, InternalPinNet>();
  const netKinds = new Map<NetId, NetKind>();
  for (const net of circuit.nets) {
    netKinds.set(net.id, net.kind);
    for (const ref of net.pins) pinNets.set(pinKey(ref), { net: net.id, kind: net.kind });
  }
  for (const part of circuit.parts) {
    const groups = MODULES[part.module].internallyConnected ?? [];
    for (const group of groups) {
      const known = group
        .map((pin) => pinNets.get(`${part.id}.${pin}`))
        .filter((value): value is InternalPinNet => value !== undefined);
      if (known.length === 0) continue;
      const first = known[0];
      if (known.some((entry) => entry.net !== first.net)) {
        throw new Error(`Part ${part.id} has internally joined pins assigned to different nets`);
      }
      for (const pin of group) pinNets.set(`${part.id}.${pin}`, first);
    }
  }
  return { pinNets, netKinds };
}

function pinNetOrFloating(ctx: AllocationContext, part: Part, pin: string): string {
  return netOfPin(ctx.pinNets, part.id, pin)?.net ?? `__floating:${part.id}.${pin}`;
}

function candidateGroupAllowed(ctx: AllocationContext, pins: Record<string, HoleId>, part: Part): boolean {
  const localGroups = new Map<string, string>();
  for (const [pin, hole] of Object.entries(pins)) {
    if (!isValidHole(ctx.profile, hole)) return false;
    if (ctx.occupied.has(hole)) return false;
    const group = contactGroup(ctx.profile, hole);
    if (group === null) return false;
    const net = pinNetOrFloating(ctx, part, pin);
    const existing = ctx.groups.get(group);
    if (existing !== undefined && existing !== net) return false;
    const local = localGroups.get(group);
    if (local !== undefined && local !== net) return false;
    localGroups.set(group, net);
  }
  return true;
}

function putPlacement(ctx: AllocationContext, part: Part, candidate: Candidate): void {
  if (!candidateGroupAllowed(ctx, candidate.pins, part)) {
    throw new Error(`Internal allocator error: ${part.id} candidate became occupied`);
  }
  for (const [pin, hole] of Object.entries(candidate.pins)) {
    const net = pinNetOrFloating(ctx, part, pin);
    ctx.occupied.set(hole, `${part.id}.${pin}`);
    const group = contactGroup(ctx.profile, hole);
    if (group !== null) ctx.groups.set(group, net);
  }
  ctx.placements.push({ part: part.id, pins: { ...candidate.pins } });
}

function candidatePins(part: Part, side: Side, row: number, columnOffset: number): Candidate | undefined {
  const footprint = MODULES[part.module].footprint;
  const columns = sideColumns(side);
  const column = columns[columnOffset];
  if (column === undefined) return undefined;

  if (footprint.kind === "two-lead") {
    const span = footprint.preferredSpan;
    return {
      side,
      start: row,
      end: row + span,
      pins: { [footprint.pins[0]]: `${column}${row}`, [footprint.pins[1]]: `${column}${row + span}` },
    };
  }
  if (footprint.kind === "inline3") {
    const pins: Record<string, HoleId> = {};
    footprint.pins.forEach((pin, index) => {
      pins[pin] = `${column}${row + index}`;
    });
    return { side, start: row, end: row + 2, pins };
  }
  if (footprint.kind === "generic-inline") {
    const pins: Record<string, HoleId> = {};
    modulePins(part).forEach((pin, index) => {
      pins[pin.id] = `${column}${row + index}`;
    });
    return { side, start: row, end: row + Math.max(0, modulePins(part).length - 1), pins };
  }
  // A four-pin button has its specified orientation: e/f at row r and r+2.
  return {
    side: "left",
    start: row,
    end: row + 2,
    pins: { "1": `e${row}`, "2": `f${row}`, "3": `e${row + 2}`, "4": `f${row + 2}` },
  };
}

function footprintHeight(part: Part): number {
  const footprint = MODULES[part.module].footprint;
  if (footprint.kind === "two-lead") return footprint.preferredSpan;
  if (footprint.kind === "inline3") return 2;
  if (footprint.kind === "generic-inline") return Math.max(0, modulePins(part).length - 1);
  return 2;
}

function placeParts(ctx: AllocationContext): void {
  const sideEnd: Record<Side, number> = { left: 0, right: 0 };
  const parts = [...ctx.circuit.parts].sort((a, b) => a.id.localeCompare(b.id));
  for (const part of parts) {
    const footprint = MODULES[part.module].footprint;
    const candidates: Candidate[] = [];
    const sides: Side[] = footprint.kind === "button4" ? ["left"] : ["left", "right"];
    for (const side of sides) {
      const minimum = footprint.kind === "button4" ? Math.max(sideEnd.left, sideEnd.right) + 1 : sideEnd[side] + 1;
      for (let row = minimum; row <= ctx.profile.rows; row++) {
        for (let column = 0; column < sideColumns(side).length; column++) {
          const candidate = candidatePins(part, side, row, column);
          if (!candidate || candidate.end > ctx.profile.rows) continue;
          if (candidateGroupAllowed(ctx, candidate.pins, part)) candidates.push(candidate);
        }
      }
    }
    candidates.sort((a, b) => a.start - b.start || (a.side === b.side ? 0 : a.side === "left" ? -1 : 1) || a.end - b.end);
    const candidate = candidates[0];
    if (!candidate) {
      const height = footprintHeight(part) + 2;
      throw new Error(
        `Cannot fit ${part.id} (${MODULES[part.module].name}) on ${ctx.profile.id}: no legal ${height}-row footprint remains; try bb-830 or remove a part`,
      );
    }
    putPlacement(ctx, part, candidate);
    if (footprint.kind === "button4") {
      sideEnd.left = candidate.end + 1;
      sideEnd.right = candidate.end + 1;
    } else {
      sideEnd[candidate.side] = candidate.end + 1;
    }
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
    const existing = ctx.occupied.get(hole);
    if (existing !== undefined) throw new Error(`Cannot fit Nano header at ${hole}: hole is already occupied`);
    ctx.occupied.set(hole, `board.${pin}`);
    const group = contactGroup(ctx.profile, hole);
    if (group !== null) ctx.groups.set(group, "__board");
    if (!ctx.nanoPinHoles.has(pin)) ctx.nanoPinHoles.set(pin, hole);
  });
}

function chooseSignalStrips(ctx: AllocationContext): Map<NetId, HoleId> {
  const strips = new Map<NetId, HoleId>();
  const usedGroups = new Set<string>();
  const signals = ctx.circuit.nets.filter((net) => net.kind === "signal").sort((a, b) => a.id.localeCompare(b.id));
  const candidates: { row: number; side: Side; group: string; hole: HoleId }[] = [];
  for (let row = 1; row <= ctx.profile.rows; row++) {
    for (const side of ["left", "right"] as const) {
      const group = contactGroup(ctx.profile, rowHole(side, row));
      if (group === null) continue;
      const owner = ctx.groups.get(group);
      if (owner === "__board") continue;
      candidates.push({ row, side, group, hole: rowHole(side, row, side === "left" ? 4 : 4) });
    }
  }
  for (const net of signals) {
    const candidate = candidates.find((entry) => {
      if (usedGroups.has(entry.group)) return false;
      const owner = ctx.groups.get(entry.group);
      return owner === undefined || owner === net.id;
    });
    if (!candidate) {
      throw new Error(
        `Cannot fit ${net.id}: need one five-hole signal strip but ${ctx.profile.id} has no unoccupied contact group; try bb-830`,
      );
    }
    usedGroups.add(candidate.group);
    strips.set(net.id, candidate.hole);
    ctx.groups.set(candidate.group, net.id);
  }
  return strips;
}

function addJumper(
  jumpers: Jumper[],
  seen: Set<string>,
  from: Endpoint,
  to: Endpoint,
  net: NetId,
  color: WireColor,
): void {
  if (endpointKey(from) === endpointKey(to)) return;
  const key = `${net}|${endpointKey(from)}|${endpointKey(to)}`;
  const reverse = `${net}|${endpointKey(to)}|${endpointKey(from)}`;
  if (seen.has(key) || seen.has(reverse)) return;
  seen.add(key);
  jumpers.push({ id: "", from, to, color, net });
}

function holeGroup(profile: BreadboardProfile, hole: HoleId): string | undefined {
  return contactGroup(profile, hole) ?? undefined;
}

function shouldBridge(profile: BreadboardProfile, from: HoleId, to: HoleId): boolean {
  const a = holeGroup(profile, from);
  const b = holeGroup(profile, to);
  return a === undefined || b === undefined || a !== b;
}

function makeJumpers(ctx: AllocationContext, strips: Map<NetId, HoleId>): Jumper[] {
  const jumpers: Jumper[] = [];
  const seen = new Set<string>();
  const signalOrder = new Map<string, number>();
  [...ctx.circuit.nets]
    .filter((net) => net.kind === "signal")
    .sort((a, b) => a.id.localeCompare(b.id))
    .forEach((net, index) => signalOrder.set(net.id, index));

  const anchors = new Map<NetId, HoleId>();
  for (const net of ctx.circuit.nets) {
    if (net.kind === "power") anchors.set(net.id, firstRailHole(ctx.profile, "T+"));
    else if (net.kind === "ground") anchors.set(net.id, firstRailHole(ctx.profile, "T-"));
    else {
      const strip = strips.get(net.id);
      if (strip === undefined) throw new Error(`Internal allocator error: no strip for ${net.id}`);
      anchors.set(net.id, strip);
    }
  }

  const colorFor = (net: NetId): WireColor => {
    const kind = ctx.netKinds.get(net) ?? "signal";
    return netColor(net, kind, signalOrder.get(net) ?? 0);
  };

  const board = BOARD_PROFILES[ctx.circuit.board.profile];
  const usedBoardPins = ctx.circuit.nets
    .flatMap((net) => net.pins.filter((ref) => ref.part === BOARD_PART).map((ref) => ({ net, ref })))
    .sort((a, b) => a.ref.pin.localeCompare(b.ref.pin) || a.net.id.localeCompare(b.net.id));

  // Rail jumpers are emitted first so the guide can make the safe rail check a
  // first-class operation.  A Nano has a physical header hole in addition to
  // the wire to the rail; an Uno starts at its external header.
  for (const { net, ref } of usedBoardPins) {
    const anchor = anchors.get(net.id);
    if (anchor === undefined) continue;
    if (board.placement === "straddle") {
      const headerHole = ctx.nanoPinHoles.get(ref.pin);
      if (headerHole === undefined) {
        throw new Error(`Nano header has no hole for board pin ${ref.pin}`);
      }
      addJumper(jumpers, seen, { board: ref.pin }, { hole: headerHole }, net.id, colorFor(net.id));
      if (shouldBridge(ctx.profile, headerHole, anchor)) {
        addJumper(jumpers, seen, { hole: headerHole }, { hole: anchor }, net.id, colorFor(net.id));
      }
    } else {
      addJumper(jumpers, seen, { board: ref.pin }, { hole: anchor }, net.id, colorFor(net.id));
    }
  }

  const placements = new Map(ctx.placements.map((placement) => [placement.part, placement]));
  for (const part of [...ctx.circuit.parts].sort((a, b) => a.id.localeCompare(b.id))) {
    const placement = placements.get(part.id);
    if (!placement) continue;
    for (const pin of modulePins(part).map((entry) => entry.id).sort((a, b) => a.localeCompare(b))) {
      const net = netOfPin(ctx.pinNets, part.id, pin);
      if (!net) continue;
      const hole = placement.pins[pin];
      const anchor = anchors.get(net.net);
      if (!hole || !anchor) continue;
      if (shouldBridge(ctx.profile, hole, anchor)) {
        addJumper(jumpers, seen, { hole }, { hole: anchor }, net.net, colorFor(net.net));
      }
    }
  }

  const rank = (jumper: Jumper): [number, string, string, string] => {
    const kind = ctx.netKinds.get(jumper.net) ?? "signal";
    const phase = kind === "power" ? 0 : kind === "ground" ? 1 : 2;
    return [phase, jumper.net, endpointKey(jumper.from), endpointKey(jumper.to)];
  };
  jumpers.sort((a, b) => {
    const ar = rank(a);
    const br = rank(b);
    for (let i = 0; i < ar.length; i++) {
      const cmp = String(ar[i]).localeCompare(String(br[i]));
      if (cmp !== 0) return cmp;
    }
    return 0;
  });
  jumpers.forEach((jumper, index) => (jumper.id = `W${index + 1}`));
  return jumpers;
}

export function layoutBoard(circuit: Circuit): Layout {
  const profile = BREADBOARD_PROFILES[circuit.breadboard.profile];
  if (!profile) throw new Error(`Unknown breadboard profile ${circuit.breadboard.profile}`);
  const board = BOARD_PROFILES[circuit.board.profile];
  if (!board) throw new Error(`Unknown board profile ${circuit.board.profile}`);
  const { pinNets, netKinds } = buildPinNets(circuit);
  const ctx: AllocationContext = {
    circuit,
    profile,
    pinNets,
    netKinds,
    placements: [],
    occupied: new Map(),
    groups: new Map(),
    nanoPinHoles: new Map(),
  };
  reserveNano(ctx);
  placeParts(ctx);
  const strips = chooseSignalStrips(ctx);
  const jumpers = makeJumpers(ctx, strips);
  return {
    schema: "vibread.layout/1",
    board: circuit.board.profile,
    breadboard: circuit.breadboard.profile,
    placements: ctx.placements.sort((a, b) => a.part.localeCompare(b.part)),
    jumpers,
    ...(ctx.boardAnchor ? { boardAnchor: ctx.boardAnchor } : {}),
  };
}

export function layoutHash(layout: Layout): string {
  return hashJson(layout);
}

export function layoutPinNet(circuit: Circuit): Map<string, InternalPinNet> {
  return buildPinNets(circuit).pinNets;
}

export function breadboardSideColumns(side: Side): readonly Column[] {
  return sideColumns(side);
}

export function railAnchor(profile: BreadboardProfile, kind: "power" | "ground"): HoleId {
  return firstRailHole(profile, kind === "power" ? "T+" : "T-");
}

export function endpointHoleId(endpoint: Endpoint): HoleId | undefined {
  return endpointHole(endpoint);
}

export function signalColor(index: number): string {
  return SIGNAL_COLORS[index % SIGNAL_COLORS.length];
}
