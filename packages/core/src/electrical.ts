/** KiCad-style pin electrical types (vocabulary from KiCad's documentation, not its source). */
export const ELECTRICAL_TYPES = [
  "input",
  "output",
  "bidirectional",
  "tri_state",
  "passive",
  "power_in",
  "power_out",
  "open_collector",
  "open_emitter",
  "unspecified",
  "no_connect",
] as const;

export type ElectricalType = (typeof ELECTRICAL_TYPES)[number];
