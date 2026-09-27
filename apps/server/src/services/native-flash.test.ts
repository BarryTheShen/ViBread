import { describe, expect, it } from "vitest";
import { classifyUpload, createNativeFlasher, NativeFlashError, parseBoardList, runProcess, type ProcessRunner } from "./native-flash.js";

const BOARD_LIST = JSON.stringify({
  detected_ports: [
    { port: { address: "COM1", label: "COM1", protocol: "serial", protocol_label: "Serial Port", properties: {} } },
    { port: { address: "COM3", label: "COM3", protocol: "serial", protocol_label: "Serial Port (USB)", properties: { vid: "0x1A86", pid: "0x7523" } } },
    { matching_boards: [{ name: "Arduino Uno", fqbn: "arduino:avr:uno" }], port: { address: "COM4", label: "COM4", protocol: "serial", properties: { vid: "0x2341", pid: "0x0043" } } },
    { port: { address: "COM5", label: "COM5", protocol: "serial", properties: { vid: "0x046D", pid: "0xC52B" } } },
    { port: { address: "192.168.1.9", label: "yun", protocol: "network", properties: { vid: "0x2341", pid: "0x0043" } } },
  ],
});

const SUCCESS = `"C:\\Users\\t\\AppData\\Roaming\\ViBread\\toolchain\\arduino\\data\\packages\\arduino\\tools\\avrdude\\8.0.0-arduino1\\bin\\avrdude.exe" -v -V -patmega328p -carduino "-PCOM3" -b115200 -D "-Uflash:w:C:\\Temp\\firmware.hex:i"
Avrdude version 8.0-arduino.1
Using port            : COM3
Using programmer      : arduino
Setting baud rate     : 115200
HW Version            : 3
FW Version            : 4.4
AVR device initialized and ready to accept instructions
Device signature = 1E 95 0F (ATmega328P, ATA6614Q, LGT8F328P)
Writing | ################################################## | 100% 0.40 s
2462 bytes of flash written

Avrdude done.  Thank you.
`;

const NOT_IN_SYNC_V8 = `User configuration file C:\\Users\\t\\avrdude.rc does not exist
Using port            : COM3
Using programmer      : arduino
Setting baud rate     : 115200
Error: stk500_getsync() attempt 1 of 10: not in sync: resp=0x00
Error: stk500_getsync() attempt 10 of 10: not in sync: resp=0x00

Avrdude done.  Thank you.
Failed uploading: uploading error: exit status 1
`;
const NOT_IN_SYNC_V6 = "avrdude: stk500_recv(): programmer is not responding\navrdude: stk500_getsync() attempt 10 of 10: not in sync: resp=0x1c\n";
const ACCESS_DENIED_V8 = "Using port            : COM3\nOS error: cannot open port \\\\.\\COM3: Access is denied.\n\nError: unable to open port COM3 for programmer arduino\nFailed uploading: uploading error: exit status 1\n";
const ACCESS_DENIED_V6 = 'avrdude: ser_open(): can\'t open device "\\\\.\\COM3": Access is denied.\n';
// Real arduino-cli 1.5.1 / avrdude 8.0 runs in the dev container: a missing port, a pty held with TIOCEXCL, and a
// silent pty (no bootloader). The banner's "does not exist" (no ~/.avrduderc) must not read as a missing port.
const BANNER = "Avrdude version 8.0-arduino.1\nSystem wide configuration file is /opt/avrdude/etc/avrdude.conf\nUser configuration file /home/barry/.avrduderc does not exist\n\n";
const NO_SUCH_PORT = `${BANNER}Using port            : /dev/ttyUSB9\nOS error: cannot open port /dev/ttyUSB9: No such file or directory\nError: unable to open port /dev/ttyUSB9 for programmer arduino\n`;
const LINUX_BUSY = `${BANNER}Using port            : /dev/pts/7\nOS error: cannot open port /dev/pts/7: Device or resource busy\nError: unable to open port /dev/pts/7 for programmer arduino\nFailed uploading: uploading error: exit status 1\n`;
const SILENT_PORT_V8 = `${BANNER}Using port            : /dev/pts/7\nError: programmer is not responding\nWarning: attempt 10 of 10: not in sync: resp=0x00\nError: unable to open port /dev/pts/7 for programmer arduino\n\nAvrdude done.  Thank you.\nFailed uploading: uploading error: exit status 1\n`;

