import {
  MODULES,
  formatOhms,
  modulePins,
  resistorBands,
  type Circuit,
  type Jumper,
  type Layout,
  type Part,
  type Step,
  type StepList,
  type TestId,
} from "@vibread/core";

import { layoutHash } from "./allocator.js";

function endpointText(endpoint: Jumper["from"]): string {
  if ("board" in endpoint) return `Arduino ${endpoint.board} header pin`;
  if (endpoint.hole === "T-2" || endpoint.hole.startsWith("T-")) return "the blue − rail (GND)";
  if (endpoint.hole === "T+2" || endpoint.hole.startsWith("T+")) return "the red + rail (5 V)";
  return `hole ${endpoint.hole}`;
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

function placementText(part: Part, layout: Layout): { text: string; holes: string[] } {
  const placement = layout.placements.find((entry) => entry.part === part.id);
  if (!placement) return { text: `No placement was generated for ${part.id}.`, holes: [] };
  const holes = Object.values(placement.pins);
  let text: string;
  if (part.module === "resistor") {
    const ohms = Number(part.params.ohms);
    const bands = resistorBands(ohms, Number(part.params.tolerancePct ?? 5)).join("-");
    text = `Put the ${formatOhms(ohms)} resistor ${part.id} (${bands}) from hole ${placement.pins["1"]} to hole ${placement.pins["2"]}.`;
  } else if (part.module === "led") {
    const color = typeof part.params.color === "string" ? part.params.color : "red";
    text = `Before inserting, identify the long anode (+) leg. Put the ${color} LED ${part.id} with its anode (+) in hole ${placement.pins.A} and short cathode (−) leg in hole ${placement.pins.K}.`;
  } else if (part.module === "button") {
    text = `Put push button ${part.id} across the horizontal centre channel: legs 1–2 go in holes ${placement.pins["1"]} and ${placement.pins["2"]}; legs 3–4 go in holes ${placement.pins["3"]} and ${placement.pins["4"]}.`;
  } else if (part.module === "photoresistor") {
    text = `Put the light sensor ${part.id} with its two legs in holes ${placement.pins["1"]} and ${placement.pins["2"]}; either direction is okay.`;
  } else {
    const name = MODULES[part.module].name.toLowerCase();
    const pinText = modulePins(part).map((pin) => `${pin.name} in hole ${placement.pins[pin.id]}`).join(", ");
    text = `Put the ${name} ${part.id}: ${pinText}.`;
  }
  return { text: `${text} Keep USB unplugged.`, holes };
}

function jumperColor(jumper: Jumper): string {
  if (jumper.net === "GND") return "black";
  if (jumper.net === "5V") return "red";
  return String(jumper.color);
}

function jumperText(jumper: Jumper): string {
  return `Connect a ${jumperColor(jumper)} wire from ${endpointText(jumper.from)} to ${endpointText(jumper.to)}. Check both printed endpoints; color is only a visual aid.`;
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
  const board = layout.board.includes("nano") ? "Nano across the centre channel" : "Uno beside the breadboard";
  return `${board}. Rows run left to right. Columns a–e are the five-hole lines above the horizontal centre channel, and f–j are the five-hole lines below it. Top rails are T+ (5 V, red) and T− (GND, black). Read printed hole IDs, never wire color alone.`;
}

function railJumpers(layout: Layout): Jumper[] {
  return layout.jumpers.filter((jumper) => {
    const isPowerRail = jumper.net === "5V" || jumper.net === "GND";
    const hasBoardEndpoint = "board" in jumper.from || "board" in jumper.to;
    return isPowerRail && hasBoardEndpoint;
  });
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

export function buildSteps(circuit: Circuit, layout: Layout): StepList {
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
  push({
    kind: "unplug",
    title: "Unplug USB",
    text: "USB must be unplugged before placing any part or jumper. Keep it unplugged until a checkpoint explicitly says plug in.",
    plug: "unplugged",
    adds: { parts: [], jumpers: [] },
    holes: [],
    callouts: [],
  });

  const rails = railJumpers(layout);
  push({
    kind: "rails",
    title: "Connect the top power rails",
    text: `With USB unplugged, connect the Arduino 5 V header to T+ and GND to T−. Exact rail holes: ${rails.flatMap((jumper) => [endpointText(jumper.from), endpointText(jumper.to)]).join(", ") || "see the labelled T+2 and T−2 rails"}. Red/black colors are aids; verify the T+ and T− labels.`,
    plug: "unplugged",
    adds: { parts: [], jumpers: rails.map((jumper) => jumper.id) },
    holes: rails.flatMap((jumper) => ["hole" in jumper.from ? jumper.from.hole : "", "hole" in jumper.to ? jumper.to.hole : ""]).filter(Boolean),
    callouts: [],
  });
  push({
    kind: "checkpoint",
    title: "Rail checkpoint — plug in",
    text: "Plug in the USB cable. ViBread checks that the red + rail has 5 V and the blue − rail is ground before anything else runs. Unplug again before touching the build.",
    plug: "plugged",
    adds: { parts: [], jumpers: [] },
    holes: [],
    callouts: [],
    checkpoint: { tests: ["rails.vcc"], text: "Pass rails.vcc before continuing; a failure means stop and inspect T+ / T−." },
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

  for (const part of [...circuit.parts].sort((a, b) => a.id.localeCompare(b.id))) {
    const placed = placementText(part, layout);
    push({
      kind: "place",
      title: `Insert ${part.id} — ${MODULES[part.module].name}`,
      text: placed.text,
      plug: "unplugged",
      adds: { parts: [part.id], jumpers: [] },
      holes: placed.holes,
      callouts: [partCallout(part)],
    });
  }

  const nonRailJumpers = layout.jumpers.filter((jumper) => !rails.some((rail) => rail.id === jumper.id));
  for (const jumper of nonRailJumpers) {
    push({
      kind: "jumper",
      title: `Add ${jumper.id} — ${jumper.net}`,
      text: `${jumperText(jumper)} Keep USB unplugged.`,
      plug: "unplugged",
      adds: { parts: [], jumpers: [jumper.id] },
      holes: ["hole" in jumper.from ? jumper.from.hole : "", "hole" in jumper.to ? jumper.to.hole : ""].filter(Boolean),
      callouts: [],
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
