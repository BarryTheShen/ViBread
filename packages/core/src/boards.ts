import type { ElectricalType } from "./electrical.js";

export const BOARD_PROFILE_IDS = ["uno-r3-atmega328p-5v", "nano-atmega328p-5v", "nano-atmega328p-old-5v"] as const;
export type BoardProfileId = (typeof BOARD_PROFILE_IDS)[number];

/** Board-level pin name used in the IR: "D0".."D13", "A0".."A7", "5V", "3V3", "GND", "VIN", "AREF", "RESET", "IOREF". */
export type BoardPinName = string;

export type BoardPinSpecial =
  | "serial-rx"
  | "serial-tx"
  | "spi-ss"
  | "spi-mosi"
  | "spi-miso"
  | "spi-sck"
  | "i2c-sda"
  | "i2c-scl"
  | "led-builtin"
  | "int0"
  | "int1";

export interface BoardPin {
  name: BoardPinName;
  kind: "digital" | "analog" | "power" | "ground" | "reset" | "aref";
  /** AVR port letter and bit (PB5 = { port: "B", bit: 5 }); absent for power pins and ADC6/ADC7. */
  port?: "B" | "C" | "D";
  bit?: number;
  /** Arduino core pin number used by digitalWrite/pinMode (A0 = 14 on the ATmega328P core). */
  arduino?: number;
  digital: boolean;
  pwm: boolean;
  /** ADC channel (0..7) when the pin can be read with analogRead. */
  adc?: number;
  special: BoardPinSpecial[];
  etype: ElectricalType;
  /** Supply voltage for power pins. */
  volts?: number;
  /** Maximum current the pin can supply (power pins) in mA. */
  maxMa?: number;
}

export interface UsbId {
  vid: number;
  pid: number;
  label: string;
}

export interface BoardProfile {
  id: BoardProfileId;
  name: string;
  mcu: "atmega328p";
  fqbn: string;
  clockHz: number;
  vcc: number;
  flash: { protocol: "stk500v1"; baud: number; signature: [number, number, number]; pageSize: number };
  /** USB IDs shown in the port chooser (genuine + common clone bridges). */
  usb: UsbId[];
  pins: BoardPin[];
  limits: {
    /** Design limit per I/O pin (datasheet recommends ≤ 20 mA). */
    pinDesignMa: number;
    /** Absolute maximum per I/O pin. */
    pinAbsMa: number;
    /** Absolute maximum through VCC/GND pins of the MCU. */
    vccGndTotalMa: number;
    /** USB polyfuse on the board's 5 V path. */
    usbFuseMa: number;
    /** 3V3 pin budget. */
    rail3v3Ma: number;
  };
  logic: { vilMax: number; vihMin: number };
  pullupOhms: { min: number; max: number };
  /** Output driver model: near-zero for max-current corners, `effective` for brightness/drop checks. */
  driverOhms: { min: number; effective: number };
  adc: { bits: 10; vref: number; bandgapVolts: { min: number; typ: number; max: number } };
  /** Pins the user sketch must not use for circuits (USB serial). */
  reserved: BoardPinName[];
  /** Uno sits beside the breadboard (jumpers from headers); Nano straddles the channel. */
  placement: "off-board" | "straddle";
  /** Uno header order for rendering, or DIP pin order (pin 1 first, counter-clockwise) for the Nano. */
  headers: { name: string; pins: BoardPinName[] }[];
  /** Protection on the 5 V USB path — used when explaining "board lost power". */
  usbPowerPath: string;
}

const PWM_PINS = new Set([3, 5, 6, 9, 10, 11]);

function digitalPins(): BoardPin[] {
  const pins: BoardPin[] = [];
  for (let n = 0; n <= 13; n++) {
    const port = n <= 7 ? "D" : "B";
    const bit = n <= 7 ? n : n - 8;
    const special: BoardPinSpecial[] = [];
    if (n === 0) special.push("serial-rx");
    if (n === 1) special.push("serial-tx");
    if (n === 2) special.push("int0");
    if (n === 3) special.push("int1");
    if (n === 10) special.push("spi-ss");
    if (n === 11) special.push("spi-mosi");
    if (n === 12) special.push("spi-miso");
    if (n === 13) special.push("spi-sck", "led-builtin");
    pins.push({
      name: `D${n}`,
      kind: "digital",
      port,
      bit,
      arduino: n,
      digital: true,
      pwm: PWM_PINS.has(n),
      special,
      etype: "bidirectional",
    });
  }
  return pins;
}

function analogPins(count: 6 | 8): BoardPin[] {
  const pins: BoardPin[] = [];
  for (let n = 0; n < count; n++) {
    const special: BoardPinSpecial[] = [];
    if (n === 4) special.push("i2c-sda");
    if (n === 5) special.push("i2c-scl");
    // ADC6/ADC7 (Nano only) are analog-input-only: no port bit, no digital I/O.
    const digital = n < 6;
    pins.push({
      name: `A${n}`,
      kind: "analog",
      ...(digital ? { port: "C" as const, bit: n } : {}),
      arduino: 14 + n,
      digital,
      pwm: false,
      adc: n,
      special,
      etype: digital ? "bidirectional" : "input",
    });
  }
  return pins;
}