describe("parseBoardList", () => {
  it("keeps only serial ports with a board profile's USB ID", () => {
    expect(parseBoardList(BOARD_LIST)).toEqual([
      { port: "COM3", label: "COM3 · CH340 (common clone)", vid: 0x1a86, pid: 0x7523 },
      { port: "COM4", label: "COM4 · Arduino Uno", vid: 0x2341, pid: 0x0043, boardFqbn: "arduino:avr:uno" },
    ]);
  });

  it("reads an empty list (no board plugged in)", () => {
    expect(parseBoardList('{\n  "detected_ports": []\n}')).toEqual([]);
    expect(parseBoardList("{}")).toEqual([]);
  });
});

describe("classifyUpload", () => {
  it("accepts a clean exit", () => {
    expect(classifyUpload({ code: 0, output: SUCCESS, timedOut: false })).toEqual({ ok: true });
  });

  it.each([
    ["avrdude 8 not in sync", NOT_IN_SYNC_V8, "not_in_sync"],
    ["avrdude 6 not in sync", NOT_IN_SYNC_V6, "not_in_sync"],
    ["avrdude 8 access denied", ACCESS_DENIED_V8, "port_busy"],
    ["avrdude 6 can't open device", ACCESS_DENIED_V6, "port_busy"],
    ["missing port", NO_SUCH_PORT, "port_missing"],
    ["linux port held by another program", LINUX_BUSY, "port_busy"],
    ["silent port (avrdude 8 also says unable to open port)", SILENT_PORT_V8, "not_in_sync"],
    ["linux permission", "OS error: cannot open port /dev/ttyUSB0: Permission denied\n", "permission_denied"],
    ["wrong chip", "Error: expected signature for ATmega328P is 1E 95 0F\n", "wrong_chip"],
    ["avrdude 8 read-back mismatch", "Writing | ################################################## | 100% 0.40 s\nReading | ################################################## | 100% 0.30 s\nError: flash verification mismatch\n        device 0x0c != input 0x0d at addr 0x0000 (error)\n", "verify_failed"],
    ["avrdude 6 read-back mismatch", "avrdude: verification error, first mismatch at byte 0x0000\n         0x0c != 0x0d\navrdude: verification error; content mismatch\n", "verify_failed"],
    ["anything else", "Error: something new\n", "upload_failed"],
  ])("%s", (_name, output, code) => {
    const verdict = classifyUpload({ code: 1, output, timedOut: false });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.error.code).toBe(code);
  });

  it("reports a timeout before reading the output, and a missing arduino-cli as a toolchain problem", () => {
    expect(classifyUpload({ code: null, output: NOT_IN_SYNC_V8, timedOut: true })).toMatchObject({ ok: false, error: { code: "timeout" } });
    const enoent = Object.assign(new Error("spawn arduino-cli ENOENT"), { code: "ENOENT" });
    expect(classifyUpload({ code: null, output: "", timedOut: false, error: enoent })).toMatchObject({ ok: false, error: { code: "toolchain_missing" } });
  });
});

