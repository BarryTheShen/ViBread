import {
  BREADBOARD_PROFILES,
  MODULES,
  isRailBridge,
  powerRails,
  formatOhms,
  parseHole,
  partVisual,
  resistorBands,
  type Circuit,
  type Jumper,
  type Layout,
  type Part,
  type RepeatCopy,
  type Step,
  type StepLandmark,
  type StepList,
  type TestId,
  type WireEnd,
} from "@vibread/core";

import { layoutHash } from "./allocator.js";
import { aWire } from "./colors.js";
import { earlierItems, headerLandmark, holeLandmark, legName, type Earlier } from "./landmarks.js";
import { repeatQuality } from "./quality.js";
import { findUnits, repeatedUnits, type Unit } from "./units.js";

function endpointText(endpoint: Jumper["from"]): string {
  if ("board" in endpoint) return `Arduino pin ${endpoint.board}`;
  if (/^[TB]-/.test(endpoint.hole)) return `hole ${endpoint.hole} on the blue − rail (GND)`;
  if (/^[TB]\+/.test(endpoint.hole)) return `hole ${endpoint.hole} on the red + rail (5 V)`;
  return `hole ${endpoint.hole}`;
}

/** "short, spans 2 holes" / "long, reaches the Arduino": a rough length for picking a wire out of the kit. */
function wireLength(jumper: Jumper): string {
  if ("board" in jumper.from || "board" in jumper.to) return "long, reaches the Arduino";
  const [a, b] = [parseHole(jumper.from.hole), parseHole(jumper.to.hole)];
  if (!a || !b) return "";
  const col = (hole: NonNullable<typeof a>) => (hole.kind === "terminal" ? hole.row : hole.position);
  const row = (hole: NonNullable<typeof a>) => (hole.kind === "terminal" ? "abcdefghij".indexOf(hole.column) + 2 : hole.rail.startsWith("T") ? (hole.rail === "T-" ? 0 : 1) : 13);
  const span = Math.max(Math.abs(col(a) - col(b)), Math.abs(row(a) - row(b)));
  return `${span <= 4 ? "short" : span <= 15 ? "medium" : "long"}, spans ${span} hole${span === 1 ? "" : "s"}`;
}

function partById(circuit: Circuit): Map<string, Part> {
  return new Map(circuit.parts.map((part) => [part.id, part]));
}

type InventoryGroup = { part: Part; count: number };

function inventoryGroups(circuit: Circuit): InventoryGroup[] {
  const groups = new Map<string, InventoryGroup>();
  for (const part of [...circuit.parts].sort((a, b) => a.id.localeCompare(b.id))) {
    const params = Object.entries(part.params).sort(([a], [b]) => a.localeCompare(b));
    const key = `${part.module}:${JSON.stringify(params)}`;
    const existing = groups.get(key);
    if (existing) existing.count += 1;
    else groups.set(key, { part, count: 1 });
  }
  return [...groups.values()];
}

function partCallout(part: Part): string {
  if (part.module === "resistor") {
    const ohms = Number(part.params.ohms);
    const tolerance = Number(part.params.tolerancePct ?? 5);
    const bands = resistorBands(ohms, tolerance).join("-");
    return `1× ${formatOhms(ohms)} resistor — ${bands}`;
  }
  if (part.module === "led") {
    const color = typeof part.params.color === "string" ? part.params.color : "red";
    return `1× ${color} LED — anode (+, long leg) and cathode (−, short leg)`;
  }
  if (part.module === "button") return "1× 4-leg push button — align the body over the centre channel";
  if (part.module === "photoresistor") return "1× photoresistor — either direction; keep its face visible";
  if (part.module === "potentiometer") return "1× potentiometer — outer legs A/B, middle leg W";
  if (part.module === "buzzer-active") return "1× active buzzer — + long leg, − short leg";
  if (part.module === "buzzer-passive") return "1× passive buzzer — + leg, − leg";
  return `1× ${MODULES[part.module].name}`;
}

