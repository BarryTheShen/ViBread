import {
  MODULES,
  type Circuit,
  type Net,
  type Part,
  type PinRef,
  type SelfTestPlan,
  type SelfTestSubject,
  type TestId,
  pinKey,
  shortHash,
} from "@vibread/core";

const TEST_ORDER: TestId[] = ["rails.vcc", "pins.readonly"];

interface NetIndex {
  byPin: Map<string, string>;
  byId: Map<string, Net>;
}

function indexNets(circuit: Circuit): NetIndex {
  const byPin = new Map<string, string>();
  const byId = new Map<string, Net>();
  for (const net of circuit.nets) {
    byId.set(net.id, net);
    for (const ref of net.pins) byPin.set(pinKey(ref), net.id);
  }
  return { byPin, byId };
}

function partFor(circuit: Circuit, id: string): Part | undefined {
  return circuit.parts.find((part) => part.id === id);
}


/**
 * Follow only passive resistor links from a pin until a power/ground net is
 * found.  This is deliberately a small topology query rather than an
 * electrical simulator: it answers the two orientation questions needed by
 * the safe self-test plan.
 */
function railAtOtherSide(circuit: Circuit, index: NetIndex, start: PinRef): "power" | "ground" | undefined {
  const startNetId = index.byPin.get(pinKey(start));
  if (startNetId === undefined) return undefined;

  const visited = new Set<string>();
  const queue: string[] = [startNetId];
  while (queue.length > 0) {
    const netId = queue.shift();
    if (netId === undefined || visited.has(netId)) continue;
    visited.add(netId);
    const net = index.byId.get(netId);
    if (net === undefined) continue;
    if (net.kind === "power") return "power";
    if (net.kind === "ground") return "ground";

    for (const ref of net.pins) {
      const part = partFor(circuit, ref.part);
      if (part?.module !== "resistor") continue;
      const otherPin = ref.pin === "1" ? "2" : "1";
      const otherNet = index.byPin.get(pinKey({ part: ref.part, pin: otherPin }));
      if (otherNet !== undefined) queue.push(otherNet);
    }
  }
  return undefined;
}

function ledSideDistance(circuit: Circuit, index: NetIndex, start: PinRef, target: PinRef): number | undefined {
  const startNetId = index.byPin.get(pinKey(start));
  if (startNetId === undefined) return undefined;
  const visited = new Set<string>();
  const queue: Array<{ netId: string; distance: number }> = [{ netId: startNetId, distance: 0 }];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined || visited.has(current.netId)) continue;
    visited.add(current.netId);
    const net = index.byId.get(current.netId);
    if (net === undefined) continue;
    if (net.pins.some((ref) => ref.part === target.part && ref.pin === target.pin)) return current.distance;

    for (const ref of net.pins) {
      const part = partFor(circuit, ref.part);
      if (part?.module !== "resistor") continue;
      const otherPin = ref.pin === "1" ? "2" : "1";
      const otherNet = index.byPin.get(pinKey({ part: ref.part, pin: otherPin }));
      if (otherNet !== undefined && !visited.has(otherNet)) {
        queue.push({ netId: otherNet, distance: current.distance + 1 });
      }
    }
  }
  return undefined;
}

function ledActiveHigh(circuit: Circuit, index: NetIndex, rolePin: string, part: Part): boolean {
  const anode = { part: part.id, pin: "A" };
  const cathode = { part: part.id, pin: "K" };
  const anodeDistance = ledSideDistance(circuit, index, { part: "board", pin: rolePin }, anode);
  const cathodeDistance = ledSideDistance(circuit, index, { part: "board", pin: rolePin }, cathode);
  if (anodeDistance === undefined && cathodeDistance === undefined) return true;
  if (anodeDistance === undefined) return false;
  if (cathodeDistance === undefined) return true;
  return anodeDistance <= cathodeDistance;
}

