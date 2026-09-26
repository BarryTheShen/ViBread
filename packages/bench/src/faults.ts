import { asBuiltCircuit, layoutHash } from "@vibread/assembly/layout";
import {
  BREADBOARD_PROFILES,
  MODULES,
  contactGroup,
  parseHole,
  type BenchRunResult,
  type Circuit,
  type DeviceLine,
  type Endpoint,
  type SelfTestPlan,
  type Layout,
} from "@vibread/core";
import { LineDecoder } from "./serial.js";
// The simulator is an optional dictionary backend; keep the catalog/import path browser-safe without loading it.

export const FAULT_IDS = [
  "button-leg-in-gnd-row",
  "button-rotated-90",
  "led-jumpers-swapped",
  "led-reversed",
  "led-missing",
  "divider-resistor-missing",
  "output-jumper-in-rail-row",
  "wrong-resistor-value",
  "moved-lead",
  "missing-jumper",
] as const;
export type FaultId = (typeof FAULT_IDS)[number];

export interface FaultDefinition {
  id: FaultId;
  title: string;
  description: string;
  fix: string;
}

export const FAULTS: readonly FaultDefinition[] = [
  { id: "button-leg-in-gnd-row", title: "Button leg in a GND row", description: "Move the button signal leg and its jumper into the GND contact group.", fix: "Move the button signal leg and jumper back to the highlighted signal row." },
  { id: "button-rotated-90", title: "Button rotated 90 degrees", description: "Rotate the four-leg button so its internal pairs no longer match the intended rows.", fix: "Rotate the button back across the breadboard center gap." },
  { id: "led-jumpers-swapped", title: "Two LED signal jumpers swapped", description: "Swap two LED signal jumper endpoints while leaving their Arduino net labels unchanged.", fix: "Swap the highlighted LED jumpers back to their matching lights." },
  { id: "led-reversed", title: "LED reversed", description: "Swap the anode and cathode holes of one LED.", fix: "Turn the highlighted LED around so its long leg faces the resistor." },
  { id: "led-missing", title: "LED missing", description: "Remove one LED placement from the built layout.", fix: "Insert the highlighted LED in the shown holes." },
  { id: "divider-resistor-missing", title: "Photoresistor divider resistor missing", description: "Remove the resistor that forms the light-sensor divider.", fix: "Add the highlighted divider resistor between the sensor row and GND." },
  { id: "output-jumper-in-rail-row", title: "Output jumper in a rail row", description: "Move an output jumper endpoint into the 5 V rail.", fix: "Move the output jumper out of the rail and into its signal row." },
  { id: "wrong-resistor-value", title: "Wrong resistor value", description: "Change one resistor value by a factor of ten.", fix: "Replace the highlighted resistor with the value shown in the design." },
  { id: "moved-lead", title: "Part lead moved one row", description: "Move one component lead one breadboard row away.", fix: "Move the highlighted lead back to its numbered row." },
  { id: "missing-jumper", title: "Jumper missing", description: "Remove one signal jumper from the build.", fix: "Reconnect the highlighted jumper between the board and signal row." },
];

export interface ApplyFaultInput {
  circuit: Circuit;
  layout: Layout;
  fault: FaultId;
  params?: { part?: string; pin?: string; jumper?: string };
}

export interface AppliedFault {
  layout: Layout;
  circuit: Circuit;
  description: string;
}

function definition(id: FaultId): FaultDefinition {
  const found = FAULTS.find((fault) => fault.id === id);
  if (found === undefined) throw new Error(`Unknown fault ${id}`);
  return found;
}

function endpointHole(endpoint: Endpoint | undefined): string | undefined {
  if (endpoint === undefined) return undefined;
  return "hole" in endpoint ? endpoint.hole : undefined;
}

function setJumperHole(jumper: Layout["jumpers"][number], hole: string): void {
  if ("board" in jumper.from) jumper.to = { hole };
  else jumper.from = { hole };
}

function partPlacement(layout: Layout, part: string): Layout["placements"][number] | undefined {
  return layout.placements.find((placement) => placement.part === part);
}

function partByModule(circuit: Circuit, module: string, requested?: string): string | undefined {
  if (requested !== undefined && circuit.parts.some((part) => part.id === requested && part.module === module)) return requested;
  return circuit.parts.find((part) => part.module === module)?.id;
}

