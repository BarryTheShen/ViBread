# ViBread Slice 04 — MCU simulation, co-simulation, and behavior tests

**Research cutoff:** 2026-09-25. Maintenance counts and dates below are observations from the linked upstream pages on that date; they are not promises about future releases. `[UNVERIFIED]` means the upstream source did not document the behavior, not that the behavior is impossible. `[ESTIMATE]` marks a hackathon effort estimate rather than a measured result.

## 1) Scope

This slice evaluates firmware/MCU simulation for an Arduino Uno R3/Nano-class ATmega328P first, then the changes needed for Arduino Uno R4 (Renesas RA4M1), ESP32, and RP2040. It covers:

- Wokwi (browser/VS Code/CLI/CI/automation scenarios/custom chips/MCP/pricing/offline behavior).
- MIT `avr8js`, GPL-3 `simavr`, GPL-3 SimulIDE CE, upstream QEMU AVR, Renode, MIT `rp2040js`, and Espressif's QEMU fork.
- Mixed-signal options (ngspice shared library/XSPICE and a pragmatic digital-plus-DC approach).
- A deterministic behavior-test harness, including stimulus timelines, assertions, bounce/sensor sweeps, PWM/serial checks, and reading AVR DDR/PORT registers to compare firmware pin modes with the circuit.
- Device models for the common kit parts named by the project.
- Existing MCP servers and a proposed ViBread MCP surface.

The recommendation is intentionally not an analog-accuracy claim. ViBread should prove firmware behavior, digital protocol timing, pin configuration, and topology-level design mistakes in simulation; it should not claim that simulated voltage/current/noise/mechanical load equals a physical breadboard.

## 2) Industry standard

### 2.1 What established embedded workflows actually separate

Professional embedded validation normally separates at least three layers:

