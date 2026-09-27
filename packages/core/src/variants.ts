/**
 * Physical part variants (issue #23): the same library module in the shapes people actually own. A circuit part picks
 * one with `params.variant` (the key below); without it the module's built-in visual and footprint apply. Each variant
 * carries what the build steps need: legs and how to tell them apart, how many holes it spans, which way round it
 * goes, and the drawing (`PartVisual`, issue #22). Variants never change the electronics.
 */
import type { Column } from "./breadboards.js";
import type { Part } from "./circuit.js";
import type { ModuleKey } from "./modules.js";
import type { PartVisual } from "./visuals.js";

/** Where the legs go on the breadboard, in holes (2.54 mm). */
export type VariantFootprint =
  /** Two legs in one column, `span` rows apart. */
  | { kind: "two-lead"; span: number }
  /** Three legs in one column, `pitch` rows between neighbours (a panel pot's 5 mm legs skip a hole). */
  | { kind: "inline3"; pitch: number }
  /** Four legs across the centre channel in `columns`; the joined pairs sit on rows `rowSpan` apart. */
  | { kind: "button4"; columns: [Column, Column]; rowSpan: number }
  /** A two-leg button: legs "1" and "3" in one column, `span` rows apart (the internal pins "2"/"4" have no leg). */
  | { kind: "button2"; span: number };

export interface PartVariant extends PartVisual {
  /** Catalogue-wide id ("led-5mm"): what photo identification returns. */
  id: string;
  /** Key stored in `part.params.variant` ("5mm"). */
  variant: string;
  /** Built-in part type this is a variant of (catalog-data.ts). */
  typeId: string;
  /** Step wording prefix: "5 mm" → "5 mm red LED". */
  shortName: string;
  /** One sentence telling the vision model how it looks in a photo. */
  photoHint: string;
  /** How a person tells it apart from the other variants of the same part. */
  identify: string[];
  footprint: VariantFootprint;
  /** Body size (LED lens diameter, button body). */
  sizeMm?: number;
}

const LED_LEGS: PartVisual["legs"] = [
  { pin: "A", label: "+ anode (long leg)", short: "long leg", howToTell: "the longer leg", length: "long" },
  { pin: "K", label: "− cathode (short leg, flat side)", short: "short leg", howToTell: "the shorter leg, next to the flat side of the rim", length: "short" },
];

const BUTTON4_LEGS: PartVisual["legs"] = [
  { pin: "1", label: "leg 1", short: "leg 1", howToTell: "straight across the wide gap from leg 2 (always joined to it)", length: "equal" },
  { pin: "2", label: "leg 2", short: "leg 2", howToTell: "straight across the wide gap from leg 1", length: "equal" },
  { pin: "3", label: "leg 3", short: "leg 3", howToTell: "straight across the wide gap from leg 4 (always joined to it)", length: "equal" },
  { pin: "4", label: "leg 4", short: "leg 4", howToTell: "straight across the wide gap from leg 3", length: "equal" },
];

const POT_LEGS: PartVisual["legs"] = [
  { pin: "A", label: "outer leg A", short: "outer leg A", howToTell: "an end leg", length: "equal" },
  { pin: "W", label: "wiper (middle)", short: "middle leg", howToTell: "the middle leg", length: "equal" },
  { pin: "B", label: "outer leg B", short: "outer leg B", howToTell: "the other end leg", length: "equal" },
];

const BUZZER_ORIENTATION = "The + leg goes where the step says; it is under the + mark on top.";