function netForBoardPin(circuit: Circuit, pin: string): string | undefined {
  return circuit.nets.find((net) => net.pins.some((ref) => ref.part === "board" && ref.pin === pin))?.id;
}

function partPinOnNet(circuit: Circuit, part: string, net: string): string | undefined {
  return circuit.nets.find((entry) => entry.id === net)?.pins.find((ref) => ref.part === part)?.pin;
}

function roleForPart(circuit: Circuit, part: string): { pin: string; net: string } | undefined {
  const role = circuit.roles.find((candidate) => candidate.part === part);
  if (role === undefined) return undefined;
  const net = netForBoardPin(circuit, role.pin);
  return net === undefined ? undefined : { pin: role.pin, net };
}

function signalJumper(circuit: Circuit, layout: Layout, part: string): Layout["jumpers"][number] | undefined {
  const role = roleForPart(circuit, part);
  return role === undefined ? undefined : layout.jumpers.find((jumper) => jumper.net === role.net);
}
function poweredRailHole(circuit: Circuit, layout: Layout): string | undefined {
  const preferredKinds: Array<"power" | "ground"> = ["power", "ground"];
  for (const kind of preferredKinds) {
    const netIds = new Set(circuit.nets.filter((net) => net.kind === kind).map((net) => net.id));
    for (const jumper of layout.jumpers) {
      if (!netIds.has(jumper.net)) continue;
      for (const endpoint of [jumper.from, jumper.to]) {
        const hole = endpointHole(endpoint);
        if (hole !== undefined && parseHole(hole)?.kind === "rail") return hole;
      }
    }
  }
  return undefined;
}

function firstTerminalHole(layout: Layout, preferredGroups: Set<string> = new Set()): string | undefined {
  const profile = BREADBOARD_PROFILES[layout.breadboard];
  for (const placement of layout.placements) {
    for (const hole of Object.values(placement.pins)) {
      const parsed = parseHole(hole);
      const group = contactGroup(profile, hole);
      if (parsed?.kind === "terminal" && (preferredGroups.size === 0 || (group !== null && preferredGroups.has(group)))) return hole;
    }
  }
  return undefined;
}

function groundTarget(circuit: Circuit, layout: Layout, button: string): string | undefined {
  const groundNet = circuit.nets.find((net) => net.kind === "ground" && net.pins.some((ref) => ref.part === button));
  if (groundNet === undefined) return firstTerminalHole(layout);
  const groundHoles = new Set<string>();
  const placement = partPlacement(layout, button);
  for (const ref of groundNet.pins.filter((pin) => pin.part === button)) {
    const hole = placement?.pins[ref.pin];
    if (hole !== undefined) groundHoles.add(hole);
  }
  const profile = BREADBOARD_PROFILES[layout.breadboard];
  const groups = new Set([...groundHoles].map((hole) => contactGroup(profile, hole)).filter((group): group is string => group !== null));
  for (const jumper of layout.jumpers.filter((candidate) => candidate.net === groundNet.id)) {
    for (const hole of [endpointHole(jumper.from), endpointHole(jumper.to)]) {
      if (hole !== undefined && parseHole(hole)?.kind === "terminal" && groups.has(contactGroup(profile, hole) ?? "")) return hole;
    }
  }
  return firstTerminalHole(layout, groups);
}

function ledParts(circuit: Circuit, layout: Layout): string[] {
  return circuit.parts.filter((part) => part.module === "led" && partPlacement(layout, part.id) !== undefined).map((part) => part.id);
}

function finishFault(circuit: Circuit, layout: Layout, id: FaultId): AppliedFault {
  const built = asBuiltCircuit(circuit, layout);
  return { layout, circuit: built, description: definition(id).description };
}

