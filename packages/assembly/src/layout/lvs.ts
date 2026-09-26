import {
  BOARD_PART,
  BOARD_PROFILES,
  BREADBOARD_PROFILES,
  MODULES,
  boardPin,
  contactGroup,
  isValidHole,
  modulePins,
  pinKey,
  type Circuit,
  type DerivedNet,
  type HoleId,
  type Layout,
  type LvsIssue,
  type LvsResult,
  type Net,
  type PinRef,
} from "@vibread/core";


type NodeId = string;


class UnionFind {
  private readonly parent = new Map<NodeId, NodeId>();
  private readonly rank = new Map<NodeId, number>();

  add(id: NodeId): void {
    if (this.parent.has(id)) return;
    this.parent.set(id, id);
    this.rank.set(id, 0);
  }

  find(id: NodeId): NodeId {
    const parent = this.parent.get(id);
    if (parent === undefined) {
      this.add(id);
      return id;
    }
    if (parent === id) return id;
    const root = this.find(parent);
    this.parent.set(id, root);
    return root;
  }

  union(a: NodeId, b: NodeId): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;
    const rankA = this.rank.get(ra) ?? 0;
    const rankB = this.rank.get(rb) ?? 0;
    if (rankA < rankB) this.parent.set(ra, rb);
    else if (rankA > rankB) this.parent.set(rb, ra);
    else {
      this.parent.set(rb, ra);
      this.rank.set(ra, rankA + 1);
    }
  }
}

function boardNode(pin: string): NodeId {
  return `b:${pin}`;
}

function pinNode(ref: PinRef): NodeId {
  return `p:${pinKey(ref)}`;
}

function holeNode(hole: HoleId): NodeId {
  return `h:${hole}`;
}

function groupNode(group: string): NodeId {
  return `g:${group}`;
}

function asIssue(kind: LvsIssue["kind"], message: string, refs: Partial<Pick<LvsIssue, "nets" | "pins" | "holes">> = {}): LvsIssue {
  return { kind, severity: "error", message, ...refs };
}

function refSort(a: PinRef, b: PinRef): number {
  return pinKey(a).localeCompare(pinKey(b));
}

function netKindMap(circuit: Circuit): Map<string, Net["kind"]> {
  const kinds = new Map<string, Net["kind"]>();
  for (const net of circuit.nets) kinds.set(net.id, net.kind);
  return kinds;
}

function directNetMap(circuit: Circuit): Map<string, string> {
  const map = new Map<string, string>();
  for (const net of circuit.nets) {
    for (const ref of net.pins) map.set(pinKey(ref), net.id);
  }
  return map;
}

function expectedPinNets(circuit: Circuit): Map<string, string> {
  const direct = directNetMap(circuit);
  for (const part of circuit.parts) {
    const groups = MODULES[part.module].internallyConnected ?? [];
    for (const group of groups) {
      const known = group.map((pin) => direct.get(`${part.id}.${pin}`)).filter((net): net is string => net !== undefined);
      if (known.length === 0) continue;
      const first = known[0];
      for (const pin of group) direct.set(`${part.id}.${pin}`, first);
    }
  }
  return direct;
}

function placementMap(layout: Layout): Map<string, Layout["placements"][number]> {
  return new Map(layout.placements.map((placement) => [placement.part, placement]));
}


function addAllContactGroups(uf: UnionFind, profile: typeof BREADBOARD_PROFILES["bb-830"]): void {
  // The profile is small (at most 630 terminal holes plus rails), and including
  // every group makes a mutant moved into an otherwise empty strip observable.
  for (let row = 1; row <= profile.rows; row++) {
    for (const column of ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"] as const) {
      const hole = `${column}${row}`;
      const group = contactGroup(profile, hole);
      if (group === null) continue;
      uf.add(holeNode(hole));
      uf.add(groupNode(group));
      uf.union(holeNode(hole), groupNode(group));
    }
  }
  for (const rail of ["T+", "T-", "B+", "B-"] as const) {
    for (const position of profile.railPositions) {
      const hole = `${rail}${position}`;
      const group = contactGroup(profile, hole);
      if (group === null) continue;
      uf.add(holeNode(hole));
      uf.add(groupNode(group));
      uf.union(holeNode(hole), groupNode(group));
    }
  }
}

