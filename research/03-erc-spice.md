# ViBread — ERC, Arduino design rules, and SPICE

**Research date:** 2026-09-25 (the event window is ~36 h).  **Target:** Uno R3/Nano-class hardware using an ATmega328P unless the user selects another board.  **Evidence policy:** primary project documentation, manufacturer datasheets/model files, and repository metadata are linked inline.  “Latest” and star counts below are snapshots observed during this research; do not make them runtime assumptions.

## 1) Scope

This slice covers:

1. Industry ERC practice (KiCad pin electrical types, conflict matrix, power flags; SKiDL ERC; TypeScript/Circuit-JSON checks), and whether ViBread can reuse an ERC engine directly on its board/netlist IR.
2. Numeric Uno/ATmega328P breadboard rules: current, rail budgets, LED/button/ADC/communications/motor/level-shifting/protection/decoupling/short rules.
3. Headless SPICE choices on Linux and browser/WASM options, with a TypeScript integration recommendation.
4. Practical device models for the requested Arduino parts and loads, with provenance and model-license cautions.
5. Existing SPICE/ERC MCP servers and tools, evaluated against the project rubric (maintained, substantive, secure, Linux/headless, compatible license, stdio or Streamable HTTP).
6. What DC operating-point and transient SPICE can and cannot establish about a solderless-breadboard build.

This report does **not** claim that an analog simulator can emulate Arduino firmware or prove physical wiring. MCU timing/logic simulation belongs to slice 04; firmware compilation/testing belongs to slice 05; physical self-test/photo verification belongs to slice 06.

**Board assumption caveat.** The Arduino Uno R3 is ATmega328P/5 V, while Uno R4 uses a Renesas RA4M1 and has materially different pin/ADC/current/boot behavior. ESP32 and RP2040/Pico are also different voltage/current/peripheral targets. Every check should therefore carry a `boardProfile` and must refuse to apply ATmega328P values to an unrecognized board. The official Uno R3 page identifies the ATmega328P board and links the board pinout/schematic: <https://docs.arduino.cc/hardware/uno-rev3>.

## 2) Industry standard

### 2.1 ERC is a typed-connectivity analysis, not a SPICE simulation

Professional EDA ERC normally annotates each schematic pin with an electrical type and checks the connected net against pairwise conflict/drive rules. It catches structural/electrical-intent errors (for example, output-to-output, undriven input, missing power source, no-connect inconsistency), but it does not calculate the analog operating point, account for a particular breadboard's spring contact, or know whether a component is counterfeit.