export function applyFault(input: ApplyFaultInput): AppliedFault {
  const layout = structuredClone(input.layout);
  const circuit = structuredClone(input.circuit);
  const requestedPart = input.params?.part;
  const requestedJumper = input.params?.jumper;
  switch (input.fault) {
    case "button-leg-in-gnd-row": {
      const button = partByModule(circuit, "button", requestedPart);
      if (button === undefined) throw new Error("button fault requires a button");
      const role = roleForPart(circuit, button);
      const target = groundTarget(circuit, layout, button);
      const placement = partPlacement(layout, button);
      const jumper = role === undefined ? undefined : layout.jumpers.find((candidate) => candidate.net === role.net);
      const signalPin = role === undefined ? undefined : partPinOnNet(circuit, button, role.net);
      if (target === undefined || placement === undefined || signalPin === undefined || jumper === undefined) throw new Error("button fault requires placed signal and ground wiring");
      placement.pins[signalPin] = target;
      setJumperHole(jumper, target);
      break;
    }
    case "button-rotated-90": {
      const button = partByModule(circuit, "button", requestedPart);
      const placement = button === undefined ? undefined : partPlacement(layout, button);
      if (placement === undefined) throw new Error("button rotation requires a placed button");
      const old = { ...placement.pins };
      if (old["1"] === undefined || old["2"] === undefined || old["3"] === undefined || old["4"] === undefined) throw new Error("button rotation requires four pins");
      placement.pins = { "1": old["2"], "2": old["4"], "3": old["1"], "4": old["3"] };
      break;
    }
    case "led-jumpers-swapped": {
      const jumpers = ledParts(circuit, layout).map((part) => signalJumper(circuit, layout, part)).filter((jumper): jumper is Layout["jumpers"][number] => jumper !== undefined);
      if (jumpers.length < 2) throw new Error("LED jumper fault requires two LED signal jumpers");
      const endpoint = jumpers[0].to;
      jumpers[0].to = jumpers[1].to;
      jumpers[1].to = endpoint;
      break;
    }
    case "led-reversed": {
      const led = partByModule(circuit, "led", requestedPart);
      const placement = led === undefined ? undefined : partPlacement(layout, led);
      if (placement?.pins.A === undefined || placement.pins.K === undefined) throw new Error("LED reversal requires an A/K placement");
      const endpoint = placement.pins.A;
      placement.pins.A = placement.pins.K;
      placement.pins.K = endpoint;
      break;
    }
    case "led-missing": {
      const led = partByModule(circuit, "led", requestedPart);
      if (led === undefined) throw new Error("LED missing fault requires an LED");
      layout.placements = layout.placements.filter((placement) => placement.part !== led);
      break;
    }
    case "divider-resistor-missing": {
      const light = partByModule(circuit, "photoresistor", requestedPart);
      const role = light === undefined ? undefined : roleForPart(circuit, light);
      const resistor = role === undefined ? undefined : circuit.parts.find((part) => part.module === "resistor" && circuit.nets.some((net) => net.id === role.net && net.pins.some((ref) => ref.part === part.id)));
      if (resistor === undefined) throw new Error("divider fault requires a photoresistor partner resistor");
      layout.placements = layout.placements.filter((placement) => placement.part !== resistor.id);
      break;
    }
    case "output-jumper-in-rail-row": {
      const output = circuit.parts.find((part) => (part.module === "led" || part.module === "buzzer-active" || part.module === "buzzer-passive") && partPlacement(layout, part.id) !== undefined);
      const jumper = requestedJumper === undefined
        ? output === undefined ? undefined : signalJumper(circuit, layout, output.id)
        : layout.jumpers.find((candidate) => candidate.id === requestedJumper);
      const railHole = poweredRailHole(circuit, layout);
      if (jumper === undefined || railHole === undefined) throw new Error("output rail fault is not applicable: no powered rail exists in this layout");
      setJumperHole(jumper, railHole);
      break;
    }
    case "wrong-resistor-value": {
      const resistor = circuit.parts.find((part) => part.module === "resistor" && (requestedPart === undefined || part.id === requestedPart));
      if (resistor === undefined) throw new Error("wrong resistor fault requires a resistor");
      const ohms = typeof resistor.params.ohms === "number" ? resistor.params.ohms : 220;
      resistor.params = { ...resistor.params, ohms: ohms * 10 };
      break;
    }
    case "moved-lead": {
      const candidates = layout.placements.flatMap((placement) => Object.entries(placement.pins).map(([pin, hole]) => ({ placement, pin, hole })));
      const selected = candidates.find((candidate) => (input.params?.part === undefined || candidate.placement.part === input.params.part) && (input.params?.pin === undefined || candidate.pin === input.params.pin));
      if (selected === undefined) throw new Error("moved lead fault requires a placed part");
      const parsed = parseHole(selected.hole);
      if (parsed?.kind !== "terminal") throw new Error("moved lead fault requires a terminal hole");
      const profile = BREADBOARD_PROFILES[layout.breadboard];
      const row = parsed.row < profile.rows ? parsed.row + 1 : parsed.row - 1;
      selected.placement.pins[selected.pin] = `${parsed.column}${row}`;
      break;
    }
    case "missing-jumper": {
      const index = layout.jumpers.findIndex((jumper) => requestedJumper === undefined ? jumper.net !== "5V" && jumper.net !== "GND" : jumper.id === requestedJumper);
      if (index < 0) throw new Error("missing jumper fault requires a signal jumper");
      layout.jumpers.splice(index, 1);
      break;
    }
  }
  return finishFault(circuit, layout, input.fault);
}