describe("createNativeFlasher", () => {
  function fakeRunner(uploadOutput: { code: number; output: string }): { run: ProcessRunner; calls: { command: string; args: string[]; timeoutMs: number }[] } {
    const calls: { command: string; args: string[]; timeoutMs: number }[] = [];
    const run: ProcessRunner = async (command, args, options) => {
      calls.push({ command, args, timeoutMs: options.timeoutMs });
      if (args.includes("board")) return { code: 0, output: BOARD_LIST, timedOut: false };
      for (const line of uploadOutput.output.split("\n")) if (line) options.onLine?.(line);
      return { ...uploadOutput, timedOut: false };
    };
    return { run, calls };
  }

  it("uploads to a listed port with the board profile's FQBN as separate arguments, streaming lines", async () => {
    const { run, calls } = fakeRunner({ code: 0, output: SUCCESS });
    const lines: string[] = [];
    const result = await createNativeFlasher({ run }).flash({ port: "COM3", board: "nano-atmega328p-old-5v", hex: ":00000001FF\n", onLine: (line) => lines.push(line) });
    expect(result).toMatchObject({ ok: true, fqbn: "arduino:avr:nano:cpu=atmega328old" });
    expect(calls[0].args[0]).toBe("--config-file");
    expect(calls[0].args.slice(2)).toEqual(["board", "list", "--format", "json"]);
    const upload = calls[1];
    expect(upload.timeoutMs).toBe(60_000);
    const at = (flag: string): string => upload.args[upload.args.indexOf(flag) + 1];
    expect(at("--fqbn")).toBe("arduino:avr:nano:cpu=atmega328old");
    expect(at("--port")).toBe("COM3");
    expect(at("--input-file")).toMatch(/firmware\.hex$/);
    // avrdude reads the flash back (the platform's -V is dropped), like the Web Serial flasher's verify.
    expect(upload.args).toContain("--verify");
    expect(upload.args.at(-1)).toBe("--verbose");
    expect(lines).toContain("2462 bytes of flash written");
  });

  it("rejects a port that board list did not report without running the upload", async () => {
    const { run, calls } = fakeRunner({ code: 0, output: SUCCESS });
    const flasher = createNativeFlasher({ run });
    for (const port of ["COM5", "COM3 & calc.exe", "/dev/ttyS0", "COM1"]) {
      await expect(flasher.flash({ port, board: "uno-r3-atmega328p-5v", hex: ":00000001FF\n" })).rejects.toMatchObject({ status: 400, code: "port_not_listed" });
    }
    expect(calls.every((call) => call.args.includes("board"))).toBe(true);
  });

  it("returns the classified failure with the uploader's output", async () => {
    const { run } = fakeRunner({ code: 1, output: ACCESS_DENIED_V8 });
    const result = await createNativeFlasher({ run }).flash({ port: "COM3", board: "uno-r3-atmega328p-5v", hex: ":00000001FF\n" });
    expect(result).toMatchObject({ ok: false, error: { code: "port_busy" }, fqbn: "arduino:avr:uno" });
    expect(result.output).toContain("Access is denied");
  });

  it("reports a missing arduino-cli when listing ports", async () => {
    const enoent = Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
    const flasher = createNativeFlasher({ run: async () => ({ code: null, output: "", timedOut: false, error: enoent }) });
    await expect(flasher.listPorts()).rejects.toBeInstanceOf(NativeFlashError);
    await expect(flasher.listPorts()).rejects.toMatchObject({ status: 503, code: "toolchain_missing" });
  });
});

describe("runProcess", () => {
  it("passes arguments verbatim, without a shell", async () => {
    const script = "for (const arg of process.argv.slice(1)) console.log(arg)";
    const lines: string[] = [];
    const outcome = await runProcess(process.execPath, ["-e", script, "COM3 & echo pwned", "$(id)", "a;b|c"], { timeoutMs: 10_000, onLine: (line) => lines.push(line) });
    expect(outcome.code).toBe(0);
    expect(lines).toEqual(["COM3 & echo pwned", "$(id)", "a;b|c"]);
  });

  // A real child process must be killed, so the deadline is real time (kept short); fake timers can't stop a process.
  it("kills a process that outlives the timeout", async () => {
    const outcome = await runProcess(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { timeoutMs: 200 });
    expect(outcome.timedOut).toBe(true);
    expect(classifyUpload(outcome)).toMatchObject({ ok: false, error: { code: "timeout" } });
  });
});