function powerPins(): BoardPin[] {
  return [
    { name: "5V", kind: "power", digital: false, pwm: false, special: [], etype: "power_out", volts: 5, maxMa: 500 },
    { name: "3V3", kind: "power", digital: false, pwm: false, special: [], etype: "power_out", volts: 3.3, maxMa: 50 },
    { name: "GND", kind: "ground", digital: false, pwm: false, special: [], etype: "power_out", volts: 0 },
    { name: "VIN", kind: "power", digital: false, pwm: false, special: [], etype: "power_in" },
    { name: "AREF", kind: "aref", digital: false, pwm: false, special: [], etype: "input" },
    { name: "RESET", kind: "reset", digital: false, pwm: false, special: [], etype: "input" },
  ];
}

const COMMON = {
  mcu: "atmega328p" as const,
  clockHz: 16_000_000,
  vcc: 5,
  limits: { pinDesignMa: 20, pinAbsMa: 40, vccGndTotalMa: 200, usbFuseMa: 500, rail3v3Ma: 50 },
  logic: { vilMax: 1.5, vihMin: 3.0 },
  pullupOhms: { min: 20_000, max: 50_000 },
  driverOhms: { min: 0, effective: 45 },
  adc: { bits: 10 as const, vref: 5, bandgapVolts: { min: 1.0, typ: 1.1, max: 1.2 } },
  reserved: ["D0", "D1"],
};

const CLONE_USB: UsbId[] = [
  { vid: 0x1a86, pid: 0x7523, label: "CH340 (common clone)" },
  { vid: 0x0403, pid: 0x6001, label: "FTDI FT232R" },
  { vid: 0x10c4, pid: 0xea60, label: "CP2102" },
];

export const UNO_R3: BoardProfile = {
  ...COMMON,
  id: "uno-r3-atmega328p-5v",
  name: "Arduino Uno R3 (ATmega328P)",
  fqbn: "arduino:avr:uno",
  flash: { protocol: "stk500v1", baud: 115_200, signature: [0x1e, 0x95, 0x0f], pageSize: 128 },
  usb: [
    { vid: 0x2341, pid: 0x0043, label: "Arduino Uno R3" },
    { vid: 0x2341, pid: 0x0001, label: "Arduino Uno" },
    { vid: 0x2a03, pid: 0x0043, label: "Arduino Uno R3 (arduino.org)" },
    { vid: 0x2341, pid: 0x0243, label: "Arduino Uno R3 (newer USB)" },
    ...CLONE_USB,
  ],
  pins: [...digitalPins(), ...analogPins(6), ...powerPins(), { name: "IOREF", kind: "power", digital: false, pwm: false, special: [], etype: "power_out", volts: 5 }],
  placement: "off-board",
  headers: [
    { name: "power", pins: ["IOREF", "RESET", "3V3", "5V", "GND", "GND", "VIN"] },
    { name: "analog", pins: ["A0", "A1", "A2", "A3", "A4", "A5"] },
    { name: "digital-low", pins: ["D0", "D1", "D2", "D3", "D4", "D5", "D6", "D7"] },
    { name: "digital-high", pins: ["D8", "D9", "D10", "D11", "D12", "D13", "GND", "AREF"] },
  ],
  usbPowerPath: "500 mA resettable polyfuse on USB 5 V; a 5 V–GND short trips it and the board drops off USB",
};

const NANO_DIP: BoardPinName[] = [
  // pin 1..15 (one side, USB end first), then 16..30 back up the other side
  "D1", "D0", "RESET", "GND", "D2", "D3", "D4", "D5", "D6", "D7", "D8", "D9", "D10", "D11", "D12",
  "D13", "3V3", "AREF", "A0", "A1", "A2", "A3", "A4", "A5", "A6", "A7", "5V", "RESET", "GND", "VIN",
];

export const NANO: BoardProfile = {
  ...COMMON,
  id: "nano-atmega328p-5v",
  name: "Arduino Nano (ATmega328P, new bootloader)",
  fqbn: "arduino:avr:nano:cpu=atmega328",
  flash: { protocol: "stk500v1", baud: 115_200, signature: [0x1e, 0x95, 0x0f], pageSize: 128 },
  usb: [{ vid: 0x0403, pid: 0x6001, label: "Arduino Nano (FTDI)" }, ...CLONE_USB],
  pins: [...digitalPins(), ...analogPins(8), ...powerPins()],
  placement: "straddle",
  headers: [{ name: "dip30", pins: NANO_DIP }],
  usbPowerPath: "Schottky diode on USB 5 V (no polyfuse on many clones); a 5 V–GND short can make the host port cut power",
};