/** "220 Ω resistor R1 (red-red-brown-gold)", "red LED LED1", "push button BTN1". */
function partName(part: Part): string {
  if (part.module === "resistor") {
    const ohms = Number(part.params.ohms);
    return `${formatOhms(ohms)} resistor ${part.id} (${resistorBands(ohms, Number(part.params.tolerancePct ?? 5)).join("-")})`;
  }
  // "yellow LED LED1", or with a catalogue variant "yellow 3 mm LED LED1".
  if (part.module === "led") return `${typeof part.params.color === "string" ? part.params.color : "red"} ${partVisual(part).name} ${part.id}`;
  return `${partVisual(part).name.toLowerCase()} ${part.id}`;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * One placement step: each leg (named the way the parts panel names it) and its hole, with one landmark after the leg
 * it describes. Look-alike legs ("either way round") are listed as holes only.
 */
function placementText(circuit: Circuit, part: Part, layout: Layout, earlier: Earlier[]): { text: string; holes: string[]; landmarks: StepLandmark[] } {
  const placement = layout.placements.find((entry) => entry.part === part.id);
  if (!placement) return { text: `No placement was generated for ${part.id}.`, holes: [], landmarks: [] };
  const visual = partVisual(part);
  const legs = visual.legs.filter((leg) => placement.pins[leg.pin] !== undefined);
  // The strongest landmark over all legs: same strip beats across-the-channel beats nearby.
  const rank = { "same-strip": 0, "across-channel": 1, near: 2, header: 3 } as const;
  const found = legs.flatMap((leg) => {
    const landmark = holeLandmark(layout, placement.pins[leg.pin]!, earlier);
    return landmark ? [{ leg, landmark }] : [];
  }).sort((a, b) => rank[a.landmark.kind] - rank[b.landmark.kind])[0];
  const where = (hole: string) => `hole ${hole}${found && found.landmark.kind !== "header" && found.landmark.hole === hole ? `, ${found.landmark.text}` : ""}`;
  const holes = legs.map((leg) => placement.pins[leg.pin]!);
  const name = capitalize(partName(part));
  let text: string;
  if (!visual.polarized && legs.length === 2 && legs.every((leg) => leg.length === "equal")) {
    text = `${name}, either way round: one leg in ${where(holes[0]!)}; the other in ${where(holes[1]!)}.`;
  } else if (visual.joined && visual.straddlesChannel) {
    const pairs = visual.joined.map((pair) => `legs ${pair.join("–")} in holes ${pair.map((pin) => placement.pins[pin]).filter(Boolean).map((hole) => (found?.landmark.kind !== "header" && found?.landmark.hole === hole ? `${hole} (${found.landmark.text})` : hole)).join(" and ")}`);
    text = `${name} goes across the centre channel: ${pairs.join("; ")}.`;
  } else {
    // "long leg (+, …)" from the panel's leg names, so the words match the picture.
    const legText = (leg: (typeof legs)[number]) => {
      const sign = /^[+−]/.exec(leg.label)?.[0];
      const flat = leg.howToTell?.includes("flat side") ? ", flat side" : "";
      return sign && !leg.short.includes(sign) ? `${leg.short} (${sign}${flat})` : leg.short;
    };
    text = `${name}: ${legs.map((leg) => `${legText(leg)} in ${where(placement.pins[leg.pin]!)}`).join("; ")}.`;
  }
  return { text, holes, landmarks: found ? [found.landmark] : [] };
}

/** One wire step: colour and length, then both ends by badge number, each with a landmark when there is one. */
function jumperText(layout: Layout, jumper: Jumper, color: string, earlier: Earlier[]): { text: string; landmarks: StepLandmark[]; ends: [WireEnd, WireEnd] } {
  const landmarks: StepLandmark[] = [];
  const describe = (end: Jumper["from"], n: 1 | 2): WireEnd => {
    const landmark = "board" in end ? headerLandmark(layout, end.board) : holeLandmark(layout, end.hole, earlier);
    if (landmark) landmarks.push(landmark);
    return { n, at: "board" in end ? `board:${end.board}` : end.hole, text: `${endpointText(end)}${landmark ? ` (${landmark.text})` : ""}` };
  };
  const ends: [WireEnd, WireEnd] = [describe(jumper.from, 1), describe(jumper.to, 2)];
  const length = wireLength(jumper);
  return { text: `${capitalize(aWire(color))}${length ? `, ${length}` : ""}. End 1: ${ends[0].text}. End 2: ${ends[1].text}.`, landmarks, ends };
}

function countedCallout(group: InventoryGroup): string {
  const single = partCallout(group.part);
  return `${group.count}×${single.slice(2)}`;
}

function inventoryText(circuit: Circuit): string {
  const groups = inventoryGroups(circuit);
  const buttons = groups.filter((group) => group.part.module === "button");
  const sensors = groups.filter((group) => group.part.module === "photoresistor");
  const leds = groups.filter((group) => group.part.module === "led");
  const resistors = groups.filter((group) => group.part.module === "resistor");
  const other = groups.filter((group) => !["button", "photoresistor", "led", "resistor"].includes(group.part.module));
  const items: string[] = [];
  for (const group of buttons) items.push(`${group.count} push button${group.count === 1 ? "" : "s"}`);
  for (const group of sensors) items.push(`${group.count} light sensor${group.count === 1 ? "" : "s"}`);
  for (const group of leds) {
    const color = typeof group.part.params.color === "string" ? group.part.params.color : "red";
    items.push(`${group.count} ${color} LED${group.count === 1 ? "" : "s"}`);
  }
  if (resistors.length > 0) {
    const total = resistors.reduce((sum, group) => sum + group.count, 0);
    const values = resistors.map((group) => `${group.count}× ${formatOhms(Number(group.part.params.ohms))}`).join(", ");
    items.push(`${total} resistor${total === 1 ? "" : "s"} (${values})`);
  }
  for (const group of other) items.push(`${group.count} ${MODULES[group.part.module].name.toLowerCase()}${group.count === 1 ? "" : "s"}`);
  return `Find these parts: ${items.join(", ")}. Do not connect USB yet.`;
}

function inventoryCallouts(circuit: Circuit): string[] {
  return inventoryGroups(circuit).map(countedCallout);
}

function orientationText(layout: Layout): string {
  const profile = BREADBOARD_PROFILES[layout.breadboard];
  const board = layout.board.includes("nano")
    ? "the Nano across its centre channel"
    : layout.boardOrientation === "usb-right"
      ? "the Uno below it, its USB socket on the right, so the power/analog header is the row nearest the breadboard and the digital pins run D0 … D13 left to right behind it"
      : "the Uno below it, its USB socket on the left, so the digital header is the row nearest the breadboard (D13 … D0 left to right)";
  const rails = powerRails(profile);
  const railText = !rails
    ? "This board has no power rails."
    : `${rails.plus.startsWith("T") ? "Top" : "Bottom"} rails: ${rails.plus} 5 V (red), ${rails.minus} GND (blue).${profile.railsSplit ? ` Each rail is split in the middle, after column ${profile.railSplitAfter}.` : ""}`;
  return `Your ${profile.shortName} with ${board}. Columns 1–${profile.rows} run left to right; rows a–e are above the centre channel, f–j below. The 5 holes of one column on one side are joined (a strip). Hole a14 = row a, column 14. ${railText}`;
}

/** Arduino header → rail wires and split-rail bridges: the first things built, before any part. */
function railJumpers(layout: Layout): Jumper[] {
  const profile = BREADBOARD_PROFILES[layout.breadboard];
  const onRail = (endpoint: Jumper["from"]) => "hole" in endpoint && /^[TB][+-]/.test(endpoint.hole);
  return layout.jumpers.filter((jumper) => ("board" in jumper.from && onRail(jumper.to)) || ("board" in jumper.to && onRail(jumper.from)) || isRailBridge(profile, jumper));
}

/** "Join the two halves of the + rail with a short red wire across the gap at T+30–T+32." */
function bridgeText(jumper: Jumper, color: string): string {
  const from = "hole" in jumper.from ? jumper.from.hole : "";
  const to = "hole" in jumper.to ? jumper.to.hole : "";
  return `Join the two halves of the ${from.includes("+") ? "+" : "−"} rail with a short ${color} wire across the gap: end 1 in hole ${from}, end 2 in hole ${to}.`;
}

function testsForSubsection(circuit: Circuit): TestId[] {
  const tests = new Set<TestId>(["net.continuity"]);
  if (circuit.parts.some((part) => part.module === "button")) tests.add("button.interactive");
  if (circuit.parts.some((part) => part.module === "photoresistor")) tests.add("light.relative");
  if (circuit.parts.some((part) => part.module === "potentiometer")) tests.add("pot.sweep");
  if (circuit.parts.some((part) => part.module === "led")) tests.add("led.sequence");
  if (circuit.parts.some((part) => part.module.startsWith("buzzer"))) tests.add("buzzer.confirm");
  return [...tests];
}

interface RepeatPlan {
  /** "light unit", "button unit", "button + light unit". */
  name: string;
  columns: number;
  copies: Omit<RepeatCopy, "index" | "text">[];
}

/** Every hole a copy uses: its parts' legs and its wires' breadboard ends. */
function copyHoles(layout: Layout, parts: string[], jumpers: string[]): string[] {
  return [
    ...parts.flatMap((id) => Object.values(layout.placements.find((entry) => entry.part === id)?.pins ?? {})),
    ...jumpers.flatMap((id) => {
      const jumper = layout.jumpers.find((entry) => entry.id === id)!;
      return [jumper.from, jumper.to].flatMap((end) => ("hole" in end ? [end.hole] : []));
    }),
  ];
}

function holeColumn(hole: string): number {
  const parsed = parseHole(hole);
  return parsed === null ? 0 : parsed.kind === "terminal" ? parsed.row : parsed.position;
}

/**
 * Repeated units the layout built as identical copies, with each copy's own wires (its Arduino wires and any rail wire
 * inside its columns). Only sets whose copies really are identical, parts and wires alike, at one pitch.
 */
function repeatPlans(circuit: Circuit, layout: Layout, rails: Jumper[]): RepeatPlan[] {
  const plans: RepeatPlan[] = [];
  const taken = new Set(rails.map((jumper) => jumper.id));
  for (const set of repeatedUnits(circuit)) {
    const quality = repeatQuality(layout, set);
    if (!quality.regular || quality.pitch === undefined) continue;
    const copies = set.copies.map((copy, index) => {
      const jumpers = [...new Set(copy.units.flatMap((unit) => unitJumpers(layout, unit, taken)))];
      const boardPins = copy.units.map((unit) => unit.boardPin);
      return { parts: copy.parts, jumpers, boardPins, column: quality.columns[index]!, holes: copyHoles(layout, copy.parts, jumpers) };
    });
    // Identical wires too: same count and the same holes relative to the copy's column.
    const shape = (copy: (typeof copies)[number]) => copy.jumpers.map((id) => {
      const jumper = layout.jumpers.find((entry) => entry.id === id)!;
      return [jumper.from, jumper.to].map((end) => ("hole" in end ? `${end.hole.replace(/\d+$/, "")}${holeColumn(end.hole) - copy.column}` : "board")).join(">");
    }).sort().join(" ");
    if (copies.some((copy) => shape(copy) !== shape(copies[0]!))) continue;
    for (const copy of copies) for (const id of copy.jumpers) taken.add(id);
    const modules = [...new Set(set.copies[0]!.units.map((unit) => circuit.parts.find((part) => part.id === unit.members.at(-1)!.part)!.module))];
    const noun = (module: string) => (module === "led" ? "light" : module === "button" ? "button" : module.startsWith("buzzer") ? "buzzer" : MODULES[module as keyof typeof MODULES].name.toLowerCase());
    plans.push({ name: `${modules.map(noun).join(" + ")} unit`, columns: quality.pitch, copies });
  }
  return plans;
}

/** A unit's own wires: its signal and link nets' wires, and rail wires with both ends inside the unit's columns. */
function unitJumpers(layout: Layout, unit: Unit, taken: Set<string>): string[] {
  const nets = new Set([unit.signalNet, ...(unit.linkNet ? [unit.linkNet] : [])]);
  const partHoles = unit.members.flatMap((member) => Object.values(layout.placements.find((entry) => entry.part === member.part)?.pins ?? {}));
  const [from, to] = [Math.min(...partHoles.map(holeColumn)), Math.max(...partHoles.map(holeColumn))];
  return layout.jumpers.filter((jumper) => {
    if (taken.has(jumper.id)) return false;
    if (nets.has(jumper.net)) return true;
    const holes = [jumper.from, jumper.to].flatMap((end) => ("hole" in end ? [end.hole] : []));
    return jumper.net === unit.railNet && holes.length === 2 && holes.every((hole) => holeColumn(hole) >= from && holeColumn(hole) <= to);
  }).map((jumper) => jumper.id);
}

/** Units not built by a repeat step, left to right, each with its own wires (unless another unit's wire is shared). */
function singleUnits(circuit: Circuit, layout: Layout, placedParts: string[], taken: string[]): { parts: string[]; jumpers: string[] }[] {
  const used = new Set(taken);
  const units = findUnits(circuit).filter((unit) => unit.members.every((member) => !placedParts.includes(member.part)));
  const column = (unit: Unit) => Math.min(...unit.members.flatMap((member) => Object.values(layout.placements.find((entry) => entry.part === member.part)?.pins ?? {})).map(holeColumn));
  return units.sort((a, b) => column(a) - column(b)).map((unit) => {
    const jumpers = unitJumpers(layout, unit, used);
    for (const id of jumpers) used.add(id);
    return { parts: unit.members.map((member) => member.part), jumpers };
  });
}

/** "Copy 2 → D6: R4 in holes f38 and e38; LED4 in holes a38 and T-38; a yellow wire from Arduino pin D6 to hole j38." */
function copyText(layout: Layout, copy: Omit<RepeatCopy, "index" | "text">, index: number, colorOf: (jumper: Jumper) => string): string {
  const parts = copy.parts.map((id) => {
    const holes = Object.values(layout.placements.find((entry) => entry.part === id)!.pins);
    return `${id} in holes ${holes.join(" and ")}`;
  });
  const wires = copy.jumpers.map((id) => {
    const jumper = layout.jumpers.find((entry) => entry.id === id)!;
    return `${aWire(colorOf(jumper))} from ${endpointText(jumper.from).replace(/ on the .*$/, "")} to ${endpointText(jumper.to).replace(/ on the .*$/, "")}`;
  });
  return `Copy ${index}${copy.boardPins.length > 0 ? ` → ${copy.boardPins.join(", ")}` : ""}: ${[...parts, ...wires].join("; ")}.`;
}

/**
 * The numbered build. `wireColors` (jumper id → colour, from `jumperColors`) carries the builder's colour choices into
 * the wording; without it each wire uses its suggested colour.
 */
export function buildSteps(circuit: Circuit, layout: Layout, options: { wireColors?: Record<string, string> } = {}): StepList {
  const colorOf = (jumper: Jumper) => options.wireColors?.[jumper.id] ?? jumper.color;
  const steps: Step[] = [];
  const partMap = partById(circuit);
  const push = (step: Omit<Step, "n">): void => {
    steps.push({ ...step, n: steps.length + 1 });
  };

  push({
    kind: "inventory",
    title: "Check the inventory",
    text: inventoryText(circuit),
    plug: "unplugged",
    adds: { parts: [], jumpers: [] },
    holes: [],
    callouts: inventoryCallouts(circuit),
  });
  push({
    kind: "orientation",
    title: "Learn the board orientation",
    text: orientationText(layout),
    plug: "unplugged",
    adds: { parts: [], jumpers: [] },
    holes: [],
    callouts: [],
  });
  // Issue #24: the board itself is checked before anything goes on the breadboard, so a bad cable, a board that won't
  // flash or a board without power shows up now, not after an hour of wiring. The bench flashes its safe firmware
  // (every pin listening, nothing driven) before any test runs.
  push({
    kind: "checkpoint",
    title: "Bare-board check — just the Arduino",
    text: "Before anything goes on the breadboard, check the Arduino on its own. Plug in just the Arduino with the USB cable — no parts, no wires. On the bench: connect it, flash the safe firmware (every pin only listens, nothing is driven), then check the board has power. Unplug it again when the check passes.",
    plug: "plugged",
    adds: { parts: [], jumpers: [] },
    holes: [],
    callouts: ["Only the Arduino and its USB cable — nothing on the breadboard yet"],
    checkpoint: { tests: ["rails.vcc"], text: "The bare Arduino connects, takes the safe firmware and is powered (USB VCC ≈ 5 V)." },
  });
  push({
    kind: "unplug",
    title: "Unplug USB",
    text: "Unplug USB. It stays unplugged whenever you place a part or wire; a checkpoint tells you when to plug in again.",
    plug: "unplugged",
    adds: { parts: [], jumpers: [] },
    holes: [],
    callouts: [],
  });

  const profile = BREADBOARD_PROFILES[layout.breadboard];
  const power = powerRails(profile);
  const rails = railJumpers(layout);
  const onRail = (jumper: Jumper, rail: string | undefined) => rail !== undefined && [jumper.from, jumper.to].some((end) => "hole" in end && end.hole.startsWith(rail));
  const usesPlus = rails.some((jumper) => onRail(jumper, power?.plus));
  const usesMinus = rails.some((jumper) => onRail(jumper, power?.minus));
  const side = power?.plus.startsWith("B") ? "bottom" : "top";
  // Say which rails this build uses, so a picture with one wire is never mistaken for a missing one.
  const railsUsed = usesPlus && usesMinus
    ? `Both ${side} rails are used.`
    : usesMinus
      ? "Only the blue − rail (GND) is used in this build; the red + rail gets no wire."
      : usesPlus
        ? "Only the red + rail (5 V) is used in this build; the blue − rail gets no wire."
        : "";
  const railNames = usesPlus && usesMinus ? "the red + and blue − rails" : usesMinus ? "the blue − rail" : "the red + rail";
  const railEnds: NonNullable<Step["wireEnds"]> = [];
  const railLandmarks: StepLandmark[] = [];
  push({
    kind: "rails",
    title: !power ? "No power rails on this board" : usesPlus && usesMinus ? `Connect the ${side} power rails` : usesMinus ? "Connect the ground rail" : usesPlus ? "Connect the 5 V rail" : "Power rails (not used)",
    text: rails.length > 0
      ? `${railsUsed} ${rails.map((jumper) => {
          const wire = jumperText(layout, jumper, colorOf(jumper), []);
          railEnds.push({ jumper: jumper.id, ends: wire.ends });
          if (isRailBridge(profile, jumper)) return bridgeText(jumper, colorOf(jumper));
          railLandmarks.push(...wire.landmarks);
          return `${capitalize(aWire(colorOf(jumper)))}: ${wire.ends[0].text} → ${wire.ends[1].text}.`;
        }).join(" ")}`
      : !power
        ? `Your ${profile.shortName} has no power rails: 5 V and GND reach their strips with wires later.`
        : "This build does not use the power rails; nothing to connect yet.",
    plug: "unplugged",
    adds: { parts: [], jumpers: rails.map((jumper) => jumper.id) },
    holes: rails.flatMap((jumper) => ["hole" in jumper.from ? jumper.from.hole : "", "hole" in jumper.to ? jumper.to.hole : ""]).filter(Boolean),
    callouts: [],
    ...(railEnds.length > 0 ? { wireEnds: railEnds } : {}),
    ...(railLandmarks.length > 0 ? { landmarks: railLandmarks } : {}),
  });
  // rails.vcc reads the Arduino's own supply (USB VCC), not the breadboard rails: claim only that (issues #14, #18).
  const railTest = rails.length > 0
    ? ` ${railNames[0]!.toUpperCase()}${railNames.slice(1)} ${usesPlus && usesMinus ? "are" : "is"} checked by the part tests that follow; if the board resets or USB drops when you plug in, unplug at once and look for a short between the red + and blue − rails.`
    : "";
  push({
    kind: "checkpoint",
    title: "Power checkpoint — plug in",
    text: `Plug in the USB cable. With the rail wires in, ViBread checks that the board is still powered and responding (USB VCC about 5 V) before any part goes in.${railTest} Unplug again before touching the build.`,
    plug: "plugged",
    adds: { parts: [], jumpers: [] },
    holes: [],
    callouts: [],
    checkpoint: { tests: ["rails.vcc"], text: `Board powered and responding (USB VCC ≈ 5 V).${railTest}` },
  });
  push({
    kind: "unplug",
    title: "Unplug USB before parts",
    text: "Unplug USB again. Never insert or move a part while the circuit is powered.",
    plug: "unplugged",
    adds: { parts: [], jumpers: [] },
    holes: [],
    callouts: [],
  });

  // Parts go in left to right (by their leftmost column), so each one can be placed relative to the ones before it.
  const leftmost = (part: Part) => Math.min(...Object.values(layout.placements.find((entry) => entry.part === part.id)?.pins ?? {}).map((hole) => {
    const parsed = parseHole(hole);
    return parsed?.kind === "terminal" ? parsed.row : 999;
  }), 999);
  const placedParts: string[] = [];
  const placedJumpers: string[] = rails.map((jumper) => jumper.id);
  const colors = Object.fromEntries(layout.jumpers.map((jumper) => [jumper.id, colorOf(jumper)]));

  // Repeated units built as identical copies (issue #25): one step builds the first copy with its wires, the next
  // repeats it for all the others with a per-copy checklist. Copies that aren't regular get individual steps below.
  for (const repeat of repeatPlans(circuit, layout, rails)) {
    const first = repeat.copies[0]!;
    const templateN = steps.length + 1;
    const texts: string[] = [];
    const holes: string[] = [];
    const landmarks: StepLandmark[] = [];
    const wireEnds: NonNullable<Step["wireEnds"]> = [];
    for (const id of first.parts) {
      const placed = placementText(circuit, partMap.get(id)!, layout, earlierItems(circuit, layout, placedParts, placedJumpers, colors));
      placedParts.push(id);
      texts.push(placed.text);
      holes.push(...placed.holes);
      landmarks.push(...placed.landmarks);
    }
    for (const id of first.jumpers) {
      const jumper = layout.jumpers.find((entry) => entry.id === id)!;
      const wire = jumperText(layout, jumper, colorOf(jumper), earlierItems(circuit, layout, placedParts, placedJumpers, colors));
      placedJumpers.push(id);
      texts.push(wire.text);
      holes.push(...[jumper.from, jumper.to].flatMap((end) => ("hole" in end ? [end.hole] : [])));
      landmarks.push(...wire.landmarks);
      wireEnds.push({ jumper: id, ends: wire.ends });
    }
    const unitName = repeat.name;
    const copies = repeat.copies.map((copy, index) => ({ ...copy, index: index + 1, text: copyText(layout, copy, index + 1, colorOf) }));
    const plan = { template: templateN, count: copies.length, columns: repeat.columns, copies };
    push({
      kind: "place",
      title: `Build one ${unitName} (1 of ${copies.length})`,
      text: `One ${unitName}: ${first.parts.join(" + ")} and ${first.jumpers.length === 1 ? "its wire" : "its wires"}. You'll repeat it ${copies.length - 1} more time${copies.length === 2 ? "" : "s"} next. ${texts.join(" ")}`,
      plug: "unplugged",
      adds: { parts: first.parts, jumpers: first.jumpers },
      holes,
      callouts: first.parts.map((id) => partCallout(partMap.get(id)!)),
      ...(landmarks.length > 0 ? { landmarks } : {}),
      ...(wireEnds.length > 0 ? { wireEnds } : {}),
      repeat: { role: "template", ...plan },
    });
    // The other copies, each placed like the one before it, `columns` to the right.
    const rest = copies.slice(1);
    const restLandmarks: StepLandmark[] = rest.flatMap((copy) => {
      const previous = copies[copy.index - 2]!;
      const anchor = copy.parts[0]!;
      const pin = Object.keys(layout.placements.find((entry) => entry.part === anchor)!.pins).sort()[0]!;
      const hole = layout.placements.find((entry) => entry.part === anchor)!.pins[pin]!;
      const refHole = layout.placements.find((entry) => entry.part === previous.parts[0])!.pins[pin]!;
      const text = `${repeat.columns} column${repeat.columns === 1 ? "" : "s"} right of ${previous.parts[0]}'s ${legName(circuit, layout, previous.parts[0]!, pin)}`;
      return [{ kind: "near" as const, hole, ref: { part: previous.parts[0]!, pin, hole: refHole }, columns: repeat.columns, text }];
    });
    const restEnds: NonNullable<Step["wireEnds"]> = rest.flatMap((copy) => copy.jumpers.map((id) => {
      const jumper = layout.jumpers.find((entry) => entry.id === id)!;
      return { jumper: id, ends: jumperText(layout, jumper, colorOf(jumper), []).ends };
    }));
    push({
      kind: "place",
      title: `Repeat ×${rest.length} more (${copies.length} in all), ${repeat.columns} column${repeat.columns === 1 ? "" : "s"} right each time`,
      text: `Build ${rest.length} more ${rest.length === 1 ? unitName : `${unitName}s`} exactly like the first, each ${repeat.columns} column${repeat.columns === 1 ? "" : "s"} to the right of the one before. Tick them off: ${rest.map((copy) => copy.text.replace(/:/, ` (${restLandmarks[copy.index - 2]!.text}):`)).join(" ")}`,
      plug: "unplugged",
      adds: { parts: rest.flatMap((copy) => copy.parts), jumpers: rest.flatMap((copy) => copy.jumpers) },
      holes: rest.flatMap((copy) => copy.holes),
      callouts: rest.flatMap((copy) => copy.parts).map((id) => partCallout(partMap.get(id)!)),
      landmarks: restLandmarks,
      ...(restEnds.length > 0 ? { wireEnds: restEnds } : {}),
      repeat: { role: "repeat", ...plan },
    });
    placedParts.push(...rest.flatMap((copy) => copy.parts));
    placedJumpers.push(...rest.flatMap((copy) => copy.jumpers));
  }

  // A unit that isn't repeated (a button with its two wires) is still one step: the part, then its own wires.
  for (const unit of singleUnits(circuit, layout, [...placedParts], [...placedJumpers, ...rails.map((jumper) => jumper.id)])) {
    const texts: string[] = [];
    const holes: string[] = [];
    const landmarks: StepLandmark[] = [];
    const wireEnds: NonNullable<Step["wireEnds"]> = [];
    for (const id of unit.parts) {
      const placed = placementText(circuit, partMap.get(id)!, layout, earlierItems(circuit, layout, placedParts, placedJumpers, colors));
      placedParts.push(id);
      texts.push(placed.text);
      holes.push(...placed.holes);
      landmarks.push(...placed.landmarks);
    }
    for (const id of unit.jumpers) {
      const jumper = layout.jumpers.find((entry) => entry.id === id)!;
      const wire = jumperText(layout, jumper, colorOf(jumper), earlierItems(circuit, layout, placedParts, placedJumpers, colors));
      placedJumpers.push(id);
      texts.push(wire.text);
      holes.push(...[jumper.from, jumper.to].flatMap((end) => ("hole" in end ? [end.hole] : [])));
      landmarks.push(...wire.landmarks);
      wireEnds.push({ jumper: id, ends: wire.ends });
    }
    push({
      kind: "place",
      title: `Insert ${unit.parts.join(" + ")} and ${unit.jumpers.length === 1 ? "its wire" : `its ${unit.jumpers.length} wires`}`,
      text: texts.join(" "),
      plug: "unplugged",
      adds: { parts: unit.parts, jumpers: unit.jumpers },
      holes,
      callouts: unit.parts.map((id) => partCallout(partMap.get(id)!)),
      ...(landmarks.length > 0 ? { landmarks } : {}),
      ...(wireEnds.length > 0 ? { wireEnds } : {}),
    });
  }

  for (const part of [...circuit.parts].filter((entry) => !placedParts.includes(entry.id)).sort((a, b) => leftmost(a) - leftmost(b) || a.id.localeCompare(b.id))) {
    const placed = placementText(circuit, part, layout, earlierItems(circuit, layout, placedParts, placedJumpers, colors));
    placedParts.push(part.id);
    push({
      kind: "place",
      title: `Insert ${part.id} — ${MODULES[part.module].name}`,
      text: placed.text,
      plug: "unplugged",
      adds: { parts: [part.id], jumpers: [] },
      holes: placed.holes,
      callouts: [partCallout(part)],
      ...(placed.landmarks.length > 0 ? { landmarks: placed.landmarks } : {}),
    });
  }

  const nonRailJumpers = layout.jumpers.filter((jumper) => !rails.some((rail) => rail.id === jumper.id) && !placedJumpers.includes(jumper.id));
  for (const jumper of nonRailJumpers) {
    const wire = jumperText(layout, jumper, colorOf(jumper), earlierItems(circuit, layout, placedParts, placedJumpers, colors));
    placedJumpers.push(jumper.id);
    push({
      kind: "jumper",
      title: `Add ${jumper.id} — ${jumper.net}`,
      text: wire.text,
      plug: "unplugged",
      adds: { parts: [], jumpers: [jumper.id] },
      holes: ["hole" in jumper.from ? jumper.from.hole : "", "hole" in jumper.to ? jumper.to.hole : ""].filter(Boolean),
      callouts: [],
      wireEnds: [{ jumper: jumper.id, ends: wire.ends }],
      ...(wire.landmarks.length > 0 ? { landmarks: wire.landmarks } : {}),
    });
  }

  push({
    kind: "checkpoint",
    title: "Subsection checkpoint — plug in",
    text: "Plug in USB for the assembled subsection. Run the continuity and component-specific checks, then unplug before changing anything.",
    plug: "plugged",
    adds: { parts: [], jumpers: [] },
    holes: [],
    callouts: [],
    checkpoint: { tests: testsForSubsection(circuit), text: "A failed check is a wiring/design/code clue; stop and inspect the named net before continuing." },
  });
  push({
    kind: "unplug",
    title: "Unplug USB before final review",
    text: "Unplug USB. Compare every visible part and jumper with its labelled hole before final power-up.",
    plug: "unplugged",
    adds: { parts: [], jumpers: [] },
    holes: [],
    callouts: [],
  });
  push({
    kind: "power-up",
    title: "Final power-up",
    text: "Everything is inserted and checked. Plug in USB for the final power-up, then run the complete self-test. Do not move wires while plugged in.",
    plug: "plugged",
    adds: { parts: [], jumpers: [] },
    holes: [],
    callouts: [],
    checkpoint: { tests: ["rails.vcc", "pins.readonly"], text: "Run the full staged self-test and stop on any fault." },
  });

  // Keep the part map referenced here so malformed layouts fail with a useful
  // instruction instead of silently producing a step with no hole text.
  for (const part of circuit.parts) {
    if (!partMap.has(part.id)) throw new Error(`Cannot build steps: circuit part ${part.id} is missing`);
  }
  return { schema: "vibread.steps/1", layoutHash: layoutHash(layout), steps };
}

export { partCallout };