function addPartPins(uf: UnionFind, circuit: Circuit): Map<string, PinRef> {
  const refs = new Map<string, PinRef>();
  for (const part of circuit.parts) {
    for (const pin of modulePins(part)) {
      const ref = { part: part.id, pin: pin.id } satisfies PinRef;
      const key = pinKey(ref);
      refs.set(key, ref);
      uf.add(pinNode(ref));
    }
  }
  return refs;
}

function addBoardPins(uf: UnionFind, circuit: Circuit): Map<string, PinRef> {
  const refs = new Map<string, PinRef>();
  for (const net of circuit.nets) {
    for (const ref of net.pins) {
      if (ref.part !== BOARD_PART) continue;
      const key = pinKey(ref);
      if (refs.has(key)) continue;
      refs.set(key, ref);
      uf.add(boardNode(ref.pin));
    }
  }
  return refs;
}

function validatePlacements(
  circuit: Circuit,
  layout: Layout,
  profile: typeof BREADBOARD_PROFILES["bb-830"],
  issues: LvsIssue[],
  uf: UnionFind,
  refs: Map<string, PinRef>,
  occupiedPinHoles: Map<string, string>,
): void {
  const byPart = placementMap(layout);
  for (const part of circuit.parts) {
    const placement = byPart.get(part.id);
    if (!placement) {
      issues.push(asIssue("unplaced-part", `Part ${part.id} has no placement in the layout.`, { pins: modulePins(part).map((pin) => `${part.id}.${pin.id}`) }));
      continue;
    }
    for (const pin of modulePins(part)) {
      const ref = { part: part.id, pin: pin.id } satisfies PinRef;
      refs.set(pinKey(ref), ref);
      const hole = placement.pins[pin.id];
      if (!hole) {
        issues.push(asIssue("unplaced-part", `Part ${part.id} is missing a hole for pin ${pin.id}.`, { pins: [pinKey(ref)] }));
        continue;
      }
      if (!isValidHole(profile, hole)) {
        issues.push(asIssue("invalid-hole", `${part.id}.${pin.id} uses invalid hole ${hole}.`, { pins: [pinKey(ref)], holes: [hole] }));
        continue;
      }
      const prior = occupiedPinHoles.get(hole);
      if (prior !== undefined) {
        issues.push(asIssue("duplicate-hole", `Hole ${hole} is occupied by both ${prior} and ${pinKey(ref)}.`, { pins: [prior, pinKey(ref)], holes: [hole] }));
      } else occupiedPinHoles.set(hole, pinKey(ref));
      uf.union(pinNode(ref), holeNode(hole));
    }
  }
}

function addInternalConnections(uf: UnionFind, circuit: Circuit): void {
  for (const part of circuit.parts) {
    for (const group of MODULES[part.module].internallyConnected ?? []) {
      const first = group[0];
      if (!first) continue;
      for (const pin of group.slice(1)) uf.union(pinNode({ part: part.id, pin: first }), pinNode({ part: part.id, pin }));
    }
  }
}

function addJumpers(
  uf: UnionFind,
  circuit: Circuit,
  layout: Layout,
  profile: typeof BREADBOARD_PROFILES["bb-830"],
  issues: LvsIssue[],
): void {
  const boardProfile = BOARD_PROFILES[circuit.board.profile];
  for (const jumper of layout.jumpers) {
    const fromValid = "board" in jumper.from ? boardPin(boardProfile, jumper.from.board) !== undefined : isValidHole(profile, jumper.from.hole);
    const toValid = "board" in jumper.to ? boardPin(boardProfile, jumper.to.board) !== undefined : isValidHole(profile, jumper.to.hole);
    const holes = [
      ...("hole" in jumper.from ? [jumper.from.hole] : []),
      ...("hole" in jumper.to ? [jumper.to.hole] : []),
    ];
    if (!fromValid || !toValid) {
      issues.push(asIssue("invalid-hole", `Jumper ${jumper.id} has an invalid endpoint.`, { holes }));
      continue;
    }
    const from = "board" in jumper.from ? boardNode(jumper.from.board) : holeNode(jumper.from.hole);
    const to = "board" in jumper.to ? boardNode(jumper.to.board) : holeNode(jumper.to.hole);
    uf.union(from, to);
  }
}