export const NANO_OLD: BoardProfile = {
  ...NANO,
  id: "nano-atmega328p-old-5v",
  name: "Arduino Nano (ATmega328P, old bootloader)",
  fqbn: "arduino:avr:nano:cpu=atmega328old",
  flash: { ...NANO.flash, baud: 57_600 },
};

export const BOARD_PROFILES: Record<BoardProfileId, BoardProfile> = {
  "uno-r3-atmega328p-5v": UNO_R3,
  "nano-atmega328p-5v": NANO,
  "nano-atmega328p-old-5v": NANO_OLD,
};

/**
 * Physical board variants you can own (issue #23). Each maps to the board profile that designs, compiles and flashes
 * for it; a variant only adds what the person sees (USB chip, markings) and how to tell it apart in a photo.
 */
export const BOARD_VARIANT_IDS = ["uno-r3-genuine", "uno-r3-ch340", "nano-new", "nano-old"] as const;
export type BoardVariantId = (typeof BOARD_VARIANT_IDS)[number];

export interface BoardVariant {
  id: BoardVariantId;
  /** The profile missions and circuits use for this board. */
  profile: BoardProfileId;
  name: string;
  /** Step wording: "your Uno R3 (CH340)". */
  shortName: string;
  /** USB-to-serial chip next to the USB socket. */
  usbChip: string;
  /** USB IDs this variant usually shows in the port chooser (display only; flashing uses the profile). */
  usb: UsbId[];
  /** One sentence telling the vision model how this board looks in a photo. */
  photoHint: string;
  /** How a person tells it apart from the other variants. */
  identify: string[];
  /** False when a photo alone can't separate it from a sibling variant (old vs new Nano bootloader). */
  photoDistinct: boolean;
}

export const BOARD_VARIANTS: Record<BoardVariantId, BoardVariant> = {
  "uno-r3-genuine": {
    id: "uno-r3-genuine",
    profile: "uno-r3-atmega328p-5v",
    name: "Arduino Uno R3 (genuine, ATmega16U2 USB chip)",
    shortName: "Uno R3",
    usbChip: "ATmega16U2",
    usb: UNO_R3.usb.filter((id) => id.vid === 0x2341 || id.vid === 0x2a03),
    photoHint: "A teal Arduino Uno with the Arduino logo and 'UNO' printed, a small square ATmega16U2 chip beside the square USB-B socket, and a long socketed ATmega328P.",
    identify: ["Arduino logo and 'UNO' printed on the board", "small square chip (ATmega16U2) next to the USB socket", "shows as 'Arduino Uno' when plugged in"],
    photoDistinct: true,
  },
  "uno-r3-ch340": {
    id: "uno-r3-ch340",
    profile: "uno-r3-atmega328p-5v",
    name: "Uno R3 compatible (CH340 USB chip)",
    shortName: "Uno R3 (CH340)",
    usbChip: "CH340G",
    usb: CLONE_USB.filter((id) => id.vid === 0x1a86),
    photoHint: "An Uno-shaped board (often blue or black, no Arduino logo) with a rectangular chip marked CH340G beside the USB socket, sometimes a tiny square ATmega328P instead of the long one.",
    identify: ["rectangular chip marked 'CH340' or 'CH340G' near the USB socket", "usually no Arduino logo", "shows as 'USB-SERIAL CH340' when plugged in"],
    photoDistinct: true,
  },
  "nano-new": {
    id: "nano-new",
    profile: "nano-atmega328p-5v",
    name: "Arduino Nano (new bootloader)",
    shortName: "Nano",
    usbChip: "CH340G or FT232RL",
    usb: NANO.usb,
    photoHint: "A small narrow board about 4.5 cm long with a mini- or micro-USB socket at one end and two rows of 15 pins, marked 'Nano' or with pin labels D2…D13.",
    identify: ["small board with two rows of 15 pins", "mini-USB or micro-USB socket at one end", "boards bought after 2018 almost always have the new bootloader"],
    photoDistinct: false,
  },
  "nano-old": {
    id: "nano-old",
    profile: "nano-atmega328p-old-5v",
    name: "Arduino Nano (old bootloader)",
    shortName: "Nano (old bootloader)",
    usbChip: "CH340G or FT232RL",
    usb: NANO_OLD.usb,
    photoHint: "Looks exactly like a new-bootloader Nano: a small narrow board with two rows of 15 pins and a mini-USB socket.",
    identify: ["looks the same as the new-bootloader Nano; a photo can't tell them apart", "if uploading to 'Nano' fails and 'Nano (old bootloader)' works, it's this one"],
    photoDistinct: false,
  },
};

export function isBoardVariantId(value: unknown): value is BoardVariantId {
  return typeof value === "string" && (BOARD_VARIANT_IDS as readonly string[]).includes(value);
}

export function boardPin(profile: BoardProfile, name: BoardPinName): BoardPin | undefined {
  return profile.pins.find((p) => p.name === name);
}