function highlightDiff(base: Layout, mutant: Layout, fault: FaultId, circuit: Circuit): { holes: string[]; parts: string[]; jumpers: string[] } {
  const holes = new Set<string>();
  const parts = new Set<string>();
  const jumpers = new Set<string>();
  const baseParts = new Map(base.placements.map((placement) => [placement.part, placement]));
  const mutantParts = new Map(mutant.placements.map((placement) => [placement.part, placement]));
  for (const [part, placement] of baseParts) {
    const next = mutantParts.get(part);
    if (next === undefined) {
      parts.add(part);
      for (const hole of Object.values(placement.pins)) holes.add(hole);
      continue;
    }
    for (const [pin, hole] of Object.entries(placement.pins)) if (next.pins[pin] !== hole) {
      parts.add(part);
      holes.add(hole);
      if (next.pins[pin] !== undefined) holes.add(next.pins[pin]);
    }
  }
  const baseJumpers = new Map(base.jumpers.map((jumper) => [jumper.id, jumper]));
  const mutantJumpers = new Map(mutant.jumpers.map((jumper) => [jumper.id, jumper]));
  for (const [id, jumper] of baseJumpers) {
    const next = mutantJumpers.get(id);
    if (next === undefined || JSON.stringify(next.from) !== JSON.stringify(jumper.from) || JSON.stringify(next.to) !== JSON.stringify(jumper.to)) {
      jumpers.add(id);
    }
  }
  if (fault === "missing-jumper") {
    const light = circuit.parts.find((part) => part.module === "photoresistor");
    const role = light === undefined ? undefined : roleForPart(circuit, light.id);
    if (light !== undefined) {
      parts.add(light.id);
      const placement = baseParts.get(light.id);
      if (placement !== undefined) for (const hole of Object.values(placement.pins)) holes.add(hole);
    }
    if (role !== undefined) {
      for (const resistor of circuit.parts.filter((part) => part.module === "resistor" && circuit.nets.some((net) => net.id === role.net && net.pins.some((ref) => ref.part === part.id)))) {
        parts.add(resistor.id);
        const placement = baseParts.get(resistor.id);
        if (placement !== undefined) for (const hole of Object.values(placement.pins)) holes.add(hole);
      }
    }
  }
  if (holes.size === 0 && parts.size === 0) {
    const fallbackPart = fault === "wrong-resistor-value" ? circuit.parts.find((part) => part.module === "resistor")?.id : undefined;
    if (fallbackPart !== undefined) parts.add(fallbackPart);
  }
  return { holes: [...holes], parts: [...parts], jumpers: [...jumpers] };
}

function ruleLikelihood(fault: FaultId, observed: BenchRunResult): number {
  const direct = observed.diagnosis.candidates.find((candidate) => candidate.cause === fault);
  if (direct !== undefined) return Math.min(0.99, 0.6 + direct.likelihood * 0.4);
  if (fault === "missing-jumper" && observed.results.some((result) => result.test === "light.relative" && result.status === "fail")) return 0.72;
  const family = fault.startsWith("led-") && observed.diagnosis.candidates.some((candidate) => candidate.cause.startsWith("led-"));
  if (family) return 0.25;
  return 0.02;
}