function derivedNets(
  uf: UnionFind,
  refs: Map<string, PinRef>,
  layout: Layout,
  profile: typeof BREADBOARD_PROFILES["bb-830"],
): { nets: DerivedNet[]; rootByPin: Map<string, string> } {
  const roots = new Map<string, { refs: PinRef[]; holes: HoleId[]; first: string }>();
  const rootByPin = new Map<string, string>();
  const allRefs = [...refs.values()].sort(refSort);
  for (const ref of allRefs) {
    const root = uf.find(ref.part === BOARD_PART ? boardNode(ref.pin) : pinNode(ref));
    rootByPin.set(pinKey(ref), root);
    const entry = roots.get(root) ?? { refs: [], holes: [], first: pinKey(ref) };
    entry.refs.push(ref);
    roots.set(root, entry);
  }
  const occupied = new Set<string>();
  for (const placement of layout.placements) {
    for (const hole of Object.values(placement.pins)) occupied.add(hole);
  }
  for (const jumper of layout.jumpers) {
    if ("hole" in jumper.from) occupied.add(jumper.from.hole);
    if ("hole" in jumper.to) occupied.add(jumper.to.hole);
  }
  for (const hole of [...occupied].sort()) {
    if (!isValidHole(profile, hole)) continue;
    const root = uf.find(holeNode(hole));
    const entry = roots.get(root) ?? { refs: [], holes: [], first: `hole:${hole}` };
    entry.holes.push(hole);
    roots.set(root, entry);
  }
  const ordered = [...roots.entries()].sort((a, b) => a[1].first.localeCompare(b[1].first));
  const idByRoot = new Map<string, string>();
  const nets: DerivedNet[] = [];
  for (const [root, entry] of ordered) {
    const id = `dn-${nets.length}`;
    idByRoot.set(root, id);
    entry.refs.sort(refSort);
    entry.holes.sort();
    nets.push({ id, members: entry.refs, holes: entry.holes });
  }
  for (const [key, root] of rootByPin) rootByPin.set(key, idByRoot.get(root) ?? "");
  return { nets, rootByPin };
}

function compareToIr(
  circuit: Circuit,
  derived: DerivedNet[],
  rootByPin: Map<string, string>,
  issues: LvsIssue[],
): Record<string, string> {
  const expected = expectedPinNets(circuit);
  const netKinds = netKindMap(circuit);
  const netMap: Record<string, string> = {};
  for (const net of circuit.nets) {
    const refs = net.pins.map(pinKey).concat(
      [...expected.entries()].filter((entry) => entry[1] === net.id).map((entry) => entry[0]).filter((key) => !net.pins.some((ref) => pinKey(ref) === key)),
    );
    const ids = [...new Set(refs.map((key) => rootByPin.get(key)).filter((id): id is string => Boolean(id)))];
    if (ids.length === 0) {
      issues.push(asIssue("missing-connection", `Net ${net.id} has no physical members.`, { nets: [net.id], pins: refs }));
      continue;
    }
    if (ids.length > 1) {
      const holes = ids.flatMap((id) => {
        const derivedNet = derived.find((candidate) => candidate.id === id);
        return derivedNet?.holes ?? [];
      });
      issues.push(asIssue("split-net", `Net ${net.id} is split across ${ids.length} physical groups.`, { nets: [net.id], pins: refs, holes }));
    } else {
      netMap[net.id] = ids[0];
    }
    const missing = refs.filter((key) => !rootByPin.has(key));
    if (missing.length > 0) issues.push(asIssue("missing-connection", `Net ${net.id} is missing ${missing.join(", ")}.`, { nets: [net.id], pins: missing }));
  }

  for (const candidate of derived) {
    const netIds = new Set<string>();
    for (const ref of candidate.members) {
      const id = directNetMap(circuit).get(pinKey(ref));
      if (id !== undefined) netIds.add(id);
    }
    if (netIds.size > 1) {
      const ids = [...netIds].sort();
      issues.push(asIssue("merged-nets", `Physical group ${candidate.id} merges nets ${ids.join(", ")}.`, { nets: ids, pins: candidate.members.map(pinKey), holes: candidate.holes }));
      const kinds = new Set(ids.map((id) => netKinds.get(id)));
      if (kinds.has("power") && kinds.has("ground")) {
        issues.push(asIssue("power-short", `Physical group ${candidate.id} bridges 5 V and GND.`, { nets: ids, pins: candidate.members.map(pinKey), holes: candidate.holes }));
      }
    }
  }
  return netMap;
}

