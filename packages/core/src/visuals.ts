/**
 * How each part looks and how to tell its legs apart (issue #22 build-step panels; variants are added by the hardware
 * catalogue, issue #23). Drawings and step wording come from here, never from per-step strings.
 */
import type { Part } from "./circuit.js";
import { MODULES, type ModuleKey } from "./modules.js";
import { partVariant } from "./variants.js";

export interface PartLegVisual {
  /** Module pin id ("A", "K", "1", "W", "P"). */
  pin: string;
  /** Shown next to the leg in the panel: "+ anode (long leg)". */
  label: string;
  /** Used in step text and landmarks: "long leg", "short leg", "leg 1", "wiper". */
  short: string;
  /** How to find this leg on the real part: "the longer leg". */
  howToTell?: string;
  length: "long" | "short" | "equal";
}

export type PartDrawing = "led" | "resistor" | "button4" | "button2" | "buzzer" | "potentiometer" | "photoresistor" | "generic";

export interface PartVisual {
  module: ModuleKey;
  /** Catalogue variant ("5mm", "3mm", "2-leg" …); undefined for the default built-in. */
  variant?: string;
  /** "LED", "Push button". */
  name: string;
  /** Which panel drawing the step pictures use. */
  drawing: PartDrawing;
  /** Legs in drawing order, left to right. */
  legs: PartLegVisual[];
  polarized: boolean;
  /** One line: "Long leg is +." / "Either direction is fine." */
  orientation: string;
  /** Pins always connected inside the part (a push button's pairs). */
  joined?: string[][];
  /** The part goes across the breadboard's centre channel. */
  straddlesChannel?: boolean;
  /** CSS colour for the drawing's body; LED colour comes from params.color when absent. */
  bodyColor?: string;
}

type VisualFactory = (part: Part) => PartVisual;

const BUILT_IN: Record<ModuleKey, VisualFactory> = {
  led: () => ({
    module: "led",
    name: "LED",
    drawing: "led",
    polarized: true,
    orientation: "Long leg is + (anode); the short leg is on the flat side of the rim.",
    legs: [
      { pin: "A", label: "+ anode (long leg)", short: "long leg", howToTell: "the longer leg", length: "long" },
      { pin: "K", label: "− cathode (short leg, flat side)", short: "short leg", howToTell: "the shorter leg, next to the flat side of the rim", length: "short" },
    ],
  }),
  resistor: () => ({
    module: "resistor",
    name: "Resistor",
    drawing: "resistor",
    polarized: false,
    orientation: "Either direction is fine.",
    legs: [
      { pin: "1", label: "leg", short: "left leg", length: "equal" },
      { pin: "2", label: "leg", short: "right leg", length: "equal" },
    ],
  }),
  button: () => ({
    module: "button",
    name: "Push button",
    drawing: "button4",
    polarized: false,
    orientation: "Legs 1–2 are always joined, legs 3–4 are always joined; pressing joins the pairs.",
    joined: [["1", "2"], ["3", "4"]],
    straddlesChannel: true,
    legs: [
      { pin: "1", label: "leg 1", short: "leg 1", length: "equal" },
      { pin: "2", label: "leg 2", short: "leg 2", length: "equal" },
      { pin: "3", label: "leg 3", short: "leg 3", length: "equal" },
      { pin: "4", label: "leg 4", short: "leg 4", length: "equal" },
    ],
  }),
  photoresistor: () => ({
    module: "photoresistor",
    name: "Light sensor",
    drawing: "photoresistor",
    polarized: false,
    orientation: "Either direction is fine.",
    legs: [
      { pin: "1", label: "leg", short: "left leg", length: "equal" },
      { pin: "2", label: "leg", short: "right leg", length: "equal" },
    ],
  }),
  potentiometer: () => ({
    module: "potentiometer",
    name: "Knob",
    drawing: "potentiometer",
    polarized: false,
    orientation: "The middle leg is the wiper; the outer legs go to 5 V and GND.",
    legs: [
      { pin: "A", label: "outer leg A", short: "outer leg A", length: "equal" },
      { pin: "W", label: "wiper (middle)", short: "middle leg", length: "equal" },
      { pin: "B", label: "outer leg B", short: "outer leg B", length: "equal" },
    ],
  }),
  "buzzer-active": () => buzzer("buzzer-active", "Active buzzer"),
  "buzzer-passive": () => buzzer("buzzer-passive", "Passive buzzer"),
  generic: (part) => ({
    module: "generic",
    name: part.label ?? MODULES.generic.name,
    drawing: "generic",
    polarized: true,
    orientation: "Match each leg's name to the label printed on the module.",
    legs: (part.pinout ?? []).map((pin) => ({ pin: pin.id, label: pin.id, short: pin.id, length: "equal" as const })),
  }),
};

function buzzer(module: "buzzer-active" | "buzzer-passive", name: string): PartVisual {
  return {
    module,
    name,
    drawing: "buzzer",
    polarized: true,
    orientation: "The + leg is under the + mark on top (usually the longer leg).",
    legs: [
      { pin: "P", label: "+ leg (under the + mark)", short: "+ leg", howToTell: "the leg under the + mark, usually longer", length: "long" },
      { pin: "N", label: "− leg", short: "− leg", length: "short" },
    ],
  };
}

/** The visual description of a placed part: its catalogue variant (`params.variant`, variants.ts) or the module default. */
export function partVisual(part: Part): PartVisual {
  return partVariant(part) ?? BUILT_IN[part.module](part);
}