export const PART_VARIANTS: PartVariant[] = [
  {
    id: "led-5mm",
    variant: "5mm",
    typeId: "led",
    module: "led",
    name: "5 mm LED",
    shortName: "5 mm",
    drawing: "led",
    polarized: true,
    orientation: "Long leg is + (anode); the short leg is on the flat side of the rim.",
    legs: LED_LEGS,
    photoHint: "A domed LED about the width of a pencil (5 mm) with a rim at the base; one leg is longer.",
    identify: ["lens about 5 mm across (pencil width)", "rim at the base with one flat side", "one leg longer than the other"],
    footprint: { kind: "two-lead", span: 1 },
    sizeMm: 5,
  },
  {
    id: "led-3mm",
    variant: "3mm",
    typeId: "led",
    module: "led",
    name: "3 mm LED",
    shortName: "3 mm",
    drawing: "led",
    polarized: true,
    orientation: "Long leg is + (anode); the short leg is on the flat side of the small rim.",
    legs: LED_LEGS,
    photoHint: "A small domed LED about half a pencil wide (3 mm) with a thin rim; one leg is longer.",
    identify: ["lens about 3 mm across, clearly smaller than a 5 mm LED", "thin rim, the flat side can be hard to see: go by the long leg", "one leg longer than the other"],
    footprint: { kind: "two-lead", span: 1 },
    sizeMm: 3,
  },
  {
    id: "button-6mm-4leg",
    variant: "6mm-4leg",
    typeId: "button",
    module: "button",
    name: "6 mm push button",
    shortName: "6 mm",
    drawing: "button4",
    polarized: false,
    orientation: "It goes across the centre channel; it only fits with the wide gap between its legs across the channel.",
    joined: [["1", "2"], ["3", "4"]],
    straddlesChannel: true,
    legs: BUTTON4_LEGS,
    photoHint: "A small square tactile switch about 6 mm on a side with a round plunger and four bent legs.",
    identify: ["square body about 6 mm (a little bigger than a pencil eraser end)", "four legs, two on each of two opposite sides", "fits across the breadboard's centre channel"],
    footprint: { kind: "button4", columns: ["e", "f"], rowSpan: 2 },
    sizeMm: 6,
  },
  {
    id: "button-12mm-4leg",
    variant: "12mm-4leg",
    typeId: "button",
    module: "button",
    name: "12 mm push button",
    shortName: "12 mm",
    drawing: "button4",
    polarized: false,
    orientation: "It goes across the centre channel with its legs in columns d and g; the wide gap between its legs runs across the channel.",
    joined: [["1", "2"], ["3", "4"]],
    straddlesChannel: true,
    legs: BUTTON4_LEGS,
    photoHint: "A large square tactile switch about 12 mm on a side, often with a coloured round cap, and four legs.",
    identify: ["square body about 12 mm, often with a coloured cap", "four legs, two on each of two opposite sides", "legs too far apart for the holes right next to the channel"],
    footprint: { kind: "button4", columns: ["d", "g"], rowSpan: 2 },
    sizeMm: 12,
  },
  {
    id: "button-2leg",
    variant: "2leg",
    typeId: "button",
    module: "button",
    name: "2-leg push button",
    shortName: "2-leg",
    drawing: "button2",
    polarized: false,
    orientation: "Either direction is fine; pressing joins its two legs.",
    legs: [
      { pin: "1", label: "leg", short: "left leg", howToTell: "either leg", length: "equal" },
      { pin: "3", label: "leg", short: "right leg", howToTell: "either leg", length: "equal" },
    ],
    photoHint: "A small rectangular tactile switch with a plunger and only two legs.",
    identify: ["only two legs", "small rectangular body", "sits in one half of the breadboard, not across the channel"],
    footprint: { kind: "button2", span: 2 },
    sizeMm: 6,
  },
  {
    id: "pot-trimmer",
    variant: "trimmer",
    typeId: "knob",
    module: "potentiometer",
    name: "Trimmer pot",
    shortName: "trimmer",
    drawing: "potentiometer",
    polarized: false,
    orientation: "The middle leg is the wiper; the outer legs go to 5 V and GND (either way round).",
    legs: POT_LEGS,
    photoHint: "A small square blue, white or black adjustment pot with a screwdriver slot or small knob and three legs in a row.",
    identify: ["small square body, often blue", "a screwdriver slot or tiny thumb knob on top", "three legs next to each other that fit neighbouring holes"],
    footprint: { kind: "inline3", pitch: 1 },
    sizeMm: 10,
  },
  {
    id: "pot-panel",
    variant: "panel",
    typeId: "knob",
    module: "potentiometer",
    name: "Panel pot",
    shortName: "panel",
    drawing: "potentiometer",
    polarized: false,
    orientation: "The middle leg is the wiper; the outer legs go to 5 V and GND (either way round). Its legs skip a hole.",
    legs: POT_LEGS,
    photoHint: "A round metal-bodied pot with a long shaft (often a knob) and three legs about 5 mm apart, often marked like B10K.",
    identify: ["round body with a long shaft or knob", "printed value like B10K", "three legs about two holes apart"],
    footprint: { kind: "inline3", pitch: 2 },
    sizeMm: 16,
  },
  {
    id: "buzzer-active",
    variant: "active",
    typeId: "buzzer-active",
    module: "buzzer-active",
    name: "Active buzzer",
    shortName: "active",
    drawing: "buzzer",
    polarized: true,
    orientation: BUZZER_ORIENTATION,
    legs: [
      { pin: "P", label: "+ leg (long leg, under the + mark)", short: "+ leg", howToTell: "the longer leg, under the + mark", length: "long" },
      { pin: "N", label: "− leg", short: "− leg", howToTell: "the shorter leg", length: "short" },
    ],
    photoHint: "A round black buzzer about 12 mm across with a sealed black bottom, often a white sticker on top, one leg longer.",
    identify: ["bottom is sealed with black resin (no circuit board visible)", "often a white 'remove seal' sticker on top", "one leg longer than the other"],
    footprint: { kind: "two-lead", span: 3 },
    sizeMm: 12,
  },
  {
    id: "buzzer-passive",
    variant: "passive",
    typeId: "buzzer-passive",
    module: "buzzer-passive",
    name: "Passive buzzer",
    shortName: "passive",
    drawing: "buzzer",
    polarized: true,
    orientation: BUZZER_ORIENTATION,
    legs: [
      { pin: "P", label: "+ leg (under the + mark)", short: "+ leg", howToTell: "the leg under the + mark", length: "equal" },
      { pin: "N", label: "− leg", short: "− leg", howToTell: "the other leg", length: "equal" },
    ],
    photoHint: "A round black buzzer about 12 mm across whose open bottom shows a green circuit board, usually with equal legs and no sticker.",
    identify: ["green circuit board visible from underneath", "no sticker", "legs usually the same length"],
    footprint: { kind: "two-lead", span: 3 },
    sizeMm: 12,
  },
];

/** The part's catalogue variant (by `params.variant`), or undefined for the module's built-in default. */
export function partVariant(part: Pick<Part, "module" | "params">): PartVariant | undefined {
  const key = part.params.variant;
  return typeof key === "string" ? PART_VARIANTS.find((variant) => variant.module === part.module && variant.variant === key) : undefined;
}

export function variantsForModule(module: ModuleKey): PartVariant[] {
  return PART_VARIANTS.filter((variant) => variant.module === module);
}