1. **Build and firmware execution:** compile an ELF/HEX for a named MCU/FQBN; run it on a cycle/timing-aware instruction/peripheral model; capture serial, GPIO, timer/PWM, and register traces. `simavr` explicitly loads ELF/HEX and exposes UART, timers, GPIO, ADC, SPI, I2C, EEPROM, watchdog, GDB, and VCD tracing; `avr8js` exposes a modular CPU/peripheral core for browser/Node integration. ([simavr README](https://github.com/buserror/simavr/blob/master/README.md), [avr8js README](https://github.com/wokwi/avr8js/blob/main/README.md))
2. **Digital hardware-in-the-loop style tests:** drive named inputs at virtual times, wait for serial/protocol events, and assert pins or traces. Wokwi's CI scenarios are a public example: YAML `steps` include `delay`, `set-control`, `wait-serial`, `write-serial`, `expect-pin`, touch gestures, and screenshots. ([Wokwi automation scenarios](https://docs.wokwi.com/wokwi-ci/automation-scenarios))
3. **Electrical analysis:** use an ERC/netlist checker and SPICE/DC/AC/transient analysis for analog values, current paths, operating points, and component models. Ngspice's shared API can be controlled from a host and can send values back through callbacks; XSPICE coordinates analog solving with event-driven digital nodes. ([ngspice shared library](https://ngspice.sourceforge.io/shared.html), [XSPICE](https://ngspice.sourceforge.io/xspice.html))

These layers are complementary, not substitutes. An MCU emulator can know that an AVR pin is configured as an output without knowing that an LED is drawing an unsafe current; SPICE can calculate a resistor-divider voltage without executing `digitalRead()` or a UART ISR. ViBread should keep the interfaces explicit and report which layer produced each result.

### 2.2 Candidate comparison

| Candidate | Uno R3 / ATmega328P | Parts/peripherals | Determinism and speed | Embedding | License and practical verdict |
|---|---|---|---|---|---|
| **Wokwi** | Supported ATmega328P Uno/Nano; Wokwi's Uno reference lists CPU, GPIO, timers 0/1/2, watchdog, USART, EEPROM, ADC, SPI master, and I2C master. ([supported hardware](https://docs.wokwi.com/getting-started/supported-hardware), [Uno reference](https://docs.wokwi.com/parts/wokwi-arduino-uno)) | Large supported-part catalog: HC-SR04, DHT22, photoresistor, pushbutton, potentiometer, LCD1602, SSD1306, servo, buzzer, and more. ([supported hardware](https://docs.wokwi.com/getting-started/supported-hardware)) | Virtual-time tests are repeatable, but Wokwi publishes no general cycle-accuracy or benchmark guarantee. CI is cloud/stateless and parallel; the docs advertise speed/convenience rather than a measured faster-than-real-time factor. ([Wokwi CI](https://docs.wokwi.com/wokwi-ci/getting-started)) | Browser/VS Code and CLI; CLI is a useful process-level wrapper but the simulator service is not an open source local library. | CLI repository is MIT, while the simulation service is commercial/cloud. Requires a CLI token for CI/MCP; offline VS Code simulation requires Pro. Excellent demo fallback, not an offline/public-library foundation. ([CLI repository](https://github.com/wokwi/wokwi-cli), [offline mode](https://docs.wokwi.com/vscode/offline-mode), [pricing](https://wokwi.com/pricing)) |
| **`avr8js`** | Primary focus is ATmega328P; modular configurations also cover ATmega2560 and ATtiny examples. ([README](https://github.com/wokwi/avr8js/blob/main/README.md)) | Exported modules implement GPIO, timers 0/1/2, USART, SPI, TWI, ADC, EEPROM, watchdog, clock, and USI. Wokwi's Uno table truthfully qualifies SPI and I2C as master-only and marks analog comparator absent. ([exports](https://raw.githubusercontent.com/wokwi/avr8js/main/src/index.ts), [Uno feature table](https://docs.wokwi.com/parts/wokwi-arduino-uno)) | Cycle counter plus scheduled clock events make a deterministic virtual-time loop. No upstream speed promise; native measurement is required before claiming a factor faster than real time. | MIT TypeScript/JavaScript; direct Node 22/Bun/browser fit; external hardware models and glue are explicitly the application's responsibility. ([README](https://github.com/wokwi/avr8js/blob/main/README.md), [package](https://raw.githubusercontent.com/wokwi/avr8js/main/package.json)) | **Best default core.** Small, embeddable, permissive. We must write the functional device models and own harness, and must document its known edge cases. Latest observed release v0.21.1 (2026-08-31), 846 stars. ([release](https://github.com/wokwi/avr8js/releases/tag/v0.21.1)) |
| **`simavr`** | Mature native AVR simulator; README lists ATmega48/88/168/328 and many related cores. ([README](https://github.com/buserror/simavr/blob/master/README.md)) | EEPROM, watchdog, GPIO/pin interrupts, 8/16-bit timers (normal/CTC/fast PWM), UART TX/RX interrupts, SPI master/slave, I2C master/slave, external interrupts, ADC, self-programming, and extensible custom peripherals. ([README](https://github.com/buserror/simavr/blob/master/README.md)) | Native cycle-level traces and headless CLI; VCD output/input is built in. The project is designed for offline firmware/peripheral tests, but no universal benchmark is published. ([README](https://github.com/buserror/simavr/blob/master/README.md), [CLI source](https://raw.githubusercontent.com/buserror/simavr/master/simavr/sim/run_avr.c)) | C library/CLI; Node would need a subprocess or native FFI. `pysimavr` is a SWIG Python wrapper, not a maintained TypeScript API. ([pysimavr](https://github.com/ponty/pysimavr)) | GPL-3.0. Strong optional oracle/subprocess, but avoid embedding/linking it into a permissively licensed public ViBread app. 1.8k stars; latest observed commit 2026-09-25. ([COPYING](https://github.com/buserror/simavr/blob/master/COPYING), [commit feed](https://github.com/buserror/simavr/commits/master.atom)) |
| **SimulIDE CE** | Runs AVR/Arduino through simavr inside a GUI. ([repository README](https://github.com/SimulIDE/SimulIDE/blob/master/README.md)) | Mixed digital/analog-looking components and MCU GUI/debugger, but the project explicitly says it is **not an accurate circuit-analysis simulator** and models are simple/limited. ([README](https://github.com/SimulIDE/SimulIDE/blob/master/README.md)) | Real-time GUI target, not a documented virtual-time/headless regression engine. The project's command-line forum answer says it cannot be run from the command line for text output. ([basic use](https://simulide.com/p/basic-use/), [CLI forum thread](https://simulide.com/p/forum/topic/running-simulide-from-command-line/)) | Qt desktop application; no documented Node/browser embedding. | GPL-3.0. Useful for a human visual sanity check, not the ViBread backend. Latest tester page observed 2026-05-01; 315 stars. ([license](https://github.com/SimulIDE/SimulIDE/blob/master/LICENSE), [testers](https://simulide.com/p/testers/)) |
| **QEMU upstream AVR** | `qemu-system-avr -M uno`/`-machine uno` resolves to the Arduino Uno machine alias in QEMU's source; it uses ATmega328P. ([Arduino machine source](https://raw.githubusercontent.com/qemu/qemu/master/hw/avr/arduino.c)) | Official docs say the Arduino MCU model is limited to USART and 16-bit timers. Source maps GPIO and 8-bit timers to unimplemented devices and explicitly creates unimplemented TWI, ADC, watchdog, SPI, and EEPROM devices. ([AVR docs](https://qemu-project.gitlab.io/qemu/system/target-avr.html), [ATmega source](https://raw.githubusercontent.com/qemu/qemu/master/hw/avr/atmega.c)) | TCG is generally fast, and QEMU supports GDB/serial, but this board model is far too incomplete for a circuit test. | Headless process/monitor; no useful Uno parts model. | GPL-2.0-or-later for most QEMU. **Do not use for ViBread Uno behavior**; it can be a CPU/USART smoke experiment only. v11.1.1 released 2026-08-26; 13.8k stars. ([QEMU release](https://github.com/qemu/qemu/releases/tag/v11.1.1), [QEMU repository](https://github.com/qemu/qemu), [QEMU COPYING](https://github.com/qemu/qemu/blob/master/COPYING)) |
| **Renode** | No classic Uno R3/ATmega328P board in the current board directory; `arduino_uno_r4_minima.repl` is present. Renode's listed architectures omit AVR. ([board directory](https://github.com/renode/renode/tree/master/platforms/boards), [README](https://github.com/renode/renode/blob/master/README.md)) | Strong full-SoC/peripheral/network emulation and deterministic scripting, but not a ready ATmega328P kit model. Uno R4 Minima maps to a Renesas R7FA4M1A Cortex-M4F platform. ([Uno R4 platform](https://raw.githubusercontent.com/renode/renode/master/platforms/boards/arduino_uno_r4_minima.repl), [RA4M1 platform](https://raw.githubusercontent.com/renode/renode/master/platforms/cpus/renesas-r7fa4m1a.repl)) | Headless Monitor/scripts, deterministic virtual time; not a browser library. | .NET process/shared-library support; substantial setup for this project. ([Monitor CLI](https://renode.readthedocs.io/en/latest/basic/monitor-syntax.html), [latest release](https://github.com/renode/renode/releases/tag/v1.17.0)) | MIT, active (2.9k stars; v1.17.0 released 2026-09-07). Use if board is explicitly changed to Uno R4/RA4M1, not as Uno R3 default. ([license](https://raw.githubusercontent.com/renode/renode/master/LICENSE)) |
| **`rp2040js`** | Not AVR; Raspberry Pi Pico/RP2040 emulator. | JavaScript emulator with UART/GDB/demo firmware support; README notes LittleFS is currently read-only because SSI flash writing is not implemented. ([README](https://github.com/wokwi/rp2040js/blob/main/README.md)) | Deterministic JS/Node/browser style; no published speed benchmark. | MIT package, Node >=18, direct TypeScript integration. Current v1.4.0 released 2026-09-25; 527 stars. ([package](https://raw.githubusercontent.com/wokwi/rp2040js/main/package.json), [release](https://github.com/wokwi/rp2040js/releases/tag/v1.4.0)) | **Use only for RP2040 target variant**, not Uno R3. |
| **Espressif QEMU fork** | Not AVR; ESP32/ESP32-S3 (Xtensa) and ESP32-C3 (RISC-V), with newer target work in the fork. ([ESP-IDF QEMU guide](https://docs.espressif.com/projects/esp-idf/en/stable/esp32/api-guides/tools/qemu.html)) | Feature matrix has UART, GPIO strap, flash, crypto, timers and selected storage/network devices, but marks Wi-Fi, Bluetooth, USB, RMT, GP SPI, I2C, I2S, ULP, and GPIO matrix/IOMUX unsupported for listed targets. ([feature matrix](https://github.com/espressif/esp-toolchain-docs/blob/main/qemu/README.md)) | C QEMU with `-icount`; ESP32-C3 docs require `-icount 3` and describe an emulated 125 MHz instruction time. ([C3 QEMU guide](https://github.com/espressif/esp-toolchain-docs/blob/main/qemu/esp32c3/README.md)) | Headless CLI/GDB, but separate toolchain/flash image and architecture-specific setup. | QEMU GPL-2 with per-file licenses. Use only as an optional ESP-IDF smoke backend; do not use for generic Arduino sensor circuits. Latest tagged release 2026-04-19; latest observed commit 2026-04-29; 353 stars. ([Espressif release](https://github.com/espressif/qemu/releases/tag/esp-develop-9.2.2-20260417), [latest commit](https://github.com/espressif/qemu/commit/febae182e132e4055529be423a818225ebddaa3a), [license](https://raw.githubusercontent.com/espressif/qemu/esp-develop/LICENSE)) |

### 2.3 Wokwi details that affect the decision

**CLI/VS Code/CI.** Wokwi CLI is a TypeScript MIT repository, distributed as prebuilt binaries; its command runs `wokwi.toml` + `diagram.json`, supports serial logs, simulation timeout, GDB, screenshots, VCD export, and diagram linting. The default simulation timeout is 30,000 virtual milliseconds, and CI examples compile first with PlatformIO then call `wokwi-cli . --scenario scenario.yaml`. ([CLI usage](https://docs.wokwi.com/wokwi-ci/cli-usage), [CLI installation](https://docs.wokwi.com/wokwi-ci/cli-installation), [CLI repository](https://github.com/wokwi/wokwi-cli))

**Scenario format.** A scenario has `name`, `version: 1`, optional `author`, and ordered `steps`. Representative syntax:

```yaml
name: button smoke
version: 1
steps:
  - set-control:
      part-id: btn1
      control: pressed
      value: 1
  - delay: 20ms
  - expect-pin:
      part-id: uno
      pin: 13
      expected: 1
  - wait-serial: "ready"
```

The documented steps include `delay`, `expect-pin`, `set-control`, `wait-serial`, `write-serial`, screenshot comparison, and touch press/move/release. The scenario API is explicitly alpha, so ViBread should borrow the shape but version and own its schema. ([automation scenarios](https://docs.wokwi.com/wokwi-ci/automation-scenarios), [CLI scenario source](https://raw.githubusercontent.com/wokwi/wokwi-cli/main/packages/cli/src/TestScenario.ts))

**MCP mode.** The official Wokwi CLI exposes an experimental stdio MCP server with `wokwi-cli mcp`; authentication is the `WOKWI_CLI_TOKEN` from the Wokwi CI dashboard. The source currently advertises `wokwi_start_simulation`, `wokwi_stop_simulation`, `wokwi_resume_simulation`, `wokwi_restart_simulation`, `wokwi_get_status`, `wokwi_write_serial`, `wokwi_read_serial`, `wokwi_read_pin`, `wokwi_set_control`, `wokwi_take_screenshot`, and `wokwi_export_vcd`, plus `wokwi.toml`/`diagram.json` resources. ([MCP docs](https://docs.wokwi.com/wokwi-ci/mcp-support), [tool source](https://raw.githubusercontent.com/wokwi/wokwi-cli/main/packages/cli/src/mcp/WokwiMCPTools.ts), [server source](https://raw.githubusercontent.com/wokwi/wokwi-cli/main/packages/cli/src/mcp/MCPServer.ts))

**Pricing, tokens, and offline.** The current pricing page lists Community at €0/month with unlimited simulations/public projects, Hobby at €5.6/month with 100 fast-build minutes, Hobby+ at €8.1/month with 500, and Pro at €20/seat/month with 1,000 fast-build plus 2,000 CI minutes. Separately, Wokwi CI documents monthly CI limits of 50 minutes free, 200 Hobby/Hobby+, and 2,000 Pro. The CLI and MCP require a valid token; no token is available in the ViBread environment. VS Code offline mode requires Pro and uses a locally cached engine; the CLI's documented `--offline` option is only for linting (skip board-definition download), not a free offline simulation backend. ([pricing](https://wokwi.com/pricing), [CI limits](https://docs.wokwi.com/wokwi-ci/getting-started), [CLI usage](https://docs.wokwi.com/wokwi-ci/cli-usage), [offline mode](https://docs.wokwi.com/vscode/offline-mode))

**Parts and custom chips.** Wokwi documents ATmega328P, ATmega2560, ATtiny85, ESP32 families, STM32 targets, and RP2040; its part catalog includes the kit parts relevant here. The Custom Chips API is beta, supports C or WebAssembly languages (Rust/AssemblyScript), experimental Verilog, timers, GPIO, analog, UART, I2C, SPI, and framebuffers, but models run in Wokwi's simulator rather than as a portable local Node package. ([supported hardware](https://docs.wokwi.com/getting-started/supported-hardware), [Custom Chips API](https://docs.wokwi.com/chips-api/getting-started))

## 3) Existing MCP servers and tools

The rubric requires a maintained, real, headless, sane, license-compatible server. “Usable” below means useful only for the stated sub-area; it does not mean it replaces ViBread's MCU simulator. Stars are the observed GitHub count, not a quality guarantee.

| Name | URL | License | Last activity | Transport | Capabilities | Verdict |
|---|---|---|---|---|---|---|
| **Wokwi CLI MCP** | [repo](https://github.com/wokwi/wokwi-cli), [docs](https://docs.wokwi.com/wokwi-ci/mcp-support) | MIT CLI; cloud simulator/service terms apply | CLI v0.27.1 release 2026-09-16; 66 stars | stdio (`wokwi-cli mcp`) | Start/stop/resume/restart/status; serial read/write; pin reads; part controls; screenshots; VCD export; project resources. ([tools](https://raw.githubusercontent.com/wokwi/wokwi-cli/main/packages/cli/src/mcp/WokwiMCPTools.ts)) | **usable** — real capability and maintained, but experimental, token/cloud dependent, not offline, and not a local embeddable engine. |
| **`@simten/mcp`** | [repo](https://github.com/simtenHQ/simten), [MCP README](https://github.com/simtenHQ/simten/blob/main/packages/mcp/README.md) | Apache-2.0 | 2026-09-24; 18 stars | stdio MCP + localhost WebSocket browser bridge | `check_circuit`, `simulate_circuit`, `verify_circuit`, VCD read, live canvas/state, FPGA run, chat push. It is a TypeScript digital HDL simulator, not an Arduino MCU/peripheral simulator; `verify_circuit` runs local `tsx` without a sandbox. ([MCP README](https://raw.githubusercontent.com/simtenHQ/simten/main/packages/mcp/README.md)) | **usable** for digital-logic experiments, **not a ViBread MCU backend**; inspect/permission its unsandboxed test runner. |
| **`ltspice-mcp` / `ngspice-mcp`** | [repo](https://github.com/Cognitohazard/ltspice-mcp) | GPL-3.0 | 2026-09-11; 46 stars; 749 commits | stdio | Runs LTspice/ngspice/QSPICE/Xyce; named measurements, sweeps, Monte Carlo, waveform analysis, SPICE schematic editing, optional Python code runner. It is analog SPICE, not MCU firmware simulation. ([README](https://github.com/Cognitohazard/ltspice-mcp/blob/master/README.md), [security policy](https://raw.githubusercontent.com/Cognitohazard/ltspice-mcp/master/SECURITY.md)) | **usable** only as an optional analog tool; GPL-3 and its documented local code/simulator execution are unsuitable for direct ViBread embedding without a deliberate isolation/license decision. |
| **`circuit-sim-mcp`** | [repo](https://github.com/ghensley/circuit-sim-mcp) | No repository license file observed **[UNVERIFIED]** | 2025-07-11; 1 star; 4 commits | Python MCP, documented as a local module/stdin server | PySpice/ngspice DC, AC, transient, component creation, validation, plots/export. It has no MCU/Arduino model and its manifest remains version 0.1.0. ([manifest](https://raw.githubusercontent.com/ghensley/circuit-sim-mcp/main/pyproject.toml), [README](https://github.com/ghensley/circuit-sim-mcp)) | **dead** for ViBread; no verified compatible license and stale/very small maintenance signal. |
| **Velxio MCP** | [repo](https://github.com/davidmonterocrespo24/velxio), [MCP docs](https://github.com/davidmonterocrespo24/velxio/blob/master/docs/MCP.md) | AGPL-3.0 | 2026-09-24; 2.9k stars | stdio and SSE/HTTP | Circuit CRUD, Wokwi diagram import/export, Arduino code generation, `arduino-cli` compile, and a `run_project` operation that compiles/marks ready; the documented MCP does not provide an MCU execution engine. It is an existing adjacent project and must not be cloned under the hackathon rule. ([MCP docs](https://raw.githubusercontent.com/davidmonterocrespo24/velxio/master/docs/MCP.md), [license](https://raw.githubusercontent.com/davidmonterocrespo24/velxio/master/LICENSE)) | **toy** for this slice; AGPL-3 and competitor-like scope are additional reasons not to use/copy. |
| **HardwareMCP Arduino server** | [repo](https://github.com/hardware-mcp/arduino-mcp-server) | MIT | 2026-08-22; 19 stars; 19 commits | stdio | Arduino CLI doctor/install, board/port detection, compile/upload, stateful serial sessions, safety preflight, board references. It controls physical hardware; it does not simulate MCU code or parts. ([README](https://github.com/hardware-mcp/arduino-mcp-server/blob/main/README.md), [license](https://raw.githubusercontent.com/hardware-mcp/arduino-mcp-server/main/LICENSE)) | **usable** for a later hardware adapter, **not simulation**. Do not rely on it for laptop Web Serial or closed-loop simulation. |
| **Uno-R3-MCP** | [repo](https://github.com/sushiionwest/Uno-R3-MCP) | MIT | 2026-07-02; 3 stars; 8 commits | stdio | Compile/upload/serial tools for a physical Uno R3 and a deterministic mock serial mode; mock mode is a canned application protocol, not ATmega instruction/peripheral emulation. ([README](https://github.com/sushiionwest/Uno-R3-MCP/blob/main/README.md), [license](https://raw.githubusercontent.com/sushiionwest/Uno-R3-MCP/main/LICENSE)) | **toy** hardware wrapper, not a simulator; do not copy its application code. |

**Bottom line for MCP:** Wokwi is the only discovered existing MCP with actual MCU simulation controls, but it is cloud/token/experimental. ViBread should **wrap** it where available and **build** a local, narrow MCP over `avr8js` for deterministic/offline tests. No candidate provides the required combination of local ATmega execution, custom kit models, DDR↔netlist diagnostics, physical-verification artifacts, and permission-aware tool policy.

## 4) Recommendations per sub-area

### 4.1 Default Uno R3 simulator — **BUILD** on **USE** `avr8js`

- **USE `avr8js` v0.21.1** as the ATmega328P CPU/peripheral dependency. It is MIT, TypeScript, browser/Node-compatible, and already exports the exact core peripherals ViBread needs: GPIO, timers, USART, SPI, TWI, ADC, EEPROM, watchdog, and clock. ([package](https://raw.githubusercontent.com/wokwi/avr8js/main/package.json), [exports](https://raw.githubusercontent.com/wokwi/avr8js/main/src/index.ts))
- **BUILD ViBread's harness and device models** around it. The `avr8js` README explicitly says external functional hardware simulation and glue code are the application's responsibility, and `wokwi-elements` explicitly provides presentation only. ([avr8js README](https://github.com/wokwi/avr8js/blob/main/README.md), [wokwi-elements README](https://github.com/wokwi/wokwi-elements/blob/main/README.md))
- **WRAP Wokwi CLI MCP** as a best-effort cloud backend for a demo or cross-check when `WOKWI_CLI_TOKEN` is supplied; do not make the main path depend on it.
- **Do not use upstream QEMU AVR** for Uno circuit tests: its Uno model leaves all required kit buses/ADC/EEPROM/watchdog unimplemented. ([QEMU ATmega source](https://raw.githubusercontent.com/qemu/qemu/master/hw/avr/atmega.c))
- **Do not embed simavr or SimulIDE** in the public Node application because of GPL-3 obligations and setup/GUI limitations. A separately installed `simavr` process can be an optional oracle in a developer-only mode if legal review accepts GPL process distribution boundaries. ([simavr license](https://github.com/buserror/simavr/blob/master/COPYING), [SimulIDE license](https://github.com/SimulIDE/SimulIDE/blob/master/LICENSE))

### 4.2 Truthful fidelity statement — **BUILD** the contract and report it

ViBread should display this (or equivalent) on every simulation result:

> **Digital firmware simulation:** ATmega328P instruction/peripheral timing is modeled in deterministic virtual time, with protocol-level kit models and observed GPIO/PWM/serial traces. This validates firmware logic, many timing bugs, pin modes, and declared digital wiring behavior. **It is not an electrical SPICE simulation and does not prove safe current, voltage, power, analog noise, EMI, brownout, ADC noise, servo load, acoustic behavior, or breadboard contact quality. Physical MCU self-test remains authoritative.**

This is supported by the limitations documented by Wokwi (digital simulator with basic/limited analog support) and SimulIDE (not accurate for circuit analysis). ([Wokwi analog API](https://docs.wokwi.com/chips-api/analog), [SimulIDE README](https://github.com/SimulIDE/SimulIDE/blob/master/README.md))

### 4.3 Uno R4/RA4M1 — **WRAP** Renode only if target is confirmed

The classic Uno R3 uses ATmega328P and AVR register semantics; Uno R4 Minima uses a Renesas RA4M1/R7FA4M1A Cortex-M4F platform. Renode has an Uno R4 Minima platform file wired to a Cortex-M4F CPU, Renesas ICU/GPT/AGT/SCI/GPIO, but no classic Uno R3 platform in its board directory. ([Wokwi Uno reference](https://docs.wokwi.com/parts/wokwi-arduino-uno), [Renode Uno R4 file](https://raw.githubusercontent.com/renode/renode/master/platforms/boards/arduino_uno_r4_minima.repl), [Renode RA4M1 file](https://raw.githubusercontent.com/renode/renode/master/platforms/cpus/renesas-r7fa4m1a.repl))

If board detection says R4, switch compiler/FQBN, pin map, register inspector, and simulator backend together; never feed AVR `DDRx` heuristics to a Cortex-M board. `[ESTIMATE]` A thin Renode adapter plus one smoke scenario is 4–8 hours after the firmware toolchain is already working; a faithful Uno R4 kit model is not a 36-hour priority.

### 4.4 ESP32 — **WRAP** Wokwi first, Espressif QEMU only for IDF smoke

Wokwi documents broad ESP32 Xtensa/RISC-V family support and the same kit-style parts used by ViBread. Espressif QEMU is useful for ESP-IDF boot/UART/flash/crypto/timer tests, but its public feature matrix explicitly lacks I2C, general-purpose SPI, Wi-Fi, Bluetooth, USB, and GPIO matrix/IOMUX for the listed targets. ([Wokwi supported hardware](https://docs.wokwi.com/getting-started/supported-hardware), [Espressif feature matrix](https://github.com/espressif/esp-toolchain-docs/blob/main/qemu/README.md))

For Arduino-ESP32 sketches with an HC-SR04/LCD/OLED/sensor, use Wokwi cloud if a token exists or build a separate ESP32 backend later. Do not claim that Espressif QEMU has simulated the external circuit when only UART/boot passed.

### 4.5 RP2040 — **USE** `rp2040js` if board selection changes

`rp2040js` is the closest local Node/browser analogue to `avr8js`, is MIT, and currently releases actively; it supports native/MicroPython/CircuitPython demos, UART, and GDB. It has a documented read-only filesystem limitation because SSI flash writing is not implemented. ([rp2040js README](https://github.com/wokwi/rp2040js/blob/main/README.md), [v1.4.0 release](https://github.com/wokwi/rp2040js/releases/tag/v1.4.0))

Keep the board backend interface abstract (`runFirmware`, `readPins`, `driveInput`, `captureSerial`, `trace`) so RP2040 can be added without making ATmega assumptions leak into the IR.

### 4.6 Mixed-signal co-simulation — **BUILD** pragmatic digital + DC; do not couple full SPICE this weekend

Ngspice can be compiled as a shared library, driven from a host, paused/resumed, parameter-mutated, and observed through callbacks. XSPICE adds event-driven digital nodes coordinated with analog solving; its node callbacks report changes after each time step. This is technically viable for a high-fidelity co-simulator. ([ngspice shared API](https://ngspice.sourceforge.io/shared.html), [callbacks](https://nmg.gitlab.io/ngspice-manual/ngspiceassharedlibraryordynamiclinklibrary/sharedngspiceapi/callbackfunctions.html), [XSPICE event data](https://nmg.gitlab.io/ngspice-manual/ngspiceassharedlibraryordynamiclinklibrary/generalremarksonusingtheapi/xspiceeventnodedata.html))

It is not a good 36-hour primary path:

- MCU execution advances at instruction/peripheral cycle granularity while SPICE chooses adaptive analog timesteps; coupling every GPIO edge requires careful zero-crossing, convergence, rollback, and clock-domain policy.
- Ngspice's source tree has intentionally heterogeneous per-file licensing; the copying policy cannot be summarized as one simple permissive license. ([ngspice COPYING](https://raw.githubusercontent.com/ngspice/ngspice/master/COPYING))
- Wokwi explicitly calls itself a digital simulator with limited analog support; the public docs provide no evidence of a general SPICE engine. A Wokwi feature issue reports digital/analog signal-model gaps. ([Wokwi analog API](https://docs.wokwi.com/chips-api/analog), [feature issue](https://github.com/wokwi/wokwi-features/issues/583))
- Tinkercad's public guide describes a browser circuit simulator but does not publish its internal analog/MCU engine or a SPICE claim. Treat any assertion about its internals as `[UNVERIFIED]`; do not reverse engineer or copy it. ([official guide](https://www.tinkercad.com/blog/official-guide-to-tinkercad-circuits))

**Pragmatic design:** run the AVR digital model and, at stable pin-state vectors, evaluate a small safe subset of the circuit: resistor-divider DC, VCC/GND shorts, LED/resistor current estimate, pull-up/pull-down state, and ADC quantization. Add hysteresis/unknown for floating pins and return an explicit `analogApproximation` warning. Do not call this SPICE.

`[ESTIMATE]` For the 36-hour window: 6–8 hours for the `avr8js` runner and scenario assertions, 6–10 hours for five to eight protocol models, 2–4 hours for DDR/netlist diagnostics and traces, and 2–4 hours for the DC-vector evaluator/MCP wrapper. A real ngspice↔MCU co-simulation is likely multiple days once convergence, threading, and model coverage are included; defer it.

### 4.7 Automated behavior harness — **BUILD** a versioned ViBread scenario runner

Use Wokwi's ordered-step shape as inspiration, but define a ViBread-owned JSON/YAML schema so scenarios remain offline and stable. ([Wokwi scenarios](https://docs.wokwi.com/wokwi-ci/automation-scenarios))

**Runner state and timeline**

- Input: compiled ATmega328P ELF (prefer ELF for symbols/debug metadata), board clock (default 16 MHz), circuit IR, device-model parameters, scenario, and a fixed seed.
- Event queue key: `(virtualTimeNs, insertionSequence)`, never wall-clock time. Every input edge, serial byte, timer callback, assertion, and model callback is an event. Stop on a virtual deadline, `wait-serial` match, assertion failure, or firmware exit marker.
- Main loop: execute an AVR instruction, advance `cpu.cycles`, call `cpu.tick()` so scheduled peripheral events/interrupts fire, then drain all same-time external events before the next instruction. The `avr8js` CPU source documents the cycle counter, clock-event queue, and `tick()` mechanism. ([CPU source](https://raw.githubusercontent.com/wokwi/avr8js/main/src/cpu/cpu.ts))
- Artifact: scenario version, seed, virtual duration, serial bytes/lines, pin edge list, PWM measurements, ADC input/read pairs, DDR/PORT snapshots, assertion results, and warnings. Export JSON first; add VCD only after the core path is stable.

**Proposed steps**

```yaml
name: button-to-led
version: 1
seed: 42
steps:
  - expect-serial: { text: "READY", timeout: 500ms }
  - set-digital: { net: button, value: 0 }
  - bounce: { net: button, profile: [1, 0, 1, 0, 0], intervals: [200us, 150us, 300us, 1ms] }
  - expect-pin: { net: led, value: 1, within: 20ms }
  - sweep-analog: { net: pot, values: [0, 1.65, 3.3, 5.0], settle: 5ms }
  - expect-pwm: { net: servo, period: 20ms, high: { min: 900us, max: 2100us }, cycles: 3 }
```

Minimum assertions: `wait/delay`, serial substring/regex and serial write, digital edge/value, PWM period/duty/high-time, ADC result tolerance, I2C/SPI transaction transcript, and register/pin-mode snapshot. Every assertion should report virtual timestamp and observed evidence, not just pass/fail.

**Fault/stimulus injection**

- Button bounce: schedule a deterministic, configurable edge sequence (fixed profile plus seeded random profile); test both bounce shorter/longer than firmware debounce.
- Sensor sweeps: HC-SR04 distances, potentiometer/LDR voltages, DHT temperature/humidity, and servo pulse widths. Keep each test vector explicit in the artifact.
- Serial: inject RX bytes at baud-derived character times; assert TX bytes and line boundaries.
- PWM: capture timestamped rising/falling edges and calculate period/high-width over a window; do not assert only a sampled logic level.
- Fault scenarios: stuck-high/stuck-low input, missing pull-up, delayed sensor response, swapped digital pins, and open circuit. These are software fault models, not proof of physical failure.

**Code↔circuit pin-mode cross-check**

For ATmega328P, `avr8js`'s GPIO configuration gives the relevant register addresses: `PINB/ DDRB/ PORTB = 0x23/0x24/0x25`, `PINC/ DDRC/ PORTC = 0x26/0x27/0x28`, and `PIND/ DDRD/ PORTD = 0x29/0x2a/0x2b`. ([GPIO source](https://raw.githubusercontent.com/wokwi/avr8js/main/src/peripherals/gpio.ts))

At the settled end of `setup()` and whenever a DDR/PORT write occurs, decode each bit:

```text
DDRx bit = 1                  -> OUTPUT
DDRx bit = 0, PORTx bit = 1   -> INPUT_PULLUP
DDRx bit = 0, PORTx bit = 0   -> INPUT (floating unless an external model drives it)
```

Compare this observation with the circuit IR's expected direction and pull resistor. Report mismatches such as “firmware drives an input-only sensor net,” “button input is floating with no pull-up,” “ADC channel is configured as digital output,” or “firmware configured D10 as SPI SS while diagram routes D10 to another device.” Use the Uno pin/function table for D0–D13/A4/A5 and PWM pins; account for alternate functions, direct register writes, bootloader startup, and transient setup states before raising an error. ([Uno pins/functions](https://docs.wokwi.com/parts/wokwi-arduino-uno))

### 4.8 Device behavior models — **BUILD** narrow protocol models; **USE** Wokwi visuals only

`@wokwi/elements` is MIT and has visual elements for many parts, but its own README says it does not provide functional simulation. Wokwi's functional models are part of the Wokwi simulator/custom-chip environment, not a portable open-source device-model package. ([wokwi-elements README](https://github.com/wokwi/wokwi-elements/blob/main/README.md), [license](https://raw.githubusercontent.com/wokwi/wokwi-elements/main/LICENSE), [Custom Chips API](https://docs.wokwi.com/chips-api/getting-started))

| Kit part | Existing evidence | ViBread local model needed |
|---|---|---|
| **Button with bounce** | Wokwi has a pushbutton part and automation control; the open-source element is presentation only. ([button/parts catalog](https://docs.wokwi.com/getting-started/supported-hardware), [elements source](https://github.com/wokwi/wokwi-elements/blob/main/src/pushbutton-element.ts)) | `ButtonModel` with ideal switch plus explicit bounce edge schedule, pull-up/open-circuit behavior, and optional stuck/contact fault. |
| **Potentiometer** | Wokwi documents potentiometer controls and limited analog support. ([potentiometer](https://docs.wokwi.com/parts/wokwi-potentiometer), [analog API](https://docs.wokwi.com/chips-api/analog)) | Map knob fraction to a resistive divider/ADC voltage; include wiper endpoints and optional noise. For 36 h, direct ADC injection plus a documented divider formula is sufficient. |
| **LDR divider** | Wokwi supports a photoresistor and lux control, but its analog API is explicitly basic. ([photoresistor](https://docs.wokwi.com/parts/wokwi-photoresistor-sensor), [analog API](https://docs.wokwi.com/chips-api/analog)) | Convert lux/fixture value to a configured resistance, then evaluate divider voltage; expose a lux sweep and tolerance. Do not claim photometric accuracy. |
| **HC-SR04** | Wokwi documents TRIG ≥10 µs and `Echo` high duration, with `distance_cm = pulse_us / 58`; its part supports 2–400 cm. ([HC-SR04 reference](https://docs.wokwi.com/parts/wokwi-hc-sr04)) | Trigger-edge watcher; schedule ECHO high/low at the configured distance; support timeout/out-of-range/no-echo fault. No acoustic simulation. |
| **SG90 servo** | Wokwi has a standard micro-servo model with 0–180° range and a PWM input, but the open-source element is visual only. ([servo reference](https://docs.wokwi.com/parts/wokwi-servo), [elements README](https://github.com/wokwi/wokwi-elements/blob/main/README.md)) | Decode pulse width and repetition, expose commanded angle/validity and optional mechanical saturation. Do not model torque, supply sag, or actual motion dynamics. |
| **Active/passive buzzer** | Wokwi lists a buzzer part. ([supported hardware](https://docs.wokwi.com/getting-started/supported-hardware)) | Active: output state is sound on/off. Passive: measure PWM frequency/duty and expose tone events; no audio waveform is required for firmware tests. |
| **DHT11** | Wokwi's supported list documents DHT22, not DHT11; DHT11's public datasheet protocol is a 40-bit single-wire frame with host start pulse, 80 µs response, 50 µs bit low phase and width-coded highs. ([Wokwi supported hardware](https://docs.wokwi.com/getting-started/supported-hardware), [DHT11 datasheet](https://osoyoo.com/driver/DHT11-datasheet.pdf)) | Implement a timing state machine: detect host start, drive response/data edges, checksum, minimum read interval, and configurable timeout/CRC fault. Do not substitute DHT22 encoding. |
| **I2C LCD1602** | Wokwi documents both HD44780 parallel and PCF8574T-backed I2C configurations, default address 0x27, and the mapping to LCD control/data bits. ([LCD1602 reference](https://docs.wokwi.com/parts/wokwi-lcd1602)) | Implement an I2C slave byte receiver plus PCF8574/HD44780 command state and a text framebuffer; support 4-bit initialization/custom characters enough for common libraries. Use `wokwi-elements` only to render the framebuffer. |
| **SSD1306 I2C OLED** | Wokwi documents default address 0x3c and 128×64 I2C display; its Custom Chips examples include an SSD1306 model, but that code is for Wokwi's engine. ([SSD1306 reference](https://docs.wokwi.com/parts/board-ssd1306), [Custom Chips examples](https://docs.wokwi.com/chips-api/getting-started)) | Implement I2C control-byte/command parser, page/column addressing, 1 KiB framebuffer, and screenshot/bitmap artifact. Full OLED electrical/optical model is out of scope. |

Open-source `simavr` has an HD44780 board demo, but it is GPL-3 and should be treated as a reference for interface behavior rather than copied into the MIT application. ([simavr README/demo](https://github.com/buserror/simavr/blob/master/README.md), [license](https://github.com/buserror/simavr/blob/master/COPYING))

## 5) BUILD: proposed MCP server and tool surface

### 5.1 Server

**Name:** `vibread-mcu-sim`

**Transport:** stdio first; optional Streamable HTTP only behind ViBread's authenticated agent gateway. The server must not expose arbitrary shell, arbitrary filesystem paths, or arbitrary JavaScript/Python execution. Inputs reference an in-memory firmware artifact or a ViBread workspace artifact ID; project paths are resolved inside an allowlisted workspace.

**Backing library/CLI:**

- `avr8js` MIT for ATmega328P execution/peripherals ([package](https://raw.githubusercontent.com/wokwi/avr8js/main/package.json)).
- ViBread-written TypeScript digital/device models and scenario runner.
- Existing firmware compile artifact from the firmware-toolchain slice (normally `arduino-cli` output ELF/HEX); this server does not silently compile arbitrary source.
- Optional Wokwi adapter using the official `wokwi-cli mcp` or CLI subprocess when a token is explicitly configured ([Wokwi MCP docs](https://docs.wokwi.com/wokwi-ci/mcp-support)).
- Optional ngspice belongs behind a separate analog adapter, not the MCU runner ([ngspice shared API](https://ngspice.sourceforge.io/shared.html)).

### 5.2 Tools

| Tool | Inputs | Outputs |
|---|---|---|
| `mcu_sim_capabilities` | `{ board: "uno-r3" | "uno-r4" | "esp32" | "rp2040" }` | Versioned capability matrix: supported backend, MCU clock, GPIO/ADC/timer/bus limitations, model list, fidelity warnings, and license/runtime metadata. |
| `mcu_sim_run` | `{ firmwareArtifactId, board, circuitIr, scenario, clockHz?, seed?, virtualTimeoutNs?, options? }` | `{ runId, status, board, virtualTimeNs, serial, assertions, pinModes, traces, warnings, artifactIds }`; deterministic result hash includes firmware/circuit/scenario/seed/backend versions. |
| `mcu_sim_step` | `{ runId, until: { virtualNs? | serialText? | eventCount? } }` | New virtual time, newly emitted serial/edges, pending event count, assertion updates. Used for interactive agent conversations without restarting a run. |
| `mcu_sim_drive_input` | `{ runId, net, kind: "digital" | "analog" | "serial", value, atVirtualNs?, durationNs?, bounceProfile? }` | Accepted event ID and resulting output edges/serial; rejects unknown nets, invalid voltages, or events in the past. |
| `mcu_sim_assert` | `{ runId, assertions: [{ kind: "serial" | "pin" | "pwm" | "adc" | "i2c" | "spi" | "register", ... }] }` | Structured pass/fail per assertion with timestamp and observed samples; no bare “not-throw” success. |
| `mcu_sim_inspect` | `{ runId, selectors: ["gpio", "ddr-port", "timers", "adc", "serial", "i2c", "spi", "registers"] }` | Current register snapshots, decoded pin modes, peripheral state, last edges/transactions, and warnings for unsupported reads. |
| `mcu_sim_validate_pin_modes` | `{ runId, circuitIr, atVirtualNs? }` | Code↔circuit findings: expected net direction/pull/ADC versus observed DDR/PORT/PIN/ADC mux, with severity and evidence. |
| `mcu_sim_export_trace` | `{ runId, channels?, format: "json" | "vcd" | "csv" }` | Artifact ID/short-lived download reference for timestamped serial/GPIO/PWM/ADC/register traces. |
| `mcu_sim_stop` | `{ runId }` | Finalized run status and artifact IDs; idempotent. |

**Permission policy:** `mcu_sim_run`, `mcu_sim_drive_input`, and `mcu_sim_stop` are mutating simulation state but not physical hardware. Physical flash/upload remains a separate permission-gated tool requiring ask/review/bypass mode. Wokwi cloud calls must be explicitly labeled `external-cloud` and return token/cloud/retention status.

## 6) Integration notes and gotchas

### 6.1 TypeScript/Bun/Node

- Pin `avr8js` and record its version in results; current package requires Node >=20, so Node 22 is safe. ([package](https://raw.githubusercontent.com/wokwi/avr8js/main/package.json))
- Prefer Node 22 for native CLI and MCP process interoperability; keep simulation code free of DOM APIs so the same runner can execute in Bun/Node and browser workers. `Uint8Array`/typed arrays and the existing `avr8js` event queue avoid per-cycle object churn.
- Use ELF rather than only HEX when symbol/register attribution is needed; have the firmware slice expose a typed artifact contract. Do not parse compiler logs as simulation evidence.
- Run virtual time, not host `setTimeout`, inside the simulation. Host timers are only for MCP request cancellation and UI streaming.
- Bound firmware loops by virtual time/instruction/event count. A stuck `while(1)` is normal Arduino behavior and must stop at a scenario deadline, not hang the MCP process.

### 6.2 Board identity and pin maps

- Uno R3/Nano: ATmega328P, 16 MHz default; D0/D1 USART, D10–D13 SPI, A4/A5 I2C, D3/5/6/9/10/11 PWM, A0–A5 ADC. ([Uno reference](https://docs.wokwi.com/parts/wokwi-arduino-uno))
- Uno R4: RA4M1/Cortex-M4F; different registers, clock/peripheral addresses, voltage assumptions, and Arduino core/FQBN. Use Renode only after explicit board detection and a separate pin-map contract. ([Renode RA4M1 platform](https://raw.githubusercontent.com/renode/renode/master/platforms/cpus/renesas-r7fa4m1a.repl))
- ESP32: pin capabilities, 3.3 V logic, boot straps, flash-reserved pins, and peripheral matrix vary by exact SoC/module; never reuse Uno's physical pin numbers. Wokwi's supported list covers many ESP32 variants but labels some alpha/beta. ([Wokwi supported hardware](https://docs.wokwi.com/getting-started/supported-hardware))
- RP2040: dual-core Cortex-M0+, different GPIO/ADC/PWM/Pio/SIO and UF2/flash workflow; use `rp2040js` or Wokwi, not AVR register logic. ([Wokwi supported hardware](https://docs.wokwi.com/getting-started/supported-hardware), [rp2040js README](https://github.com/wokwi/rp2040js/blob/main/README.md))

### 6.3 `avr8js` known limits to test or disclose

- The Uno reference qualifies SPI and I2C as **master mode only**; TWI source has a no-op handler and a TODO for slave states. ([Uno table](https://docs.wokwi.com/parts/wokwi-arduino-uno), [TWI source](https://raw.githubusercontent.com/wokwi/avr8js/main/src/peripherals/twi.ts))
- Analog comparator is not implemented in the Uno feature table. The ADC model supplies configurable channel voltages and a constant 25 °C temperature value by default, not a physical thermistor/temperature curve. ([Uno table](https://docs.wokwi.com/parts/wokwi-arduino-uno), [ADC source](https://raw.githubusercontent.com/wokwi/avr8js/main/src/peripherals/adc.ts))
- Open upstream issues include sleep mode, timer input capture, TWI slave, ADC free-running on ATtiny, reset semantics, timer/`cpu.tick()` requirements, and signal-physics questions. Treat these as regression vectors, not hidden guarantees. ([issues](https://github.com/wokwi/avr8js/issues))
- `wokwi-elements` components do not change simulation state by themselves; every rendered pin/value must be fed from ViBread's model. ([elements README](https://github.com/wokwi/wokwi-elements/blob/main/README.md))

### 6.4 Wokwi integration

- Keep Wokwi behind an adapter whose input/output is the same `ScenarioResult` contract as local `avr8js`. Do not leak `diagram.json` controls into the rest of the application.
- Require `WOKWI_CLI_TOKEN` only for a user-selected cloud run; redact it from logs and result artifacts. The official MCP is experimental and cloud-backed. ([MCP docs](https://docs.wokwi.com/wokwi-ci/mcp-support), [CI architecture](https://docs.wokwi.com/wokwi-ci/getting-started))
- Treat simulation uploads as external data: Wokwi says firmware is deleted after simulation, but the project should still show cloud execution and retention status to the user. ([CI architecture](https://docs.wokwi.com/wokwi-ci/getting-started))
- Wokwi's free/Community and CI-minute limits differ; do not promise unlimited agent runs merely because the pricing page says unlimited Community simulations. ([pricing](https://wokwi.com/pricing), [CI limits](https://docs.wokwi.com/wokwi-ci/getting-started))
- CLI `lint --offline` is not an offline simulation mode. VS Code cached offline mode is a Pro feature. ([CLI usage](https://docs.wokwi.com/wokwi-ci/cli-usage), [offline mode](https://docs.wokwi.com/vscode/offline-mode))

### 6.5 License and security

- `avr8js`, `rp2040js`, `wokwi-cli`, `wokwi-elements`, and Renode are permissive MIT/Apache options. Keep notices in the dependency inventory. ([avr8js package](https://raw.githubusercontent.com/wokwi/avr8js/main/package.json), [rp2040js package](https://raw.githubusercontent.com/wokwi/rp2040js/main/package.json), [CLI license](https://github.com/wokwi/wokwi-cli/blob/main/LICENSE), [elements license](https://raw.githubusercontent.com/wokwi/wokwi-elements/main/LICENSE), [Renode license](https://raw.githubusercontent.com/renode/renode/master/LICENSE))
- `simavr`, SimulIDE CE, upstream QEMU, Espressif QEMU, and `ltspice-mcp` are GPL-family; do not copy source or link them into the main permissive app without license review. ([simavr COPYING](https://github.com/buserror/simavr/blob/master/COPYING), [SimulIDE LICENSE](https://github.com/SimulIDE/SimulIDE/blob/master/LICENSE), [QEMU COPYING](https://github.com/qemu/qemu/blob/master/COPYING), [Espressif license](https://raw.githubusercontent.com/espressif/qemu/esp-develop/LICENSE), [ltspice-mcp license](https://raw.githubusercontent.com/Cognitohazard/ltspice-mcp/master/LICENSE))
- Never put `wokwi-cli`, `arduino-cli`, `ngspice`, QEMU, or user-supplied scripts behind an MCP tool that accepts arbitrary command strings. Expose typed operations and allowlisted artifacts. Existing servers document why this matters: `ltspice-mcp` warns that netlists can exercise simulator privileges and that `run_code` executes Python; Simten's MCP warns `verify_circuit` is unsandboxed local `tsx`. ([ltspice security](https://raw.githubusercontent.com/Cognitohazard/ltspice-mcp/master/SECURITY.md), [Simten MCP](https://raw.githubusercontent.com/simtenHQ/simten/main/packages/mcp/README.md))
- Keep physical USB/Web Serial flashing in a separate permission mode; simulated `set_input` must never be able to flash or energize a real board.

## 7) Risks and unknowns

1. **Board assumption:** Uno R3/Nano is unconfirmed. A detected R4, ESP32, or RP2040 changes the compiler, pin map, registers, timing, voltage, and simulator; silently treating it as ATmega328P yields false confidence. ([Wokwi Uno reference](https://docs.wokwi.com/parts/wokwi-arduino-uno), [Renode Uno R4 platform](https://raw.githubusercontent.com/renode/renode/master/platforms/boards/arduino_uno_r4_minima.repl))
2. **Analog overclaim:** Wokwi's own docs say analog support is limited; local digital-plus-DC is a deliberate approximation. Current, voltage sag, LED brightness, ADC error/noise, pull-up resistance, wiring resistance, and power faults need physical measurements or a real SPICE model. ([Wokwi analog API](https://docs.wokwi.com/chips-api/analog))
3. **Protocol-model mismatch:** Common Arduino libraries may depend on undocumented timing, pull-up, open-drain, reset, or electrical behavior. DHT11, I2C LCD/SSD1306, and servo models need golden vectors from datasheets and at least one physical check.
4. **`avr8js` edge cases:** open issues and master-only SPI/TWI limit supported sketches. Unsupported analog comparator, sleep, capture, or TWI-slave use must be surfaced as “not modeled,” not passed. ([avr8js issues](https://github.com/wokwi/avr8js/issues), [Uno feature table](https://docs.wokwi.com/parts/wokwi-arduino-uno))
5. **Wokwi dependency risk:** CLI/MCP is experimental and needs a token/cloud; pricing, CI quotas, and offline policy can change. Keep local tests independent and treat Wokwi as optional evidence. ([MCP docs](https://docs.wokwi.com/wokwi-ci/mcp-support), [pricing](https://wokwi.com/pricing))
6. **Simulation speed:** none of the reviewed sources supplies a universal faster-than-real-time benchmark. Report virtual-time throughput only after measuring ViBread's exact firmware/model mix; never promise “faster than hardware” from a generic simulator description. ([avr8js README](https://github.com/wokwi/avr8js/blob/main/README.md), [simavr README](https://github.com/buserror/simavr/blob/master/README.md))
7. **Native backend operations:** Renode, simavr, QEMU, and ngspice add installation/architecture/child-process failure modes. Persist backend version, command exit code, stderr, and artifact provenance in every result.
8. **License scope:** ngspice has heterogeneous per-file terms; Espressif/upstream QEMU are GPL-family; SimulIDE/simavr are GPL-3; Velxio is AGPL-3. This report recommends dependencies/wrappers, not source copying or competitor cloning. ([ngspice COPYING](https://raw.githubusercontent.com/ngspice/ngspice/master/COPYING), [Velxio license](https://raw.githubusercontent.com/davidmonterocrespo24/velxio/master/LICENSE))
9. **Physical detectability:** an MCU self-test can detect some shorts/miswires through known drive/read patterns, but cannot prove every breadboard fault or passive component value. Phone vision is secondary and must not override a contradictory electrical self-test.
10. **Tinkercad internals:** its public guide does not verify SPICE, analog solver, MCU emulator, licensing, or API behavior. Any comparison beyond the public user workflow is `[UNVERIFIED]`; do not use it as an implementation source. ([official guide](https://www.tinkercad.com/blog/official-guide-to-tinkercad-circuits))

## 8) Sources

Primary sources used above:

1. [Wokwi supported hardware](https://docs.wokwi.com/getting-started/supported-hardware)
2. [Wokwi Arduino Uno reference and peripheral-status table](https://docs.wokwi.com/parts/wokwi-arduino-uno)
3. [Wokwi automation scenarios](https://docs.wokwi.com/wokwi-ci/automation-scenarios)
4. [Wokwi CLI usage](https://docs.wokwi.com/wokwi-ci/cli-usage)
5. [Wokwi CLI installation](https://docs.wokwi.com/wokwi-ci/cli-installation)
6. [Wokwi CI architecture, limits, and MCP note](https://docs.wokwi.com/wokwi-ci/getting-started)
7. [Wokwi MCP support](https://docs.wokwi.com/wokwi-ci/mcp-support)
8. [Wokwi CLI source repository/license/tools](https://github.com/wokwi/wokwi-cli)
9. [Wokwi CLI MCP tool source](https://raw.githubusercontent.com/wokwi/wokwi-cli/main/packages/cli/src/mcp/WokwiMCPTools.ts)
10. [Wokwi CLI MCP server/resources source](https://raw.githubusercontent.com/wokwi/wokwi-cli/main/packages/cli/src/mcp/MCPServer.ts)
11. [Wokwi CLI scenario source](https://raw.githubusercontent.com/wokwi/wokwi-cli/main/packages/cli/src/TestScenario.ts)
12. [Wokwi pricing](https://wokwi.com/pricing)
13. [Wokwi VS Code offline mode](https://docs.wokwi.com/vscode/offline-mode)
14. [Wokwi Custom Chips API](https://docs.wokwi.com/chips-api/getting-started)
15. [Wokwi analog API](https://docs.wokwi.com/chips-api/analog)
16. [Wokwi HC-SR04 reference](https://docs.wokwi.com/parts/wokwi-hc-sr04)
17. [Wokwi DHT22 reference](https://docs.wokwi.com/parts/wokwi-dht22)
18. [Wokwi servo reference](https://docs.wokwi.com/parts/wokwi-servo)
19. [Wokwi LCD1602 reference](https://docs.wokwi.com/parts/wokwi-lcd1602)
20. [Wokwi SSD1306 reference](https://docs.wokwi.com/parts/board-ssd1306)
21. [Wokwi photoresistor reference](https://docs.wokwi.com/parts/wokwi-photoresistor-sensor)
22. [Wokwi potentiometer reference](https://docs.wokwi.com/parts/wokwi-potentiometer)
23. [Wokwi digital/analog signal gap issue](https://github.com/wokwi/wokwi-features/issues/583)
24. [`avr8js` README](https://github.com/wokwi/avr8js/blob/main/README.md)
25. [`avr8js` package manifest](https://raw.githubusercontent.com/wokwi/avr8js/main/package.json)
26. [`avr8js` exports](https://raw.githubusercontent.com/wokwi/avr8js/main/src/index.ts)
27. [`avr8js` GPIO](https://raw.githubusercontent.com/wokwi/avr8js/main/src/peripherals/gpio.ts)
28. [`avr8js` timer](https://raw.githubusercontent.com/wokwi/avr8js/main/src/peripherals/timer.ts)
29. [`avr8js` TWI](https://raw.githubusercontent.com/wokwi/avr8js/main/src/peripherals/twi.ts)
30. [`avr8js` ADC](https://raw.githubusercontent.com/wokwi/avr8js/main/src/peripherals/adc.ts)
31. [`avr8js` CPU scheduler](https://raw.githubusercontent.com/wokwi/avr8js/main/src/cpu/cpu.ts)
32. [`avr8js` open issues](https://github.com/wokwi/avr8js/issues)
33. [`simavr` README](https://github.com/buserror/simavr/blob/master/README.md)
34. [`simavr` CLI source](https://raw.githubusercontent.com/buserror/simavr/master/simavr/sim/run_avr.c)
35. [`simavr` GPL-3 COPYING](https://github.com/buserror/simavr/blob/master/COPYING)
36. [`pysimavr`](https://github.com/ponty/pysimavr)
37. [SimulIDE CE README](https://github.com/SimulIDE/SimulIDE/blob/master/README.md)
38. [SimulIDE GPL-3 license](https://github.com/SimulIDE/SimulIDE/blob/master/LICENSE)
39. [SimulIDE command-line discussion](https://simulide.com/p/forum/topic/running-simulide-from-command-line/)
40. [QEMU AVR documentation](https://qemu-project.gitlab.io/qemu/system/target-avr.html)
41. [QEMU Arduino machine source](https://raw.githubusercontent.com/qemu/qemu/master/hw/avr/arduino.c)
42. [QEMU ATmega peripheral source](https://raw.githubusercontent.com/qemu/qemu/master/hw/avr/atmega.c)
43. [QEMU GPL-2 COPYING](https://github.com/qemu/qemu/blob/master/COPYING)
44. [Renode README](https://github.com/renode/renode/blob/master/README.md)
45. [Renode MIT license](https://raw.githubusercontent.com/renode/renode/master/LICENSE)
46. [Renode supported board directory](https://github.com/renode/renode/tree/master/platforms/boards)
47. [Renode Uno R4 Minima platform](https://raw.githubusercontent.com/renode/renode/master/platforms/boards/arduino_uno_r4_minima.repl)
48. [Renode RA4M1 platform](https://raw.githubusercontent.com/renode/renode/master/platforms/cpus/renesas-r7fa4m1a.repl)
49. [Renode Monitor CLI](https://renode.readthedocs.io/en/latest/basic/monitor-syntax.html)
50. [Renode ESP32/RP2040 feature request](https://github.com/renode/renode/issues/262)
51. [`rp2040js` README](https://github.com/wokwi/rp2040js/blob/main/README.md)
52. [`rp2040js` package manifest](https://raw.githubusercontent.com/wokwi/rp2040js/main/package.json)
53. [`rp2040js` v1.4.0 release](https://github.com/wokwi/rp2040js/releases/tag/v1.4.0)
54. [Espressif QEMU ESP-IDF guide](https://docs.espressif.com/projects/esp-idf/en/stable/esp32/api-guides/tools/qemu.html)
55. [Espressif QEMU feature matrix](https://github.com/espressif/esp-toolchain-docs/blob/main/qemu/README.md)
56. [Espressif QEMU C3 guide](https://github.com/espressif/esp-toolchain-docs/blob/main/qemu/esp32c3/README.md)
57. [Espressif QEMU license](https://raw.githubusercontent.com/espressif/qemu/esp-develop/LICENSE)
58. [ngspice shared library](https://ngspice.sourceforge.io/shared.html)
59. [ngspice XSPICE](https://ngspice.sourceforge.io/xspice.html)
60. [ngspice callbacks](https://nmg.gitlab.io/ngspice-manual/ngspiceassharedlibraryordynamiclinklibrary/sharedngspiceapi/callbackfunctions.html)
61. [ngspice XSPICE event-node callbacks](https://nmg.gitlab.io/ngspice-manual/ngspiceassharedlibraryordynamiclinklibrary/generalremarksonusingtheapi/xspiceeventnodedata.html)
62. [ngspice COPYING/license notes](https://raw.githubusercontent.com/ngspice/ngspice/master/COPYING)
63. [Wokwi Elements README](https://github.com/wokwi/wokwi-elements/blob/main/README.md)
64. [Wokwi Elements MIT license](https://raw.githubusercontent.com/wokwi/wokwi-elements/main/LICENSE)
65. [HC-SR04 datasheet](https://cdn.sparkfun.com/datasheets/Sensors/Proximity/HCSR04.pdf)
66. [DHT11 datasheet](https://osoyoo.com/driver/DHT11-datasheet.pdf)
67. [SSD1306 product page](https://www.solomon-systech.com/en/product/SSD1306)
68. [HD44780 datasheet](https://cdn.sparkfun.com/assets/9/5/f/7/b/HD44780.pdf)
69. [Tinkercad official Circuits guide](https://www.tinkercad.com/blog/official-guide-to-tinkercad-circuits)
70. [Simten repository and Apache-2 license](https://github.com/simtenHQ/simten)
71. [Simten MCP README/tools](https://raw.githubusercontent.com/simtenHQ/simten/main/packages/mcp/README.md)
72. [`ltspice-mcp` README](https://github.com/Cognitohazard/ltspice-mcp)
73. [`ltspice-mcp` security policy](https://raw.githubusercontent.com/Cognitohazard/ltspice-mcp/master/SECURITY.md)
74. [`ltspice-mcp` GPL-3 license](https://raw.githubusercontent.com/Cognitohazard/ltspice-mcp/master/LICENSE)
75. [`circuit-sim-mcp` repository](https://github.com/ghensley/circuit-sim-mcp)
76. [`circuit-sim-mcp` manifest](https://raw.githubusercontent.com/ghensley/circuit-sim-mcp/main/pyproject.toml)
77. [Velxio repository](https://github.com/davidmonterocrespo24/velxio)
78. [Velxio MCP documentation](https://raw.githubusercontent.com/davidmonterocrespo24/velxio/master/docs/MCP.md)
79. [Velxio AGPL-3 license](https://raw.githubusercontent.com/davidmonterocrespo24/velxio/master/LICENSE)
80. [HardwareMCP Arduino server](https://github.com/hardware-mcp/arduino-mcp-server)
81. [HardwareMCP MIT license](https://raw.githubusercontent.com/hardware-mcp/arduino-mcp-server/main/LICENSE)
82. [Uno-R3-MCP](https://github.com/sushiionwest/Uno-R3-MCP)
83. [Uno-R3-MCP MIT license](https://raw.githubusercontent.com/sushiionwest/Uno-R3-MCP/main/LICENSE)