function lightBrighterReadsHigher(circuit: Circuit, index: NetIndex, rolePin: string, part: Part): boolean {
  const modulePins = MODULES[part.module].pins;
  const signalPin = modulePins[0]?.id;
  const otherPin = modulePins[1]?.id;
  if (signalPin === undefined || otherPin === undefined) return true;

  const roleNet = index.byId.get(index.byPin.get(pinKey({ part: "board", pin: rolePin })) ?? "");
  const firstNet = index.byId.get(index.byPin.get(pinKey({ part: part.id, pin: signalPin })) ?? "");
  const secondNet = index.byId.get(index.byPin.get(pinKey({ part: part.id, pin: otherPin })) ?? "");
  const sensorSignalNet = roleNet?.pins.some((ref) => ref.part === part.id && ref.pin === signalPin)
    ? firstNet
    : roleNet?.pins.some((ref) => ref.part === part.id && ref.pin === otherPin)
      ? secondNet
      : firstNet;
  const sensorOther = sensorSignalNet?.id === firstNet?.id ? { part: part.id, pin: otherPin } : { part: part.id, pin: signalPin };
  return railAtOtherSide(circuit, index, sensorOther) !== "ground";
}

function labelFor(part: Part, purpose: string): string {
  return part.label ?? purpose ?? MODULES[part.module].name;
}

function applicableTests(subjects: SelfTestSubject[]): TestId[] {
  const tests = [...TEST_ORDER];
  const has = (kind: SelfTestSubject["kind"]): boolean => subjects.some((subject) => subject.kind === kind);
  if (has("button")) tests.push("button.interactive");
  if (has("light")) tests.push("light.relative");
  if (has("pot")) tests.push("pot.sweep");
  if (has("led")) tests.push("led.sequence");
  if (has("buzzer")) tests.push("buzzer.confirm");
  return tests;
}

export function planSelfTest(circuit: Circuit, revisionHash: string): SelfTestPlan {
  const index = indexNets(circuit);
  const ledOrder = new Map(
    circuit.parts.filter((part) => part.module === "led").map((part, position) => [part.id, position + 1]),
  );
  const subjects: SelfTestSubject[] = [];

  for (const role of circuit.roles) {
    const part = partFor(circuit, role.part);
    if (part === undefined) continue;
    const kind = MODULES[part.module].selftest;
    if (kind === null) continue;
    const label = labelFor(part, role.purpose);
    switch (kind) {
      case "led":
        subjects.push({
          kind,
          part: part.id,
          pin: role.pin,
          label,
          activeHigh: ledActiveHigh(circuit, index, role.pin, part),
          order: ledOrder.get(part.id) ?? subjects.filter((subject) => subject.kind === "led").length + 1,
        });
        break;
      case "button":
        subjects.push({
          kind,
          part: part.id,
          pin: role.pin,
          label,
          pressedLevel: role.mode === "INPUT_PULLUP" ? 0 : 1,
          pull: role.mode === "INPUT_PULLUP" ? "internal-up" : "external",
        });
        break;
      case "light":
        subjects.push({
          kind,
          part: part.id,
          pin: role.pin,
          label,
          brighterReadsHigher: lightBrighterReadsHigher(circuit, index, role.pin, part),
        });
        break;
      case "pot":
        subjects.push({ kind, part: part.id, pin: role.pin, label });
        break;
      case "buzzer":
        subjects.push({ kind, part: part.id, pin: role.pin, label, active: part.module === "buzzer-active" });
        break;
      case "digital-in":
      case "analog-in":
        subjects.push({ kind, part: part.id, pin: role.pin, label });
        break;
    }
  }

  return {
    schema: "vibread.selftest/1",
    design: shortHash(revisionHash),
    board: circuit.board.profile,
    subjects,
    tests: applicableTests(subjects),
    timing: {
      ledOnMs: 5,
      ledPeriodMs: 50,
      ledPulses: 20,
      promptTimeoutMs: 20_000,
      samples: 32,
    },
  };
}