function signatureAgreement(predicted: BenchRunResult, observed: BenchRunResult): number {
  if (predicted.verdict !== observed.verdict) return 0;
  const predictedByTest = new Map(predicted.results.map((result) => [result.test, result.status]));
  const observedByTest = new Map(observed.results.map((result) => [result.test, result.status]));
  const tests = new Set([...predictedByTest.keys(), ...observedByTest.keys()]);
  let matched = 0;
  let total = 0;
  for (const test of tests) {
    const predictedStatus = predictedByTest.get(test) ?? "unknown";
    const observedStatus = observedByTest.get(test) ?? "unknown";
    if (predictedStatus === "pass" && observedStatus === "pass") continue;
    total += 1;
    if (predictedStatus === observedStatus) matched += 1;
  }
  return total === 0 ? 0 : matched / total;
}

function candidateForFault(fault: FaultDefinition, likelihood: number, highlight: { holes: string[]; parts: string[]; jumpers: string[] }): BenchRunResult["diagnosis"]["candidates"][number] {
  return { cause: fault.id, title: fault.title, likelihood: Math.max(0, Math.min(1, likelihood)), highlight, fix: fault.fix };
}

export interface FaultDictionaryEntry {
  fault: FaultId;
  layoutHash: string;
  description: string;
  layout: Layout;
  circuit: Circuit;
  lines: DeviceLine[];
  answers: Record<string, string>;
  result: BenchRunResult;
}

export interface FaultDictionary {
  layoutHash: string;
  design: string;
  entries: FaultDictionaryEntry[];
}

export function rankFaults(input: {
  circuit: Circuit;
  layout: Layout;
  plan: SelfTestPlan;
  observed: BenchRunResult;
  lines: DeviceLine[];
  dictionary?: FaultDictionary;
}): BenchRunResult["diagnosis"]["candidates"] {
  if (input.observed.verdict === "pass" && input.dictionary === undefined) return [];
  const definitions = input.dictionary?.entries.map((entry) => definition(entry.fault)) ?? [...FAULTS];
  const entries = input.dictionary?.entries ?? [];
  const ranked = definitions.map((fault) => {
    const dictionaryEntry = entries.find((entry) => entry.fault === fault.id);
    let likelihood = ruleLikelihood(fault.id, input.observed);
    let mutantLayout = input.layout;
    if (dictionaryEntry !== undefined) {
      const agreement = signatureAgreement(dictionaryEntry.result, input.observed);
      const dictionaryLikelihood = dictionaryEntry.result.verdict !== input.observed.verdict ? 0.05 : agreement === 0 ? 0.1 : 0.35 + 0.6 * agreement;
      likelihood = Math.max(likelihood, (likelihood + dictionaryLikelihood) / 2);
      mutantLayout = dictionaryEntry.layout;
    } else {
      try {
        mutantLayout = applyFault({ circuit: input.circuit, layout: input.layout, fault: fault.id }).layout;
      } catch {
        likelihood = 0;
      }
    }
    return { fault, likelihood, highlight: highlightDiff(input.layout, mutantLayout, fault.id, input.circuit) };
  });
  ranked.sort((left, right) => right.likelihood - left.likelihood || left.fault.id.localeCompare(right.fault.id));
  return ranked.filter((entry) => entry.likelihood > 0).map((entry) => candidateForFault(entry.fault, entry.likelihood, entry.highlight));
}




interface SimSessionLike {
  onSerial(callback: (text: string) => void): () => void;
  serialWrite(text: string): void;
  run(ms: number): void;
  setDigital(part: string, value: boolean): void;
  setLight(part: string, value: number): void;
  setAnalog(part: string, value: number): void;
  partState(part: string): number;
}
type SimSessionConstructor = new (opts: { circuit: Circuit; hex: string; light: Record<string, number> }) => SimSessionLike;


const dictionaryCache = new Map<string, Promise<FaultDictionary>>();

