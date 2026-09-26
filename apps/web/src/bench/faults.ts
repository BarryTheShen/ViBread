import { asBuiltCircuit, layoutBoard } from "@vibread/assembly/layout";
import type { Circuit, Endpoint, Layout, Part } from "@vibread/core";
import type { VirtualFault } from "./virtual.js";

function cloneLayout(layout: Layout): Layout {
  return structuredClone(layout);
}

function holesIn(endpoint: Endpoint): string[] {
  return "hole" in endpoint ? [endpoint.hole] : [];
}

function groundHole(layout: Layout): string | undefined {
  const groundJumper = layout.jumpers.find((jumper) => jumper.net.toLowerCase().includes("gnd") || jumper.net.toLowerCase().includes("ground"));
  return groundJumper === undefined ? undefined : [...holesIn(groundJumper.from), ...holesIn(groundJumper.to)][0];
}

function mutateLayout(circuit: Circuit, source: Layout, fault: VirtualFault): Layout {
  const layout = cloneLayout(source);
  if (fault === "none") return layout;

  if (fault === "button-gnd") {
    const button = circuit.parts.find((part) => part.module === "button");
    const target = groundHole(layout);
    const placement = button === undefined ? undefined : layout.placements.find((candidate) => candidate.part === button.id);
    if (button !== undefined && placement !== undefined && target !== undefined) {
      const buttonPin = Object.keys(placement.pins)[0];
      if (buttonPin !== undefined) placement.pins[buttonPin] = target as typeof placement.pins[string];
    }
    return layout;
  }

  if (fault === "led-jumpers") {
    const ledIds = circuit.parts.filter((part) => part.module === "led").map((part) => part.id);
    const signalJumpers = layout.jumpers.filter((jumper) => {
      const net = circuit.nets.find((candidate) => candidate.id === jumper.net);
      return net?.kind === "signal" && net.pins.some((pin) => ledIds.includes(pin.part));
    });
    const first = signalJumpers[0];
    const second = signalJumpers[1];
    if (first !== undefined && second !== undefined) {
      const from = first.from;
      const to = first.to;
      first.from = second.from;
      first.to = second.to;
      second.from = from;
      second.to = to;
    }
    return layout;
  }

  const resistor = circuit.parts.find((part) => part.module === "resistor");
  if (resistor !== undefined) layout.placements = layout.placements.filter((placement) => placement.part !== resistor.id);
  return layout;
}

/**
 * Build a browser fault using the same physical layout → LVS → as-built netlist
 * path as the server's mutant tests. No declared IR net is edited directly.
 */
export function circuitWithFault(circuit: Circuit, fault: VirtualFault, layout?: Layout): Circuit {
  const source = layout === undefined ? layoutBoard(circuit) : layout;
  return asBuiltCircuit(circuit, mutateLayout(circuit, source, fault));
}

export function partForFault(circuit: Circuit, fault: VirtualFault): Part | undefined {
  if (fault === "button-gnd") return circuit.parts.find((part) => part.module === "button");
  if (fault === "divider-resistor") return circuit.parts.find((part) => part.module === "resistor");
  if (fault === "led-jumpers") return circuit.parts.find((part) => part.module === "led");
  return undefined;
}