function findFloatingPins(circuit: Circuit, derived: DerivedNet[], issues: LvsIssue[]): void {
  const expected = expectedPinNets(circuit);
  const singletonPins = new Set<string>();
  for (const candidate of derived) {
    if (candidate.members.length < 2) {
      for (const ref of candidate.members) singletonPins.add(pinKey(ref));
    }
  }
  for (const part of circuit.parts) {
    for (const pin of modulePins(part)) {
      const key = `${part.id}.${pin.id}`;
      // A declared net that is physically isolated is already reported as a
      // split/missing connection. Reserve floating-pin for a genuinely
      // un-netted module pin, which keeps mutant diagnostics specific.
      if (singletonPins.has(key) && !expected.has(key)) {
        // The IR itself leaves this pin unconnected (validateCircuit warns about it), so it is not a wiring error.
        issues.push({ ...asIssue("floating-pin", `${key} is not connected to another pin, board header, or jumper.`, { pins: [key] }), severity: "warning" });
      }
    }
  }
}

export function lvs(circuit: Circuit, layout: Layout): LvsResult {
  const profile = BREADBOARD_PROFILES[layout.breadboard];
  if (!profile) {
    return {
      ok: false,
      derivedNets: [],
      issues: [asIssue("invalid-hole", `Unknown breadboard profile ${layout.breadboard}.`)],
      netMap: {},
    };
  }
  const issues: LvsIssue[] = [];
  const uf = new UnionFind();
  addAllContactGroups(uf, profile);
  const refs = addPartPins(uf, circuit);
  const boardRefs = addBoardPins(uf, circuit);
  for (const [key, ref] of boardRefs) refs.set(key, ref);
  const occupiedPinHoles = new Map<string, string>();
  validatePlacements(circuit, layout, profile, issues, uf, refs, occupiedPinHoles);
  addInternalConnections(uf, circuit);
  addJumpers(uf, circuit, layout, profile, issues);
  const derived = derivedNets(uf, refs, layout, profile);
  const netMap = compareToIr(circuit, derived.nets, derived.rootByPin, issues);
  return { ok: issues.every((issue) => issue.severity !== "error"), derivedNets: derived.nets, issues, netMap };
}

function inferDerivedKind(circuit: Circuit, members: PinRef[]): Net["kind"] {
  const kinds = netKindMap(circuit);
  const direct = directNetMap(circuit);
  const memberKinds = members.map((ref) => kinds.get(direct.get(pinKey(ref)) ?? "")).filter((kind): kind is Net["kind"] => kind !== undefined);
  if (memberKinds.includes("ground")) return "ground";
  if (memberKinds.includes("power")) return "power";
  return "signal";
}

export function asBuiltCircuit(circuit: Circuit, layout: Layout): Circuit {
  const result = lvs(circuit, layout);
  const nets: Net[] = result.derivedNets.map((derived) => ({
    id: derived.id,
    kind: inferDerivedKind(circuit, derived.members),
    pins: derived.members,
  }));
  return { ...circuit, nets };
}

export function lvsIssueKinds(result: LvsResult): string[] {
  return [...new Set(result.issues.map((issue) => issue.kind))].sort();
}