KiCad's reference manual explicitly says that ERC checks unconnected pins, illegal connections, and shorted outputs and reports errors/warnings by severity (<https://docs.kicad.org/9.0/en/eeschema/eeschema.html#erc>). It also warns that a symbol's electrical type must be correct or ERC results can be invalid (<https://docs.kicad.org/9.0/en/eeschema/eeschema.html#pin-electrical-types>). This is the important industry practice for ViBread: the LLM must emit pin semantics and the QA layer must keep those semantics separate from analog values.

KiCad 9's built-in pin types are Input, Output, Bidirectional, Tri-state, Passive, No-connect, Unspecified, Power input, Power output, Open collector, and Open emitter. The manual defines their intended driving/conflict behavior (<https://docs.kicad.org/9.0/en/eeschema/eeschema.html#pin-electrical-types>). KiCad's source contains the actual default conflict matrix, in row/column order `I, O, Bi, 3S, Pas, NIC, UnS, PwrI, PwrO, OC, OE, NC`, with `OK`, warning, and error values (<https://docs.kicad.org/doxygen/erc__settings_8cpp_source.html#l43>).

A compact reading of that matrix is:

- Inputs may connect to a driver, passive component, bidirectional/tristate/open-collector/open-emitter net; an undriven input is separately reported.
- Output-to-output is an error by default. Power-output-to-power-output is also an error; this avoids silently shorting two supplies.
- Passive pins are permissive because resistors, capacitors, LEDs, and connector contacts do not assert logic drive.
- Open-collector/open-emitter pins can share an appropriately typed wired net but conflict with ordinary push-pull outputs.
- Unconnected (`NC`) pins are deliberately not legal to connect; an ordinary unconnected pin needs a no-connect flag or an ERC diagnostic.
- Unspecified pins are intentionally conservative warnings rather than silently accepted.

KiCad's `PWR_FLAG` is a one-pin Power output symbol used to tell ERC that a power net really has a source. Without one, a rail containing only power-input pins produces “Input Power pin not driven by any Output Power pins”; the same manual notes that a regulator's ground pin is often power-input, so ground frequently needs its own flag (<https://docs.kicad.org/9.0/en/eeschema/eeschema.html#pwr-flag>). The default matrix and power-flag mechanism are useful semantics to reproduce, but copying KiCad implementation code or symbol libraries is unnecessary and conflicts with the “write our app this weekend” rule.

KiCad exposes this checker headlessly. `kicad-cli sch erc` accepts a schematic, supports report or JSON output, severity filters, and `--exit-code-violations` (exit code 5 when violations exist) in the official CLI manual (<https://docs.kicad.org/9.0/en/cli/cli.html#schematic-erc>). This is the strongest reusable ERC engine found, but it consumes a KiCad schematic (`.kicad_sch`), not an arbitrary JSON netlist. It therefore requires a faithful temporary schematic generator and symbol/pin metadata; otherwise it is safer to run it only as a second opinion.

### 2.2 SKiDL ERC

SKiDL is MIT-licensed and programmatic Python circuit capture. Its ERC module checks parts, pins, and nets for unconnected pins, pin conflicts, and insufficient drive strength; circuit-level ERC merges net segments before checking once per net, and the functions can be customized (<https://devbisme.github.io/skidl/api/html/rst_output/skidl.erc.html>). Repository metadata observed during the research showed 1,670 stars, MIT license, and a push on 2026-09-24 (<https://api.github.com/repos/devbisme/skidl>).

SKiDL is reusable if the whole design is represented as SKiDL objects, but it is **not** a drop-in TypeScript/netlist engine: its inputs are Python `Circuit`, `Part`, `Pin`, and `Net` objects, and its checks do not provide the Uno-specific resource/voltage/model rules ViBread needs. Introducing a Python subprocess solely to call SKiDL would add serialization, startup, and Python-environment failure modes in a 36-hour build. Recommendation: use SKiDL as a reference for rule categories or an optional offline oracle, not as the critical path.

### 2.3 Other open checks

`@tscircuit/checks` is TypeScript and runs over tscircuit “soup”/Circuit JSON. Its documented aggregate functions cover placement, netlist connectivity, pin specification (including “no power pin” and “no ground pin”), schematic layout, and PCB routing (<https://github.com/tscircuit/checks>). Repository metadata observed on 2026-09-25 showed 4 stars, 48 forks, 614 commits, and a push that day, but no declared license in GitHub metadata (<https://api.github.com/repos/tscircuit/checks>). It is useful for structural/Circuit-JSON checks if ViBread chooses that IR, but it is not a KiCad-equivalent electrical pin conflict matrix and its license must be clarified before shipping.

FixturFab's `kicad-utilities-wasm` compiles KiCad validation/export tools to WASM and documents 42 ERC violation types and ERC JSON output (<https://github.com/FixturFab/kicad-utilities-wasm>). It is a potentially interesting browser option, but its GitHub metadata has no declared license, only 2 stars, and the last observed push was 2026-06-12 (<https://api.github.com/repos/FixturFab/kicad-utilities-wasm>). It also inherits the complexity and copyleft obligations of porting KiCad; do not make it the hackathon critical path.

### 2.4 Reuse decision

There is no mature, permissively licensed, headless ERC library discovered that accepts ViBread's compact TypeScript netlist plus Arduino board semantics directly. The boring, maintainable split is:

1. **BUILD** a deterministic TypeScript ERC/resource checker over ViBread IR, with explicit pin types and board-profile rules.
2. **WRAP/OPTIONALLY USE** `kicad-cli sch erc` when a high-fidelity KiCad schematic is generated. Treat its JSON as an independent cross-check, not as the source of truth.
3. **Do not copy** KiCad/SKiDL/competitor application code. Reuse public formats, subprocesses, and dependency packages only.

## 3) Existing MCP servers & tools

The table includes MCP servers found by GitHub/npm/search, plus the two best non-MCP engines that matter to a wrapper. “Last activity” is the latest repository signal available in the snapshot; `[UNVERIFIED]` means the page did not expose a reliable date. Stars are included as a maintenance signal, not as quality proof.

| name | URL | license | last activity | transport | capabilities | verdict |
|---|---|---|---|---|---|---|
| KiCad `kicad-cli sch erc` (not MCP) | <https://docs.kicad.org/9.0/en/cli/cli.html#schematic-erc> | GPL-3-or-later software; docs GPL/CC BY 3+ | KiCad 9.0.9 docs; 10.0.6 release published 2026-08-29 (<https://github.com/KiCad/kicad-source-mirror/releases/tag/10.0.6>) | local subprocess | Full KiCad schematic ERC, severity policy, JSON report, exit code | **good** as an optional wrapper; it needs a generated `.kicad_sch` and GPL/process boundary review |
| SKiDL `skidl.erc` (not MCP) | <https://devbisme.github.io/skidl/api/html/rst_output/skidl.erc.html> | MIT | push 2026-09-24; 1,670 stars (<https://api.github.com/repos/devbisme/skidl>) | Python in-process/CLI | Pin/net/part checks, drive strength, customizable rules | **usable** as a reference or offline oracle; Python and object-model mismatch |
| `@tscircuit/checks` (not MCP) | <https://github.com/tscircuit/checks> | No GitHub license declared [UNVERIFIED] | push 2026-09-25; 4 stars (<https://api.github.com/repos/tscircuit/checks>) | TypeScript in-process | Circuit JSON structure, pins, connectivity, PCB geometry/routing | **usable** for structural checks only; not an electrical ERC replacement and license must be clarified |
| FixturFab `kicad-utilities-wasm` (not MCP) | <https://github.com/FixturFab/kicad-utilities-wasm> | No GitHub license declared [UNVERIFIED] | push 2026-06-12; 2 stars (<https://api.github.com/repos/FixturFab/kicad-utilities-wasm>) | Node/browser WASM | 42 ERC types, JSON; also DRC/STEP/DSN/SES | **toy/usable** for experimentation; undocumented license and heavy KiCad/WASM coupling |
| `gtnoble/ngspice-mcp` | <https://github.com/gtnoble/ngspice-mcp> | MIT (repository page) | 11 commits, 18 stars, exact latest date [UNVERIFIED] (<https://github.com/gtnoble/ngspice-mcp>) | MCP stdio (D binary) | Ngspice shared library; load netlist, run op/DC/AC/transient, list plots/vectors, retrieve data | **usable**; substantive, but D compiler + native `libngspice` ABI + shared-library isolation add setup risk |
| `Casys-AI/mcp-spice` | <https://github.com/Casys-AI/mcp-spice> | MIT | push 2026-09-08; 1 star (<https://api.github.com/repos/Casys-AI/mcp-spice>) | stateless Streamable HTTP `/mcp` (project docs/search) | Hash-addressed netlist submit; server-owned `.control`; bounded op/reduced transient; scalar/node summaries; blocks `.include/.lib/.shell` | **usable** as a security pattern or optional wrapper; too young/small and intentionally lacks sweeps/external model libraries/full waveforms |
| `internet-dot/spicebridge` fork / parent `clanker-lover/spicebridge` | <https://github.com/clanker-lover/spicebridge> | GPL-3.0 | parent push 2026-04-06, 37 stars; fork push 2026-04-08, 0 stars (<https://api.github.com/repos/internet-dot/spicebridge>) | stdio and Streamable HTTP; optional Cloudflare tunnel | 28 tools, templates, netlist generation, AC/DC/transient, measurements, Monte Carlo, KiCad export, cloud setup | **dead/toy for ViBread**: fork is stale, broad “AI design” scope is a competitor/cloning risk, GPL, and cloud shell/tunnel setup is excessive |
| `lucasgerads/spicelib-mcp` | <https://github.com/lucasgerads/spicelib-mcp> | GPL-3.0 | 8 stars, exact latest date [UNVERIFIED] (<https://github.com/lucasgerads/spicelib-mcp>) | stdio | Python `spicelib` wrapper for simulations and raw results | **usable** for personal tooling; GPL/Python dependency and no ERC/Arduino semantics |
| `ghensley/circuit-sim-mcp` / `klonikar/circuit-sim-mcp` fork | <https://github.com/ghensley/circuit-sim-mcp> / <https://github.com/klonikar/circuit-sim-mcp> | No license declared [UNVERIFIED] | parent push 2025-07-11, 1 star; fork push 2026-06-02, 0 stars (<https://api.github.com/repos/klonikar/circuit-sim-mcp>) | [UNVERIFIED] MCP Python server | PySpice/ngspice create/validate/simulate workflow | **dead** for a deadline-critical dependency: tiny, stale parent, no license, forked |

**MCP conclusion.** No candidate is “good” under all five rubric gates and directly supports ViBread's bounded Arduino QA. `Casys-AI/mcp-spice` is the best design reference for hash-addressed, server-owned control blocks and output minimization, but ViBread should BUILD its own narrow MCP server around its own IR and a local ngspice process. This is a clean implementation rather than copying an existing project.

## 4) Recommendation per sub-area

| sub-area | decision | recommendation and rationale |
|---|---|---|
| ERC semantics | **BUILD** | Implement a TS pin/net checker with KiCad-compatible pin types and conflict matrix. The project IR is not a KiCad schematic, and the missing value is Uno-specific resource/level rules. Keep diagnostics stable and cite rule IDs/sources. |
| KiCad cross-check | **WRAP** | Generate a temporary `.kicad_sch` only when needed, invoke `kicad-cli sch erc --format json --exit-code-violations`, parse report, and delete workspace. Use this for demo confidence, not as the only checker. |
| SKiDL | **USE/OPTIONAL** | Use the MIT API/docs as a conceptual reference; do not spawn Python for every request. If a later import path produces SKiDL, run its ERC offline as a second opinion. |
| Arduino board rules | **BUILD** | Put numeric checks in a versioned `boardProfile` (`uno-r3-atmega328p-5v` initially) with rule IDs, source URL, severity, and assumptions. LLM output cannot override a hard electrical limit silently. |
| Analog simulation engine | **USE** | Pin `ngspice-47` as the Linux backend; official download page calls it the latest stable release (<https://ngspice.sourceforge.io/download.html>). It has a mature SPICE deck format and batch/shared APIs. |
| Node integration | **WRAP** | Run `ngspice -b -r result.raw deck.cir` in a short-lived child process with an isolated temporary directory, resource/time limits, and a server-generated `.control` section. Parse raw vectors or `.print` scalars. |
| `libngspice` | **WRAP/LATER** | The official shared library supports callbacks, background execution, data streaming, parameter changes, and stopping a run (<https://ngspice.sourceforge.io/shared.html>). It is faster but ABI/thread/global-state complexity is not justified for the first 36 h. |
| Browser SPICE/WASM | **BUILD/LATER** | Do not make WASM the primary simulator. Existing builds (EEcircuit, wokwi/ngspice-wasm, KiCad WASM) are useful references but have small/uncertain maintenance/licensing signals. Add browser-only visualization after backend proof. |
| Device models | **BUILD + WRAP** | Build a small approved model catalog from datasheet-derived primitives and explicit approximation levels. Allow exact manufacturer files only when their terms permit runtime use; do not commit proprietary model files blindly. |
| MCP server | **BUILD** | `vibread-erc-spice` should expose bounded validation/simulation tools and return deterministic evidence. No arbitrary shell, file paths, `.include`, `.lib`, `.control`, or network fetch from a model request. |

## 5) If BUILD: proposed MCP server and tools

**Proposed name:** `vibread-erc-spice` (stdio for a local Claude Code connection; Streamable HTTP can be added behind the app for A2A/MCP clients).

The server should be a thin adapter around ViBread's own deterministic TS packages, not an LLM agent. The main agent decides what the results mean; these tools report measurements and rule findings.

### 5.1 `erc_validate_design`

**Inputs**

```ts
{
  design: ViBreadDesignIR,       // components, pins, nets, values, board profile
  boardProfile: "uno-r3-atmega328p-5v",
  policy?: { severityOverrides?: Record<string, "error"|"warning"|"info"> }
}
```

**Outputs**

```ts
{
  pass: boolean,
  diagnostics: Array<{
    id: string, severity: "error"|"warning"|"info",
    message: string, nets?: string[], pins?: string[],
    evidence: { rule: string, threshold?: string, sourceUrl: string },
    suggestedFix?: string
  }>,
  summary: { errors: number, warnings: number },
  profile: string
}
```

Checks include graph connectivity, typed pin conflicts, undriven power/input nets, shorts, Uno pin reservations, per-pin/rail budgets, LED resistor presence, ADC/logic-level constraints, motor/inductive protection, and decoupling requirements.

### 5.2 `spice_simulate`

**Inputs**

```ts
{
  netlist: string,              // canonical, generated deck; max size e.g. 256 KiB
  analysis: { type: "op" | "tran" | "dc", step?: number, stop?: number },
  save?: { nodes?: string[], branches?: string[] },
  modelIds?: string[],
  timeoutMs?: number             // server clamps to a safe maximum
}
```

**Outputs**

```ts
{
  pass: boolean, engine: { name: "ngspice", version: string },
  analysis: string,
  convergence: { converged: boolean, stdout: string, stderr: string },
  scalars: Record<string, number>,
  waveforms?: Record<string, { t: number[], y: number[] }>,
  diagnostics: Array<{ id: string, severity: string, message: string }>
}
```

The server owns the deck wrapper and `.control` block. Reject or strip `.control`, `.endc`, `.include`, `.lib`, `.shell`, external paths, shell metacharacters, and unsupported arbitrary code. Better still, accept a structured netlist AST and generate SPICE text; permit only approved primitive/subcircuit model IDs. Run under a temporary directory with a wall-clock timeout and output-size cap. The server must report a non-converged run as **inconclusive/error**, never as a passing circuit.

### 5.3 `spice_sweep_tolerances`

**Inputs:** canonical design/netlist, named component tolerance ranges, analysis, requested metrics, and a bounded sample count (for example, max 64 deterministic corner/Monte-Carlo points).

**Outputs:** per-metric min/max/quantiles, failing sample IDs, and each sample's source values. This is a future-facing tool; deterministic corners are more honest than claiming statistically meaningful Monte Carlo from an uncalibrated hobby-part distribution.

### 5.4 `model_catalog`

**Inputs:** optional category (`led`, `diode`, `bjt`, `mosfet`, `regulator`, `load`) and model ID.

**Outputs:** approved model ID, element/subcircuit text generated by ViBread, pin order, operating envelope, approximation level (`ideal`, `datasheet-fit`, `vendor-file`), provenance URL, license status, and known limitations. No tool should fetch arbitrary model URLs during a user request.

### 5.5 `erc_explain` (optional)

**Inputs:** diagnostic IDs plus design snapshot hash.

**Outputs:** machine-readable causal graph: design net/pin -> rule -> evidence; no new design mutation. Keep explanations deterministic so the LLM cannot turn a warning into a false guarantee.

## 6) Arduino/Uno design-rule table

**Severity vocabulary:** `error` means do not present the circuit as safe/ready; `warning` means simulation/physical test may continue with an explicit caveat; `info` means a placement/resource note. Thresholds marked “design limit” are intentionally below absolute maximum ratings. Absolute maximum is never a recommended operating target.

| rule id | check | threshold / implementation | severity | source |
|---|---|---|---|---|
| `PWR-UNO-VCC` | ATmega328P supply at Uno R3 16 MHz | Use 4.5–5.5 V as the 16 MHz operating envelope; the MCU's general VCC range is 2.7–5.5 V but the datasheet speed grade limits 16 MHz to the higher-voltage range. | error | Microchip ATmega328P datasheet, operating voltage/speed grade: <https://ww1.microchip.com/downloads/en/DeviceDoc/Atmel-7810-Automotive-Microcontrollers-ATmega328P_Datasheet.pdf> |
| `PWR-VIN` | Uno external VIN | Recommend 7–12 V; treat 6–20 V printed board input range as a board-level absolute/input range, not a promise that the regulator can dissipate arbitrary load power. | warning outside recommendation; error outside board range | Uno R3 pinout: <https://docs.arduino.cc/resources/pinouts/A000066-full-pinout.pdf>; Arduino power-supply guidance: <https://support.arduino.cc/hc/en-us/articles/360018922259-What-power-supply-can-I-use-with-my-Arduino-board> |
| `CUR-PIN-DESIGN` | Continuous GPIO source/sink | Design target `I_pin <= 20 mA`; the Uno pinout labels 20 mA as the maximum per I/O pin for the board. Use lower (e.g. 10 mA) when logic-high/low margin matters. | error above 20 mA | Uno R3 pinout: <https://docs.arduino.cc/resources/pinouts/A000066-full-pinout.pdf> |
| `CUR-PIN-ABS` | Absolute per-I/O stress | Never exceed the ATmega328P absolute maximum 40 mA per I/O pin; this is a damage/reliability limit, not a drive recommendation. | fatal/error above 40 mA; error 20–40 mA | ATmega328P datasheet, absolute maximum ratings: <https://ww1.microchip.com/downloads/en/DeviceDoc/Atmel-7810-Automotive-Microcontrollers-ATmega328P_Datasheet.pdf> |
| `CUR-VCC-GND` | Aggregate MCU current | Never exceed 200 mA total DC current through VCC and GND pins; enforce an additional board/supply budget based on regulator/USB source. | error above 200 mA; warning near limit | ATmega328P datasheet, absolute maximum ratings: <https://ww1.microchip.com/downloads/en/DeviceDoc/Atmel-7810-Automotive-Microcontrollers-ATmega328P_Datasheet.pdf> |
| `CUR-3V3` | Uno 3.3 V rail | Board pinout labels maximum +3.3 V pin current as 50 mA. Do not infer this from the ATmega's GPIO rating. | error above 50 mA | Uno R3 pinout: <https://docs.arduino.cc/resources/pinouts/A000066-full-pinout.pdf> |
| `PWR-USB-FUSE` | USB-powered rail budget | Uno schematic uses `MF-MSMF050-2` marked 500 mA in the USB VBUS path. Treat 500 mA as the protection-path rating, not guaranteed user load; include MCU/USB-bridge/LED current before external loads. | warning over 400 mA planned external load; error over 500 mA path budget | Uno R3 schematic: <https://docs.arduino.cc/resources/schematics/A000066-schematics.pdf> |
| `LED-RESISTOR` | GPIO LED current limiting | Require series resistor. Compute `R >= (Vsource - Vf - Vout) / Idesign`, choose next larger E-series value, and use the LED's datasheet Vf at the target current. Arduino's official Fade example uses 220 Ω with an LED on PWM pin 9. | error when no resistor or computed current > design limit | Arduino Fade example: <https://docs.arduino.cc/built-in-examples/basics/Fade/>; Vishay representative Vf bins: <https://www.vishay.com/docs/82554/vlmo1500.pdf> |
| `LED-VF-COLOR` | Color model range | For one representative Vishay family at its stated test currents: super-red/orange/yellow ≈ 1.8–2.4 V at 20 mA; yellow-green ≈ 1.9–2.4 V; true-green ≈ 2.5–3.1 V at 5 mA; blue ≈ 2.65–3.15 V at 5 mA; white example ≈ 3.3–4.2 V at 20 mA. These are part-family bins, not universal “color constants.” | warning if generic color used without part/bin; error if resistor yields overcurrent at max Vf/min Vf as applicable | Vishay VLMS/VLMY/VLMTG/VLMB table: <https://www.vishay.com/docs/82554/vlmo1500.pdf>; white VLMW41: <https://www.vishay.com/docs/81370/vlmw41.pdf> |
| `BTN-PULLUP` | Button input bias | ATmega328P internal pull-up is a weak, variable ~20–50 kΩ class resistor; use `INPUT_PULLUP`, wire switch to GND, and interpret pressed as LOW. The AVR has no symmetric internal pulldown. | error for floating required input; warning for long/noisy wire relying only on weak pull-up | Arduino digital pins guide: <https://docs.arduino.cc/learn/microcontrollers/digital-pins>; button example: <https://docs.arduino.cc/tutorials/generic/digital-input-pullup/> |
| `ADC-RANGE` | ADC voltage range | Single-ended ADC input must be within 0…VREF; 10-bit result is 0…1023. With default Uno reference this is approximately 0…5 V, but check `analogReference()`/AREF configuration. | error outside 0…VREF | Arduino Read Analog Voltage: <https://docs.arduino.cc/built-in-examples/basics/ReadAnalogVoltage/>; ATmega datasheet ADC/AREF: <https://ww1.microchip.com/downloads/en/DeviceDoc/Atmel-7810-Automotive-Microcontrollers-ATmega328P_Datasheet.pdf> |
| `ADC-SOURCE-Z` | ADC settling | Use 10 kΩ as a conservative engineering warning threshold for ordinary Arduino acquisition; the datasheet's actual error depends on sample time, mux switching, source capacitance, and required accuracy, so buffer/slow the acquisition or justify a larger value rather than treating 10 kΩ as an absolute limit. | warning above 10 kΩ; error only when the design explicitly requires full-scale accuracy and has no settling margin | ATmega328P datasheet ADC section/characteristics: <https://ww1.microchip.com/downloads/en/DeviceDoc/ATmega48A-PA-88A-PA-168A-PA-328-P-DS-DS40002061B.pdf>; Arduino analog guidance: <https://docs.arduino.cc/learn/microcontrollers/analog-input> |
| `PWM-PINS` | `analogWrite()` resource | Uno PWM pins are D3, D5, D6, D9, D10, D11. A request for PWM on another pin is not equivalent without a software/timer implementation. | error when sketch/netlist assumes hardware PWM on another pin | Uno R3 pinout: <https://docs.arduino.cc/resources/pinouts/A000066-full-pinout.pdf> |
| `I2C-PINS` | TWI/I2C mapping | Uno R3 A4 = SDA/PC4 and A5 = SCL/PC5. ATmega TWI uses open-drain behavior and needs pull-ups; the datasheet states bus capacitance is limited to 400 pF and pull-up choice depends on speed/load. | error for wrong pins or push-pull assumption; warning if pull-ups absent/unknown | Uno R3 pinout: <https://docs.arduino.cc/resources/pinouts/A000066-full-pinout.pdf>; ATmega TWI section: <https://ww1.microchip.com/downloads/en/DeviceDoc/Atmel-7810-Automotive-Microcontrollers-ATmega328P_Datasheet.pdf> |
| `I2C-CBUS` | I2C bus capacitance | Keep total bus capacitance <= 400 pF for the ATmega TWI specification. Choose pull-up from rise-time/load calculation, not a fixed color-coded value. | warning over 300 pF; error over 400 pF | ATmega328P TWI datasheet section: <https://ww1.microchip.com/downloads/en/DeviceDoc/ATmega48A-PA-88A-PA-168A-PA-328-P-DS-DS40002061B.pdf> |
| `SPI-PINS` | SPI resource mapping | Hardware SPI is D10/SS (PB2), D11/MOSI/COPI (PB3), D12/MISO/CIPO (PB4), D13/SCK (PB5), also on ICSP. | error when a design claims another pin is hardware SPI without an explicit software SPI driver | Uno R3 pinout: <https://docs.arduino.cc/resources/pinouts/A000066-full-pinout.pdf>; ATmega SPI section: <https://ww1.microchip.com/downloads/en/DeviceDoc/Atmel-7810-Automotive-Microcontrollers-ATmega328P_Datasheet.pdf> |
| `SERIAL-USB` | USB serial conflict | D0/RX and D1/TX are the ATmega USART pins and are connected to the Uno USB-serial path. Reserve them when the sketch uses `Serial`/USB logging unless the user explicitly accepts the conflict. | warning or error depending on required USB logging | Uno schematic/pinout: <https://docs.arduino.cc/resources/schematics/A000066-schematics.pdf>; <https://docs.arduino.cc/resources/pinouts/A000066-full-pinout.pdf> |
| `MOTOR-POWER` | Servo/motor rail | Never power a motor/servo coil from a GPIO. Use a separate supply sized for startup/stall current, connect grounds, and model rail droop. Arduino's motor documentation uses an external motor supply and a driver shield. | error for direct GPIO motor load; warning for shared 5 V rail without current/transient evidence | Arduino Motor Shield guidance: <https://docs.arduino.cc/tutorials/motor-shield-rev3/msr3-controlling-dc-motor/> |
| `MOTOR-FLYBACK` | Inductive load protection | Every relay/solenoid/DC motor coil needs a reverse-biased flyback path or an integrated driver with appropriate clamp; use a transistor/MOSFET driver and gate/base resistor. | error when an inductive load has no clamp/driver | Arduino motor/driver guidance: <https://docs.arduino.cc/tutorials/motor-shield-rev3/msr3-controlling-dc-motor/>; load model caveat in §6 |
| `REG-7805` | 7805 headroom/thermal | Require `Vin >= Vout + selected dropout` and check `P ~= (Vin−Vout)*I` against package thermal conditions. TI LM340/LM7805 is a 5 V linear regulator with current limit/thermal shutdown, not a magic motor supply. | error if headroom absent; warning if dissipation not bounded | TI LM7805 datasheet: <https://www.ti.com/lit/ds/symlink/lm7800.pdf> |
| `REG-AMS1117` | AMS1117 headroom | At full load use guaranteed dropout up to 1.3 V; for 3.3 V output require input at least about 4.6 V before tolerances/transients. | error if headroom absent; warning if near dropout | AMS1117 datasheet: <http://www.advanced-monolithic.com/pdf/ds1117.pdf> |
| `LEVEL-5V-IN` | 3.3 V output driving ATmega328P input | At VCC=5 V, a 3.3 V module output is below the AVR's conservative `VIH >= 0.7*VCC` (3.5 V) guarantee. Use a level shifter, open-drain/pull-up arrangement, or verify the exact input threshold. | error for safety-critical digital input; warning only when module/MCU threshold is explicitly documented compatible | ATmega328P electrical characteristics: <https://ww1.microchip.com/downloads/en/DeviceDoc/Atmel-7810-Automotive-Microcontrollers-ATmega328P_Datasheet.pdf> |
| `LEVEL-3V3-OUT` | 5 V output driving 3.3 V module | Do not put a 5 V push-pull output on a module whose input max is VDDIO+0.3 V; use a divider/translator and check the module's own datasheet. | error | Device-specific input absolute-maximum datasheet required; example rule basis is ATmega pin absolute maximum in the same Microchip datasheet |
| `AVCC-CONNECT` | ADC/analog supply | AVCC must be connected to VCC even when ADC is unused; when ADC is used, connect through a low-pass filter as recommended by the datasheet. | error | ATmega328P pin description: <https://ww1.microchip.com/downloads/en/DeviceDoc/Atmel-7810-Automotive-Microcontrollers-ATmega328P_Datasheet.pdf> |
| `DECOUPLE-MCU` | MCU local bypass | Require at least one local 100 nF bypass capacitor per MCU supply domain in the Uno profile (the official Uno schematic shows 100 nF capacitors around the MCU/USB/power domains). Add bulk capacitance near motor/servo supply according to the load. | warning; error when a generated schematic omits all local bypass | Uno R3 schematic: <https://docs.arduino.cc/resources/schematics/A000066-schematics.pdf> |
| `AREF-SAFETY` | AREF configuration | Do not drive AREF directly from 5 V while selecting an internal/default reference; external-reference designs need explicit `analogReference(EXTERNAL)` sequencing and local decoupling. | error for conflicting reference source; warning when AREF is left undocumented | ATmega AREF description: <https://ww1.microchip.com/downloads/en/DeviceDoc/Atmel-7810-Automotive-Microcontrollers-ATmega328P_Datasheet.pdf>; Arduino analog reference: <https://docs.arduino.cc/learn/electronics/low-power/> |
| `BOD-DROOP` | Brown-out/rail transient | Profile the actual fuse setting. ATmega328P BOD levels are approximately 1.8, 2.7, and 4.3 V; a motor/servo transient that crosses the selected threshold can reset the MCU. | warning when transient margin is <10%; error when modeled rail falls below the configured threshold | ATmega BOD description/fuse tables: <https://ww1.microchip.com/downloads/en/DeviceDoc/ATmega48A-PA-88A-PA-168A-PA-328-P-DS-DS40002061B.pdf> |
| `SHORT-GRAPH` | Hard shorts | Reject any net graph that joins VCC/GND, two incompatible supply outputs, or a push-pull output to a rail without an intentional current-limiting element. | error | KiCad pin conflict/power semantics: <https://docs.kicad.org/9.0/en/eeschema/eeschema.html#pin-electrical-types>; ATmega absolute pin limits: <https://ww1.microchip.com/downloads/en/DeviceDoc/Atmel-7810-Automotive-Microcontrollers-ATmega328P_Datasheet.pdf> |
| `BREADBOARD-CURRENT` | Breadboard rail/contact budget | Even if the Uno rail passes its electrical budget, use the specific breadboard's rating (example BusBoard parts are marked 36 V/2 A) and derate for multiple contacts/heating. | warning when load depends on generic breadboard rating; error when chosen board rating is exceeded | BusBoard BB830 family datasheet: <https://www.busboard.com/documents/datasheets/BPS-DAT-(BB830)-Datasheet.pdf> |

### 6.1 Rule implementation details

- **Pin/resource accounting:** A net may have multiple legal passive consumers, but each output pin, regulator output, GPIO current sink/source, and rail current contribution must be counted separately. Do not infer rail current from “number of components.”
- **Uncertainty:** If the user says “blue LED” or “servo” without a part number, select a conservative family range and emit a warning asking for a part number. Never silently use a nominal Vf/current as a guarantee.
- **Severity:** Hard electrical damage risks (direct shorts, overvoltage, >absolute current, missing flyback on an inductive load) are errors. Availability/resource conflicts (D0/D1 logging, PWM pin reuse) are errors when the sketch requires both; otherwise warnings. Unknown board/part profiles block validation.

## 7. SPICE engines and integration

### 7.1 ngspice

The official download page identifies `ngspice-47` as the latest stable end-user release and provides Linux source/build guidance (<https://ngspice.sourceforge.io/download.html>). The project is a mature mixed-level/mixed-signal simulator based on Spice3f5/Cider/XSPICE; its source repository describes ongoing development and shows 280 stars/4,313 commits in the snapshot (<https://github.com/ngspice/ngspice>). The license is heterogeneous by file (Berkeley/new BSD, LGPL components, public-domain/XSPICE, etc.), as documented in `COPYING`; do not assume one blanket license when redistributing linked code (<https://github.com/ngspice/ngspice/blob/master/COPYING>).

**Batch path.** Ngspice's manual says `-b` enters batch mode, `-r rawfile.raw` writes the generated data, and a `.control … .endc` section can run commands; a canonical invocation is `ngspice -b -r rawfile.raw circuitfile.cir` (<https://nmg.gitlab.io/ngspice-manual/analysesandoutputcontrol_batchmode.html>). This maps well to a TS backend: `spawn("ngspice", ["-b", "-r", raw, deck])`, collect exit/stdout/stderr, then parse a bounded raw file. To avoid parser complexity in the first demo, have the server-generated control block issue `.print`/`meas` for requested scalars and optionally retain vectors for plots.

**Shared-library path.** The official shared-library page says a host can load `ngspice.so`, submit a netlist, run in a separate thread, receive data at each time point via callbacks, stop conditionally, and alter model/device parameters (<https://ngspice.sourceforge.io/shared.html>). It is attractive for repeated simulations but introduces native ABI packaging, callback thread safety, process-global simulator state, and memory ownership concerns. Use a worker process or one library instance per worker; do not load it into the HTTP server until the CLI path is proven.

**Recommendation:** **USE ngspice-47 CLI** now; **WRAP libngspice** later only if profiling proves process startup dominates. Estimate: a constrained CLI adapter (deck wrapper, raw/scalar parser, timeout, model catalog) is 4–8 focused hours; shared-library FFI and robust worker isolation is another 8–16 hours.

### 7.2 Xyce

Xyce is a serious open-source, SPICE-compatible analog simulator with DC, transient, AC, noise, harmonic balance, sensitivity, and uncertainty capabilities, and is designed for large/parallel circuits (<https://github.com/Xyce/Xyce>). Its source is GPLv3; official installers include proprietary compact models that are not in the GPL source (<https://xyce.sandia.gov/downloads/>). Linux builds are supported, but building requires C++/possibly Fortran, Trilinos, and optional MPI; the official download page explicitly warns to read the dependency/build guide (<https://xyce.sandia.gov/downloads/>).

Xyce is overkill for Uno LED/button/motor circuits. It is a credible future comparison engine for large or uncertainty-heavy analog designs, but the GPL/dependency cost and SPICE dialect differences make it a **do not add this weekend** choice.

### 7.3 Qucs-S

Qucs-S is a GUI frontend that supports ngspice (recommended), Xyce, SpiceOpus, and Qucsator; its own README says ngspice is a runtime simulator rather than a compile-time dependency (<https://github.com/ra3xdh/qucs_s>). It is GPLv2 and GUI-first (Qt6), so it does not improve a headless TS service. **Do not use** except as a developer desktop for inspecting a deck.

### 7.4 WASM / browser engines

- EEcircuit is an MIT-licensed browser simulator using ngspice compiled to WASM; it runs locally in the browser, plots with WebGL, and keeps schematic/results local (<https://github.com/eelab-dev/EEcircuit>). The repository snapshot shows 185 stars, 808 commits, and an active `gen2-next` branch, but the public product is schematic/UI-oriented rather than a stable ViBread backend API.
- `wokwi/ngspice-wasm` is MIT and documents a Docker/Linux build that produces `build/ngspice.wasm`; the repository snapshot showed only 10 stars and one commit (<https://github.com/wokwi/ngspice-wasm>). It is an implementation reference, not a mature dependency.
- `@tscircuit/ngspice-spice-engine`/EEcircuit-engine and `spice-ts` expose TypeScript/WASM experiments; their package/repository pages show very small versions/usage and optional adapters (<https://github.com/mfiumara/spice-ts>, <https://registry.npmjs.org/@tscircuit/ngspice-spice-engine>). Treat maintenance and model coverage as [UNVERIFIED].
- FixturFab's KiCad WASM project is a separate option for ERC/DRC, discussed above; missing license metadata is a release blocker.

Browser WASM can remove server round trips and is useful for a mobile plot, but it expands bundle/CSP/SharedArrayBuffer/threading/model-loader work. **Recommendation: BUILD backend-first; add WASM only as a post-demo enhancement.** Estimate: 2–4 hours for a thin worker wrapper if an existing pinned package runs; 8–16+ hours if rebuilding or debugging Emscripten/model loading.

### 7.5 Qucs/Spice wrappers

- PySpice is a Python interface to ngspice/Xyce, with subprocess and shared modes, but is GPLv3 (<https://github.com/PySpice-org/PySpice>, <https://pyspice.fabrice-salvaire.fr/releases/v1.6/overview.html>). It is a good laboratory reference, not suitable for adding a Python server to this TypeScript stack under a 36-hour deadline.
- `spicelib` drives LTspice/ngspice/QSPICE/Xyce from Python and is GPLv3; its docs say its ngspice integration is CLI-based and does not yet use the shared library (<https://github.com/nunobrum/spicelib>). It does not buy more than ViBread's own small Node child-process adapter.
- InSpice is a PySpice fork with AGPL/GPL lineage and native shared-library requirements (<https://github.com/insim-ai/InSpice>, <https://pypi.org/project/InSpice/>). Avoid AGPL/copy-left integration.
- LTspice is proprietary and Windows-first; Wine/server automation would introduce a non-Linux redistribution and GUI/CLI stability risk. No need to use it when ngspice is available.

## 8. Device-model catalog

### 8.1 Model policy

A SPICE model file is executable-ish input: it can contain subcircuits, behavioral sources, includes, and simulator directives. ViBread should ship only model text authored by the team or model files whose license permits redistribution. Manufacturer models often have “unpublished licensed software” notices even when downloadable; ON Semiconductor's 2N2222A and 2N3904 files explicitly say commercial use/resale is restricted by a Symmetry Design Systems license (<https://www.onsemi.com/download/models/txt/2n2222a.lib.txt>, <https://www.onsemi.com/download/models/lib/2n3904.lib>). The ON Semiconductor TIP122 file has the same proprietary notice (<https://www.onsemi.com/pub/Collateral/TIP122.SP2>). Therefore, use those files as local reference/calibration inputs only after license review; generate ViBread's own small model cards instead of copying their text into a public hackathon repository.

| device/model | defensible first-pass model | provenance and license treatment |
|---|---|---|
| Red LED | Diode primitive with a fitted `IS`, `N`, `RS`, and junction capacitance; for a named Vishay family use `VF=1.8–2.4 V` at 20 mA and a current limit. | Vishay VLMS1500-family table gives actual bins and test current (<https://www.vishay.com/docs/82554/vlmo1500.pdf>). Datasheet-derived parameters are ViBread-authored; do not claim every red LED has this Vf. |
| Yellow LED | Same diode primitive; representative Vishay VLMY1500 `VF=1.8–2.4 V` at 20 mA. | <https://www.vishay.com/docs/82554/vlmo1500.pdf>; vendor datasheet, no open model-license grant observed. |
| Green LED | Distinguish yellow-green/AlInGaP (`~1.9–2.4 V`) from true-green/InGaN (`~2.5–3.1 V` at 5 mA). | <https://www.vishay.com/docs/82554/vlmo1500.pdf>; do not collapse green technology into one nominal Vf. |
| Blue LED | Diode primitive with representative `VF=2.65–3.15 V` at 5 mA and `Cj` from chosen part. | <https://www.vishay.com/docs/82554/vlmo1500.pdf>. |
| White LED | Model as blue-die-like diode plus phosphor only for optical/UI semantics; electrical first pass uses representative `VF=3.3–4.2 V` at 20 mA from VLMW41. | <https://www.vishay.com/docs/81370/vlmw41.pdf>. The white model is not a photometric/spectral guarantee. |
| 1N4148 | Use the Nexperia model locally for exact part tests, or recreate a simple diode model from its datasheet. Nexperia's public text gives `IS=4.352e-9`, `N=1.906`, `RS=0.6458`, `BV=110`, `CJO=7.048e-13`, `TT=3.48 ns`. | Model text: <https://assets.nexperia.com/documents/spice-model/1N4148.txt>; product datasheet: <https://assets.nexperia.com/documents/data-sheet/1N4148_1N4448.pdf>. No permissive redistribution license was found in the text: mark license [UNVERIFIED], don't commit unchanged. |
| 1N4007 | Use a slow rectifier model with `BV≈1100 V`, `TT≈9.85 µs`, `CJO≈28 pF`, and IV-fit `IS/N/RS`; add temperature and reverse recovery only if needed. | Vishay publishes a SPICE3 text model and the product datasheet: <https://www.vishay.com/docs/88000/1n4007.txt>, <https://www.vishay.com/docs/88503/1n4001.pdf>. Treat the downloadable model's redistribution terms as [UNVERIFIED]; use a ViBread-authored fit. |
| 2N2222A | For switch-level simulation, use a generic NPN with `VBE≈0.7 V`, forced beta, `VCE(sat)` fit to the selected datasheet; for detailed work use a model only with license approval. | ON Semiconductor's downloadable model is proprietary/Symmetry-licensed (<https://www.onsemi.com/download/models/txt/2n2222a.lib.txt>); device datasheet <https://www.onsemi.com/download/data-sheet/pdf/2n2222a-d.pdf>. |
| 2N3904 | Same generic NPN first pass; include base resistor and forced-beta check. | ON Semiconductor model contains explicit “commercial use or resale restricted” notice (<https://www.onsemi.com/download/models/lib/2n3904.lib>); datasheet <https://www.onsemi.com/download/data-sheet/pdf/pzt3904-d.pdf>. |
| TIP120 | Use an NPN Darlington macro approximation (two NPNs, base/emitter shunts, flyback diode only when used as a load driver). Include `VCE(sat)` around 2 V at high current in the power budget; do not model it as a low-loss switch. | ON Semiconductor product/datasheet: <https://www.onsemi.com/products/discrete-power-modules/darlington-transistors/tip120>, <https://www.onsemi.com/download/data-sheet/pdf/tip120-d.pdf>; TIP122 macro model illustrates the topology but is proprietary (<https://www.onsemi.com/pub/Collateral/TIP122.SP2>). |
| IRLZ44N | For low-frequency motor switching, use an N-MOSFET with body diode, `VDS=55 V`, `RDS(on)` at the actual `VGS` (Infineon lists ~35 mΩ at 4.5 V, ~22 mΩ at 10 V), gate charge/capacitance only if edge timing matters. | Infineon product/datasheet: <https://www.infineon.com/part/IRLZ44N>, <https://www.infineon.com/assets/row/public/documents/24/49/infineon-irlz44n-datasheet-en.pdf>. Vendor PSpice libraries exist (<https://www.infineon.com/design-resources/simulation-modeling/power-mosfet-simulation-models>) but license/part availability must be checked. |
| 7805/LM7805 | Behavioral regulator: output clamps to 5 V only when `Vin` exceeds dropout, has current-limit/thermal-warning flags; use a resistor/current sink for first-pass load validation rather than pretending the internal control loop is exact. | TI LM340/LM7805 datasheet: <https://www.ti.com/lit/ds/symlink/lm7800.pdf>. No unencrypted open LM7805 model was verified here. |
| AMS1117 | Behavioral LDO: fixed output, dropout up to 1.3 V at full load, current-limit/thermal flags, required output-capacitor assumption. | AMS official datasheet: <http://www.advanced-monolithic.com/pdf/ds1117.pdf>. Do not import random cloned AMS1117 models without provenance. |
| Passive buzzer | For electrical loading, use a capacitive load or a fitted RLC resonator from the exact buzzer datasheet/measurement; an active buzzer is a current sink/oscillator black box. | Manufacturer-specific datasheet required. The SPICE modeling literature describes deriving a two-terminal piezo equivalent from impedance; see <https://www.researchgate.net/profile/Ratna-Ghosh-2/publication/334167003_Deriving_an_electrical_model_of_a_two_terminal_piezoelectric_buzzer_from_its_impedance_response/links/64748a6e6fb1d1682b1a0138/Deriving-an-electrical-model-of-a-two-terminal-piezoelectric-buzzer-from-its-impedance-response.pdf>. |
| Servo | Do not model pulse width as an analog motor torque guarantee. Represent the servo as a supply current profile (idle/typical/start/stall) plus a logic input, and validate current/brown-out headroom against the exact servo datasheet. | Arduino's own servo project uses an external supply in its example context: <https://docs.arduino.cc/tutorials/iot-bundle/pavlovs-cat/>. Exact current is [UNVERIFIED] without a part number. |
| DC motor | Use `Rcoil + Lcoil` with a back-EMF dependent voltage source and mechanical inertia/friction if speed matters; for GPIO protection, a conservative startup/stall current step is more useful than a guessed motor constant. | Precision Microdrives explains the electrical-mechanical equivalent and SPICE limitations: <https://www.precisionmicrodrives.com/ab-025>. Exact parameters require the motor datasheet or measurement. |
| ATmega328P GPIO output | Use a piecewise/behavioral driver, not a generic 5 V source: at 5 V and 20 mA the datasheet's VOH/VOL guarantees imply roughly <=45 Ω effective high/low drop (`(5−4.1)/20mA` or `0.9V/20mA`), but this is a bound derived from guaranteed test points, not a linear resistance. | ATmega328P electrical characteristics and typical pin-driver curves: <https://ww1.microchip.com/downloads/en/DeviceDoc/Atmel-7810-Automotive-Microcontrollers-ATmega328P_Datasheet.pdf>. |
| ATmega328P internal pull-up | Represent as a resistor range/Monte-Carlo value, e.g. 20–50 kΩ, enabled only in input mode; report pin low current through it and no internal pulldown. | Arduino digital-pins guide and button example: <https://docs.arduino.cc/learn/microcontrollers/digital-pins>, <https://docs.arduino.cc/tutorials/generic/digital-input-pullup/>; verify selected MCU datasheet. |

### 8.2 Model fidelity levels

1. **Ideal connectivity model:** diode/LED threshold, resistor, ideal logic source. Good for detecting missing resistor, gross shorts, and polarity.
2. **Datasheet-fit model:** diode curves, GPIO piecewise output resistance, regulator dropout/current limit, motor current step/RL. Good for nominal voltage/current and transient margin.
3. **Vendor model:** detailed capacitance/recovery/control loop. Use only with exact part number and a redistribution-compatible license.

The UI should label every result with one of these levels. A `PASS` at level 1 must never be phrased as “hardware verified.”

## 9. Integration notes and gotchas for the TypeScript/Bun/Node stack

### 9.1 Canonical deck and process boundary

- Generate netlists from a structured AST, not string concatenation from LLM text. Canonicalize component order, numeric units, node names, and model IDs before hashing.
- Run `ngspice -b -r result.raw deck.cir` from a child process. Set `cwd` to a fresh temp directory; pass an explicit environment with no user `.spiceinit` surprises; kill on timeout; cap stdout/stderr/raw size.
- The server owns `.control` and output requests. Reject `.shell`, `.include`, `.lib`, arbitrary absolute/relative paths, and unsupported behavioral model text. This follows the security shape documented by Casys-AI rather than trusting model-generated directives: <https://github.com/Casys-AI/mcp-spice>.
- Parse and return only requested nodes/branches and compact statistics by default. A full transient waveform can be sampled/downsampled for plotting but should not become an unbounded MCP response.
- Record engine version, deck hash, model IDs, board profile, analysis settings, convergence status, and source citations in the result. Reproducibility matters more than a pretty waveform.

### 9.2 ERC and SPICE are separate evidence streams

A circuit may pass typed ERC but fail SPICE (e.g., an LED has a resistor but the supply collapses), or pass nominal SPICE while failing ERC (e.g., two push-pull outputs happen to settle at a misleading value). Aggregate them as separate diagnostics:

```text
ERC: structural/pin/resource evidence
SPICE: model-based numerical evidence
Firmware: compile/test evidence
Physical: MCU-run or vision evidence
```

Do not let the LLM erase an ERC error because SPICE converged.

### 9.3 KiCad subprocess details

When using the optional KiCad oracle, generate the smallest valid `.kicad_sch` plus project settings in a temp directory, run `kicad-cli sch erc --format json --exit-code-violations`, parse the JSON schema, and map marker positions/pin UUIDs back to ViBread IDs. KiCad's CLI format and exit behavior are documented at <https://docs.kicad.org/9.0/en/cli/cli.html#schematic-erc>. A malformed symbol library or hidden power pin can create misleading ERC; KiCad warns that hidden power pins are legacy behavior and not recommended for new designs (<https://docs.kicad.org/9.0/en/eeschema/eeschema.html#hidden-power-pins>).

### 9.4 Uno R3 vs Uno R4/ESP32/Pico

- Uno R4 is not an ATmega328P board; swap in a Renesas RA4M1 profile, 5 V/3.3 V IO rules, ADC resolution/reference, PWM map, serial/I2C/SPI map, and board rail budget.
- ESP32 modules are generally 3.3 V IO and have different absolute maximums, ADC behavior, bootstrapping pins, and Wi-Fi burst current. Do not reuse the 5 V `VIH=0.7VCC`/20 mA assumptions.
- RP2040/Pico is 3.3 V and its GPIO/ADC/power rules differ; Pico board supply and USB budgets are not Uno values.
- The profile is part of the design hash and appears in every validation/simulation result. If the board is unknown, return `profile_required` instead of a guessed pass.

## 10. Accuracy, limits, and truthful product wording

### 10.1 What DC operating point can establish

With a convergent, correctly wired netlist and suitable models, DC operating point can estimate nominal node voltages, static currents, LED/resistor current, transistor bias, regulator headroom, and obvious rail contention. It can help answer “does this nominal 5 V LED branch draw roughly 8 mA?” and “does the modeled rail exceed the GPIO/rail budget?”

It cannot establish that a physical breadboard is wired correctly, that a button contact is clean, that a part is the stated value, or that a module's hidden onboard regulator/level shifter matches the schematic. Ngspice's convergence is a numerical criterion: the manual describes Newton-Raphson current/voltage tolerances and notes that convergence can fail because of wiring, values, or model parameters (<https://nmg.gitlab.io/ngspice-manual/introduction/convergence.html>, <https://nmg.gitlab.io/ngspice-manual/introduction/convergence/convergencefailure.html>). Convergence means the *model solved*, not that the model is the real hardware.

### 10.2 What transient analysis can establish

Transient analysis can estimate startup/ramp behavior, PWM/logic edge loading, inductive flyback if the coil/diode/driver model is present, rail droop under a modeled current step, and whether a simulated VCC crosses a configured BOD threshold. It can expose gross missing flyback/clamping and inadequate bulk capacitance.

It does not emulate ATmega firmware scheduling, Arduino bootloader/USB timing, servo control loops, breadboard assembly, or measurement-probe loading unless those are explicitly modeled. A servo represented as a current step only answers a supply-margin question; it does not prove position or torque.

### 10.3 Real-world deviations to disclose

- **Component tolerances:** resistor/LED/diode/regulator bins, temperature coefficients, aging, and counterfeit/defective parts are outside a nominal deck unless a tolerance sweep is requested.
- **Breadboard contacts:** spring contact resistance, oxidation, loose jumper wires, split power rails, and intermittent contact are usually absent. BusBoard specifies mechanical/contact construction and a 36 V/2 A class rating but not a universal per-contact impedance (<https://www.busboard.com/documents/datasheets/BPS-DAT-(BB830)-Datasheet.pdf>). Independent measurements report row-to-row parasitic capacitance in the few-pF range and increasing high-frequency error (<https://doi.org/10.22271/27084493.2026.v6.i1a.80>).
- **Parasitics/layout:** wire inductance, rail resistance, decoupling placement, USB cable, regulator thermal path, and motor EMI are layout-dependent. Add conservative R/L/C only when the user supplies a board/load profile.
- **Model coverage:** generic GPIO and regulator models are intentionally coarse. Manufacturer model files may have license restrictions and may still be inaccurate outside their validated operating envelope.
- **Numerical settings:** timestep, tolerances, initial conditions, convergence aids, and simulator dialect change results. Record all of them and expose non-convergence.

### 10.4 Truthful UI/pitch language

Use:

> “Nominal model check: the generated netlist converged in ngspice under the stated Uno profile and predicted [values] at [conditions]. ERC found [diagnostics]. This is not a physical wiring or component-health guarantee; verify on the connected board with the MCU self-test.”

Avoid:

- “SPICE proves the circuit works.”
- “No short is possible.”
- “The breadboard is verified” based on a schematic simulation.
- “3.3 V is always safe for a 5 V input.”

The primary physical claim should come from the MCU-run self-test (slice 06), with photos as secondary evidence. SPICE is a design-time oracle and fault-attribution signal, not a replacement for hardware verification.

## 11. Risks & unknowns

1. **Board not confirmed.** Uno R3/Nano clones vary in USB bridge, regulator, fuse, and pinout. Require a board profile and show assumptions.
2. **ATmega datasheet variants.** Microchip's family PDFs contain different package/temperature sections. Keep source revision and table/page in the profile; do not mix values from ATmega328P automotive and ATmega328/P family tables without checking conditions.
3. **USB budget ambiguity.** The Uno schematic labels a 500 mA USB polyfuse, but hold/trip behavior and available external current depend on board revision, USB host, cable, regulator, and onboard loads. Treat 500 mA as a protection-path ceiling, not a design target.
4. **Vendor model licensing.** Nexperia/Vishay/ON Semiconductor model downloads are not automatically MIT/BSD; ON Semiconductor files explicitly include proprietary Symmetry notices. Use authored approximations in the public repo unless legal terms are clear.
5. **ERC false positives/negatives.** Pin electrical metadata may be wrong or incomplete for modules. Require module pin declarations and allow user-reviewed exceptions with rationale; never let an exception silently disappear.
6. **MCP security.** Netlist/model text can attempt shell/path/include behavior. Structured AST, allowlisted models, temp directories, timeouts, and output limits are mandatory.
7. **SPICE convergence.** A failing run is inconclusive, not a circuit failure; a converged run is not hardware proof. Surface this distinction in API and UX.
8. **WASM schedule risk.** Existing ngspice/KiCad ports have small or unclear maintenance/license signals. Backend CLI first; browser simulation is optional.
9. **Motor/servo variability.** Startup and stall current dominate rail droop but are highly part-specific. Ask for a part number or request a conservative current envelope.
10. **No existing MCP is fully suitable.** The app must build its own narrow bridge; do not clone broad natural-language SPICE competitors such as SpiceBridge.

## 12. Sources

Primary sources used throughout:

1. KiCad Schematic Editor/ERC/pin types/power flags: <https://docs.kicad.org/9.0/en/eeschema/eeschema.html>
2. KiCad ERC default conflict matrix source: <https://docs.kicad.org/doxygen/erc__settings_8cpp_source.html>
3. KiCad CLI `sch erc`: <https://docs.kicad.org/9.0/en/cli/cli.html>
4. KiCad 10.0.6 release metadata: <https://github.com/KiCad/kicad-source-mirror/releases/tag/10.0.6>
5. SKiDL ERC docs: <https://devbisme.github.io/skidl/api/html/rst_output/skidl.erc.html>
6. SKiDL repository metadata/license/activity: <https://api.github.com/repos/devbisme/skidl>
7. tscircuit checks: <https://github.com/tscircuit/checks>, metadata <https://api.github.com/repos/tscircuit/checks>
8. FixturFab KiCad WASM: <https://github.com/FixturFab/kicad-utilities-wasm>, metadata <https://api.github.com/repos/FixturFab/kicad-utilities-wasm>
9. Arduino Uno R3 hardware page: <https://docs.arduino.cc/hardware/uno-rev3>
10. Arduino Uno R3 full pinout: <https://docs.arduino.cc/resources/pinouts/A000066-full-pinout.pdf>
11. Arduino Uno R3 schematic: <https://docs.arduino.cc/resources/schematics/A000066-schematics.pdf>
12. Arduino Fade example: <https://docs.arduino.cc/built-in-examples/basics/Fade/>
13. Arduino digital pins / `INPUT_PULLUP`: <https://docs.arduino.cc/learn/microcontrollers/digital-pins>
14. Arduino pull-up button example: <https://docs.arduino.cc/tutorials/generic/digital-input-pullup/>
15. Arduino analog input/reference examples: <https://docs.arduino.cc/built-in-examples/basics/ReadAnalogVoltage/>, <https://docs.arduino.cc/learn/microcontrollers/analog-input>
16. Microchip ATmega328P datasheet: <https://ww1.microchip.com/downloads/en/DeviceDoc/Atmel-7810-Automotive-Microcontrollers-ATmega328P_Datasheet.pdf>
17. Microchip ATmega family datasheet revision with electrical tables: <https://ww1.microchip.com/downloads/en/DeviceDoc/ATmega48A-PA-88A-PA-168A-PA-328-P-DS-DS40002061B.pdf>
18. Ngspice downloads/latest stable release: <https://ngspice.sourceforge.io/download.html>
19. Ngspice batch manual: <https://nmg.gitlab.io/ngspice-manual/analysesandoutputcontrol_batchmode.html>
20. Ngspice shared library: <https://ngspice.sourceforge.io/shared.html>
21. Ngspice license notes: <https://github.com/ngspice/ngspice/blob/master/COPYING>
22. Xyce repository/license/capabilities: <https://github.com/Xyce/Xyce>
23. Xyce official downloads/build requirements: <https://xyce.sandia.gov/downloads/>
24. Qucs-S: <https://github.com/ra3xdh/qucs_s>
25. EEcircuit browser ngspice/WASM: <https://github.com/eelab-dev/EEcircuit>
26. wokwi ngspice WASM: <https://github.com/wokwi/ngspice-wasm>
27. PySpice: <https://github.com/PySpice-org/PySpice>, <https://pyspice.fabrice-salvaire.fr/releases/v1.6/overview.html>
28. spicelib: <https://github.com/nunobrum/spicelib>
29. Casys-AI MCP SPICE: <https://github.com/Casys-AI/mcp-spice>
30. gtnoble ngspice MCP: <https://github.com/gtnoble/ngspice-mcp>
31. SpiceBridge parent/fork: <https://github.com/clanker-lover/spicebridge>, <https://github.com/internet-dot/spicebridge>
32. spicelib MCP: <https://github.com/lucasgerads/spicelib-mcp>
33. circuit-sim MCP parent/fork: <https://github.com/ghensley/circuit-sim-mcp>, <https://github.com/klonikar/circuit-sim-mcp>
34. Vishay LED family models/datasheets: <https://www.vishay.com/docs/82554/vlmo1500.pdf>, <https://www.vishay.com/docs/81370/vlmw41.pdf>
35. Nexperia 1N4148 model/datasheet: <https://assets.nexperia.com/documents/spice-model/1N4148.txt>, <https://assets.nexperia.com/documents/data-sheet/1N4148_1N4448.pdf>
36. Vishay 1N4007 model/datasheet: <https://www.vishay.com/docs/88000/1n4007.txt>, <https://www.vishay.com/docs/88503/1n4001.pdf>
37. ON Semiconductor models/datasheets: <https://www.onsemi.com/download/models/txt/2n2222a.lib.txt>, <https://www.onsemi.com/download/models/lib/2n3904.lib>, <https://www.onsemi.com/pub/Collateral/TIP122.SP2>, <https://www.onsemi.com/download/data-sheet/pdf/tip120-d.pdf>
38. Infineon IRLZ44N and model resources: <https://www.infineon.com/part/IRLZ44N>, <https://www.infineon.com/design-resources/simulation-modeling/power-mosfet-simulation-models>
39. TI LM7805: <https://www.ti.com/lit/ds/symlink/lm7800.pdf>
40. AMS1117: <http://www.advanced-monolithic.com/pdf/ds1117.pdf>
41. DC motor SPICE equivalent: <https://www.precisionmicrodrives.com/ab-025>
42. Piezo buzzer equivalent-model paper: <https://www.researchgate.net/profile/Ratna-Ghosh-2/publication/334167003_Deriving_an_electrical_model_of_a_two_terminal_piezoelectric_buzzer_from_its_impedance_response/links/64748a6e6fb1d1682b1a0138/Deriving-an-electrical-model-of-a-two-terminal-piezoelectric-buzzer-from-its-impedance-response.pdf>
43. BusBoard solderless breadboard data: <https://www.busboard.com/documents/datasheets/BPS-DAT-(BB830)-Datasheet.pdf>
44. Breadboard parasitic-capacitance study: <https://doi.org/10.22271/27084493.2026.v6.i1a.80>
45. Arduino motor shield/external motor supply context: <https://docs.arduino.cc/tutorials/motor-shield-rev3/msr3-controlling-dc-motor/>
