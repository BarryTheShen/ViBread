import type { Circuit, Net, Part, PinRef } from "@vibread/core";
import type { VirtualFault } from "./virtual.js";

function cloneCircuit(circuit: Circuit): Circuit {
  return structuredClone(circuit);
}

function partRefs(net: Net, partId: string): PinRef[] {
  return net.pins.filter((pin) => pin.part === partId);
}

/** Apply one deliberate wiring mutant without changing the revision contract. */
export function circuitWithFault(circuit: Circuit, fault: VirtualFault): Circuit {
  const result = cloneCircuit(circuit);
  if (fault === "none") return result;

  if (fault === "button-gnd") {
    const button = result.parts.find((part) => part.module === "button");
    const ground = result.nets.find((net) => net.kind === "ground");
    if (!button || !ground) return result;
    const source = result.nets.find((net) => partRefs(net, button.id).length > 0 && net.id !== ground.id);
    const moved = source?.pins.find((pin) => pin.part === button.id);
    if (!source || !moved) return result;
    source.pins = source.pins.filter((pin) => pin !== moved);
    if (!ground.pins.some((pin) => pin.part === moved.part && pin.pin === moved.pin)) ground.pins.push(moved);
    return result;
  }

  if (fault === "led-jumpers") {
    const leds = result.parts.filter((part) => part.module === "led").slice(0, 2);
    if (leds.length < 2) return result;
    const [first, second] = leds;
    for (const net of result.nets) {
      net.pins = net.pins.map((pin) => {
        if (pin.part === first.id) return { ...pin, part: second.id };
        if (pin.part === second.id) return { ...pin, part: first.id };
        return pin;
      });
    }
    return result;
  }

  const resistor = result.parts.find((part) => part.module === "resistor");
  if (!resistor) return result;
  result.parts = result.parts.filter((part) => part.id !== resistor.id);
  result.nets = result.nets
    .map((net) => ({ ...net, pins: net.pins.filter((pin) => pin.part !== resistor.id) }))
    .filter((net) => net.pins.length >= 2);
  return result;
}

export function partForFault(circuit: Circuit, fault: VirtualFault): Part | undefined {
  if (fault === "button-gnd") return circuit.parts.find((part) => part.module === "button");
  if (fault === "divider-resistor") return circuit.parts.find((part) => part.module === "resistor");
  if (fault === "led-jumpers") return circuit.parts.find((part) => part.module === "led");
  return undefined;
}