export async function buildFaultDictionary(input: { circuit: Circuit; layout: Layout; plan: SelfTestPlan; hex: string; faults?: FaultId[]; maxFaults?: number }): Promise<FaultDictionary> {
  const key = `${layoutHash(input.layout)}:${input.plan.design}:${input.faults?.join(",") ?? "all"}`;
  const cached = dictionaryCache.get(key);
  if (cached !== undefined) return cached;
  const promise = (async () => {
    // evaluateRun imports this catalog to merge dictionary candidates; defer the reciprocal import to break that ESM cycle.
    const selected = (input.faults ?? FAULT_IDS).slice(0, Math.min(input.maxFaults ?? 40, 40));
    const { evaluateRun } = await import("./evaluate.js");
    // This optional backend is loaded only when callers explicitly precompute a dictionary.
    const { SimSession } = await import("@vibread/sim/browser");
    const entries: FaultDictionaryEntry[] = [];
    for (const fault of selected) {
      let applied: AppliedFault;
      try {
        applied = applyFault({ circuit: input.circuit, layout: input.layout, fault });
      } catch {
        continue;
      }
      const run = await runWithSession(SimSession, applied.circuit, input.plan, input.hex);
      const result = await evaluateRun({ circuit: input.circuit, layout: applied.layout, plan: input.plan, lines: run.lines, answers: run.answers, kind: "selftest", revision: 1, runId: `fault-${fault}` });
      entries.push({ fault, layoutHash: layoutHash(applied.layout), description: applied.description, layout: applied.layout, circuit: applied.circuit, lines: run.lines, answers: run.answers, result });
    }
    return { layoutHash: layoutHash(input.layout), design: input.plan.design, entries };
  })();
  dictionaryCache.set(key, promise);
  return promise;
}
async function runWithSession(Session: SimSessionConstructor, circuit: Circuit, plan: SelfTestPlan, hex: string): Promise<{ lines: DeviceLine[]; answers: Record<string, string> }> {
  const session = new Session({ circuit, hex, light: { LDR1: 0.8 } });
  const decoder = new LineDecoder();
  const lines: DeviceLine[] = [];
  const answers: Record<string, string> = {};
  const answered = new Set<string>();
  const pendingAsks: Array<Extract<DeviceLine, { t: "ask" }>> = [];
  let done = false;
  session.onSerial((chunk) => {
    for (const decoded of decoder.push(chunk)) if (decoded.t !== "invalid") {
      lines.push(decoded);
      if (decoded.t === "ask") pendingAsks.push(decoded);
      if (decoded.t === "done") done = true;
    }
  });
  const answerPending = (): void => {
    while (pendingAsks.length > 0) {
      const ask = pendingAsks.shift();
      if (ask === undefined || answered.has(ask.id)) continue;
      if (ask.id.endsWith("-press")) session.setDigital(ask.part ?? "BTN1", true);
      if (ask.id.endsWith("-release")) session.setDigital(ask.part ?? "BTN1", false);
      if (ask.id.endsWith("-cover")) session.setLight(ask.part ?? "LDR1", 0.05);
      if (ask.id.endsWith("-uncover")) session.setLight(ask.part ?? "LDR1", 0.8);
      if (ask.id.startsWith("pot") && ask.id.endsWith("-min")) session.setAnalog(ask.part ?? "POT1", 0);
      if (ask.id.startsWith("pot") && ask.id.endsWith("-max")) session.setAnalog(ask.part ?? "POT1", 1);
      let value = "done";
      if (ask.kind === "which-led") {
        const leds = plan.subjects.filter((subject): subject is Extract<SelfTestPlan["subjects"][number], { kind: "led" }> => subject.kind === "led");
        let brightest = leds[0];
        let brightness = 0;
        for (let attempt = 0; attempt < 12; attempt += 1) {
          session.run(plan.timing.ledOnMs);
          for (const subject of leds) {
            const value = session.partState(subject.part);
            if (value > brightness) {
              brightness = value;
              brightest = subject;
            }
          }
          if (brightness > 0.02) break;
        }
        value = brightest === undefined || brightness <= 0.02 ? "none" : String(brightest.order);
      }
      if (ask.kind === "heard-beep") {
        let heard = false;
        for (let attempt = 0; attempt < 12; attempt += 1) {
          session.run(20);
          if (session.partState(ask.part ?? "BZ1") > 0) {
            heard = true;
            break;
          }
        }
        value = heard ? "yes" : "no";
      }
      answers[ask.id] = value;
      session.serialWrite(`${JSON.stringify({ c: "answer", id: ask.id, v: value })}\n`);
      answered.add(ask.id);
    }
  };
  session.run(100);
  session.serialWrite('{"c":"run","test":"all"}\n');
  for (let slice = 0; slice < 200 && !done; slice += 1) {
    session.run(50);
    answerPending();
  }
  if (!done) throw new Error("fault dictionary virtual bench did not finish within its bounded run window");
  return { lines, answers };
}

