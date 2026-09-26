# ViBread Slice 06 — Physical verification research

**Research date:** 2026-09-25.  **Target:** Arduino Uno R3/Nano first; ESP32 and Uno R4 are explicitly treated as different upload targets.  **Scope rule:** this report recommends dependencies and protocols only; ViBread application and firmware glue must be written for this hackathon and must not copy an existing project.

> **Bottom line.** Use a Chromium Web Serial browser path with the maintained MIT `webserial-flasher` package for Uno/Nano STK500v1 and Espressif's Apache-2.0 `esptool-js` for ESP32; generate a small, circuit-specific self-test sketch as the primary physical oracle, use Firmata only as an optional exploratory/manual-control mode, and treat a rectified/fiducial-guided Claude photo check as secondary evidence rather than a netlist oracle.

## 1) Scope

This slice covers six decisions:

1. Browser flashing over Web Serial, including reset signaling, AVR bootloaders, existing JavaScript/WASM implementations, ESP32, and Uno R4.
2. Host-driven pin control (Firmata) versus a generated firmware self-test.
3. MCU-only tests for opens, shorts, rails, passive values, sensors, and actuators, with a fault detectability matrix.
4. HCI/instrumented-breadboard evidence to ground the pitch and the interaction design.
5. Photo verification and a practical Node/Claude vision pipeline.
6. Existing serial/hardware-in-the-loop MCP servers against the repository's “good MCP” rubric.

The working board assumption is ATmega328P Uno R3/Nano. It is **[UNVERIFIED]** whether the demo board is an Uno R3, a Nano with an Optiboot bootloader, or a Nano with the old bootloader. The board must be selected explicitly at upload time; do not silently guess from a USB VID/PID because CH340/FTDI clones and bootloader variants are common.

The laptop owns the USB board while the web app runs in a tunneled browser. A browser opened at `http://localhost:<forwarded-port>` is still a potentially trustworthy/secure context under the Secure Contexts rules; the SSH tunnel transports HTTP but does not itself grant device permission. If the user opens the remote hostname over plain HTTP instead, Web Serial will not be available. ([MDN Secure Contexts](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Secure_Contexts), [MDN Web Serial](https://developer.mozilla.org/en-US/docs/Web/API/Web_Serial_API), [Chrome Web Serial](https://developer.chrome.com/docs/capabilities/serial))

## 2) Industry standard

### 2.1 Browser serial constraints and the normal upload flow

Web Serial is an asynchronous browser API for USB/Bluetooth devices that expose a serial port. The browser requires a secure context, and `navigator.serial.requestPort()` must be called from a transient user activation (normally a button click); previously granted devices can be enumerated with `navigator.serial.getPorts()`. USB vendor/product filters are advisory selection filters, not proof that a board is an Uno. ([Chrome Web Serial](https://developer.chrome.com/docs/capabilities/serial), [MDN `requestPort`](https://developer.mozilla.org/en-US/docs/Web/API/Serial/requestPort))

A serial upload UI should therefore implement this flow:

1. Render a conspicuous **Connect board** button; inside its click handler call `requestPort({filters})`.
2. `await port.open({baudRate, dataBits: 8, stopBits: 1, parity: "none", flowControl: "none"})`.
3. Obtain exactly one reader and one writer; release/cancel them before closing. Handle disconnect events and non-fatal stream errors.
4. Pulse reset lines, wait for the bootloader window, then perform protocol synchronization.
5. Upload the server-produced Intel HEX; verify signature and flash contents if the protocol/library supports it; close the port and wait for the application `READY` banner.
6. Never run upload and self-test through two readers or two independent serial clients. The browser port must be exclusively owned by one session.

`SerialPort.setSignals()` can assert/de-assert DTR and RTS (and break). It rejects if called before `open()`, and an adapter/board may ignore a line it does not wire. On Uno-style boards a DTR transition is normally coupled through the USB-serial/reset circuitry to reset the ATmega328P; the exact pulse polarity and duration should be tested on the actual board. RTS is a useful fallback for adapters with RTS-to-reset wiring, not a guarantee. ([MDN `setSignals`](https://developer.mozilla.org/en-US/docs/Web/API/SerialPort/setSignals), [Arduino Uno board definition](https://github.com/arduino/ArduinoCore-avr/blob/master/boards.txt))

Web Serial is a Chromium-family feature in practice for this project. Chrome's Web Serial documentation lists Chrome use cases and browser compatibility; Firefox/Safari should be treated as unsupported and should receive a clear “Use Chrome or Edge” message, not a silent failure. ([Chrome Web Serial](https://developer.chrome.com/docs/capabilities/serial), [MDN browser compatibility](https://developer.mozilla.org/en-US/docs/Web/API/Web_Serial_API))

### 2.2 Uno R3/Nano AVR upload facts

Arduino's AVR board definitions are the authoritative mapping from board name to MCU, protocol, speed, and bootloader:

| Board profile | MCU/signature | Bootloader/protocol | Upload speed | Consequence |
|---|---|---|---:|---|
| Uno R3 | ATmega328P, signature `1E 95 0F` | Optiboot; Arduino/STK500v1-compatible | 115200 | Default first target. |
| Nano (new bootloader) | ATmega328P, signature `1E 95 0F` | Optiboot; Arduino/STK500v1-compatible | 115200 | Same protocol; different USB board IDs are possible. |
| Nano (old bootloader) | ATmega328P, signature `1E 95 0F` | `ATmegaBOOT_168_atmega328.hex`; old STK500v1 behavior | 57600 | Must expose an “old bootloader” choice or retry 57600 after a failed sync. |
| Duemilanove/old ATmega328 profile | ATmega328P | `ATmegaBOOT_168_atmega328.hex` | 57600 | Useful fallback if the user has an older clone. |

The values above are directly present in [ArduinoCore-avr `boards.txt`](https://github.com/arduino/ArduinoCore-avr/blob/master/boards.txt). Optiboot documents that it implements a deliberately small/skeletal STK500 protocol, omits some EEPROM and non-page-aligned operations, and defaults to 115200 at 16 MHz. ([Optiboot source](https://github.com/arduino/ArduinoCore-avr/blob/master/bootloaders/optiboot/optiboot.c), [STK500 constants](https://github.com/arduino/ArduinoCore-avr/blob/master/bootloaders/optiboot/stk500.h))

The minimal STK500v1 sequence is: synchronize (`GET_SYNC`/`CRC_EOP`), optionally set device parameters, enter programming mode, read/check the three-byte signature, erase if required, load a **word** address, program a page with `PROG_PAGE`, repeat, leave programming mode, and verify. Commands and response tokens are listed in Optiboot's [STK500 header](https://github.com/arduino/ArduinoCore-avr/blob/master/bootloaders/optiboot/stk500.h). A robust implementation must use bounded timeouts, discard stale bytes after reset, retry sync, preserve Intel HEX gaps as erased bytes, split writes at page boundaries, and report the first failing address.

### 2.3 Existing browser/JavaScript/WASM flashers

#### Recommended: `webserial-flasher` (USE + WRAP)

[`vielang/webserial-flasher`](https://github.com/vielang/webserial-flasher) is an MIT TypeScript/ESM library that explicitly supports STK500v1 in Node **and browser Web Serial**, STK500v2, AVR109, UPDI (Node), and PicoBoot (Node). Its documented browser flow is `requestPort()` → `open(baudRate)` → `STK500.bootload(hex)`. NPM `1.0.1` was published 2026-03-31 and the GitHub history shows a 2026-03-31 commit; the repository had 5 stars and 4 forks when checked. ([README](https://raw.githubusercontent.com/vielang/webserial-flasher/main/README.md), [NPM metadata](https://registry.npmjs.org/webserial-flasher), [commit history](https://github.com/vielang/webserial-flasher/commits/main))

Use it behind a ViBread adapter rather than exposing the package API to the agent. The wrapper should select one of two explicit ATmega328P profiles (`uno`/Nano-new at 115200; Nano-old at 57600), own DTR reset and progress reporting, reject a signature mismatch, and return a stable result object (`board`, `signature`, `bytesWritten`, `verified`, `warnings`). The library is new and lightly adopted, so keep a throwaway loopback/fixture test and be ready to replace only this adapter if the physical board exposes an edge case.

#### Existing alternatives and why they are not the primary path

* [`avrgirl-arduino`](https://github.com/noopkat/avrgirl-arduino) is MIT, popular (529 stars), and has an alpha Web Serial demo, but its latest visible release/commit is 2021-02-07. The demo README explicitly calls Web Serial support alpha and notes board/protocol limitations. Verdict: useful reference or fallback, not a weekend-critical dependency. ([repository](https://github.com/noopkat/avrgirl-arduino), [Web Serial demo](https://github.com/noopkat/avrgirl-arduino/blob/master/tests/demos/webserial/README.md), [history](https://github.com/noopkat/avrgirl-arduino/commits/master))
* [`js-stk500v1`](https://github.com/hujiese/js-stk500v1) is an MIT implementation that works on a stream and documents 115200 for an Uno and browser use through an older browser adapter. It is a fork with 0 stars and its last visible commit is 2022-02-27. Verdict: readable protocol reference, not a maintained primary dependency. ([README](https://github.com/hujiese/js-stk500v1), [history](https://github.com/hujiese/js-stk500v1/commits/master), [license](https://raw.githubusercontent.com/hujiese/js-stk500v1/master/LICENSE.md))
* [`avrdude`](https://github.com/avrdudes/avrdude) is the professional/Arduino CLI backend, but the upstream project is GPL-2.0. It is excellent as an installed host tool, but embedding/linking it into ViBread's browser bundle or copying a WASM port creates a license and build burden. ([repository/license](https://github.com/avrdudes/avrdude))
* [`leaphy-robotics/avrdude-webassembly`](https://github.com/leaphy-robotics/avrdude-webassembly) demonstrates browser AVRDUDE/WASM, but the repository is archived, tiny (4 stars), and GPL-2.0. Verdict: do not use for this public hackathon repository. ([repository](https://github.com/leaphy-robotics/avrdude-webassembly), [NPM package metadata](https://registry.npmjs.org/%40leaphy-robotics%2Favrdude-webassembly))
* Arduino's [`arduino-create-agent`](https://github.com/arduino/arduino-create-agent) is a mature local-agent architecture (browser ↔ WebSocket/REST ↔ agent ↔ board), but it is AGPL-3.0 and is a tray/background service rather than a small browser dependency. The JS client is GPL-3.0. It is a useful architecture reference or an external user-installed tool, not a dependency to ship in ViBread. ([agent repository](https://github.com/arduino/arduino-create-agent), [JS client](https://github.com/arduino/arduino-create-agent-js-client))

### 2.4 ESP32 and Uno R4 implications

For ESP32, use Espressif's official [`esptool-js`](https://github.com/espressif/esptool-js). It is TypeScript, Apache-2.0, had 534 stars/181 forks when checked, and its history shows release `0.7.0` on 2026-09-21. It wraps Web Serial, detects the chip, performs reset/bootloader connection, and flashes binary images. It deliberately does **not** turn ELF into images and does not include `espefuse.py`/`espsecure.py`; the backend must produce the correct image set and security settings. ([repository/README](https://github.com/espressif/esptool-js), [commit history](https://github.com/espressif/esptool-js/commits/main))

Uno R4 is not an ATmega328P and must not be sent STK500v1 bytes. Arduino's Renesas core identifies Uno R4 Minima as a Cortex-M4 RA4M1 target and uses `dfu-util`; Uno R4 WiFi uses the `bossac`/SAM-BA upload tool. The core repository contains the board definitions and DFU bootloader images. A direct Web Serial implementation would need a DFU or BOSSA/SAM-BA transport (and reliable reset/USB re-enumeration); that is a separate effort from AVR STK500. ([ArduinoCore-renesas `boards.txt`](https://github.com/arduino/ArduinoCore-renesas/blob/main/boards.txt), [ArduinoCore-renesas bootloaders](https://github.com/arduino/ArduinoCore-renesas/tree/main/bootloaders/UNO_R4), [BOSSA](https://github.com/shumatech/BOSSA))

**Decision:** target Uno R3/Nano in the demo. Keep a board capability table that routes ESP32 to `esptool-js`; label Uno R4 as “host agent / later DFU-BOSSA adapter” instead of pretending the AVR path supports it.

### 2.5 Firmata versus generated self-test firmware

Firmata is a host/device protocol, not a circuit verifier. The official Arduino implementation documents two models: a custom sketch may selectively send data, or the user may load `StandardFirmata` and let host software control the board. `ConfigurableFirmata` splits digital I/O, analog I/O, PWM, I2C, servo, and other features into selectable modules and currently lists AVR, ESP32, Due, and Pico support. ([Firmata Arduino README](https://github.com/firmata/arduino), [ConfigurableFirmata README](https://github.com/firmata/ConfigurableFirmata))

A browser can use Firmata over Web Serial: [`firmata-web`](https://github.com/yellow-digital/firmata-web) supplies a `WebSerialTransport`, opens the port at the default 57600 baud, waits for `ready`, and exposes `pinMode`, `digitalWrite`, analog reporting, and related operations. This demonstrates technical feasibility, but the browser project has only 3 stars, no visible commit history, and no clearly declared repository license in its README; treat it as a reference/optional dependency, not a foundation. ([firmata-web README](https://raw.githubusercontent.com/yellow-digital/firmata-web/master/README.md), [firmata.js](https://github.com/firmata/firmata.js))

**Why Firmata is the wrong primary oracle:**

* StandardFirmata is a generic runtime; it does not know ViBread's expected netlist, component values, safe test order, or which pins may safely be driven.
* Arbitrary host pin commands can accidentally drive two outputs against one another or drive an output into VCC/GND. An Uno output pin's recommended DC current is 20 mA; the ATmega328P datasheet's absolute maximum is not a safe operating target. ([Arduino Uno pinout](https://docs.arduino.cc/static/c57a658e0f7afad334f6f73e82dfd83d/A000066-full-pinout.pdf), [ATmega328P datasheet](https://ww1.microchip.com/downloads/en/DeviceDoc/Atmel-7810-Automotive-Microcontrollers-ATmega328P_Datasheet.pdf))
* Firmata packets add latency and are not an atomic circuit-test plan. A disconnect between `pinMode`, write, read, and cleanup can leave the board in a hazardous state.
* StandardFirmata consumes program memory/RAM needed by the user's generated sketch and can conflict with libraries/timers.

**Generated self-test firmware is the primary path.** The backend knows the netlist and compiles a purpose-built sketch with only the tests that are valid for that circuit. It can use a single serial command (`RUN`, or a nonce-bearing NDJSON command) to execute a safe, deterministic plan and return newline-delimited JSON. Firmata remains valuable as a manual “lab bench” mode for advanced users and as a fallback for generic pin inspection, but it must be opt-in and clearly warn that it cannot certify a circuit.

### 2.6 MCU self-test techniques and electrical limits

The ATmega328P datasheet documents internal pull-ups on all Port B/C/D GPIOs, a 10-bit ADC, an internal bandgap reference usable by the ADC/comparator, and a separate ADC clock/noise-reduction mode. The ADC is designed around a source impedance of roughly 10 kΩ or less; high-value dividers need a settling delay, a discarded first conversion, or a buffer. ([ATmega328P pin descriptions and ADC](https://ww1.microchip.com/downloads/en/DeviceDoc/Atmel-7810-Automotive-Microcontrollers-ATmega328P_Datasheet.pdf), [Microchip AVR126](https://ww1.microchip.com/downloads/en/AppNotes/Atmel-8444-ADC-of-megaAVR-in-Single-Ended-Mode_ApplicationNote_AVR126.pdf))

#### A. Safe startup and VCC sag

1. Start with all user GPIO inputs/high impedance, disable ADC digital input buffers where appropriate, detach Servo/PWM, and keep loads off.
2. Measure VCC by selecting the internal bandgap as the ADC input while using AVCC/VCC as the ADC reference. Microchip AN2447 describes this ratio measurement; the nominal formula is approximately `Vcc = 1.1 V × 1023 / ADC_code`, but the internal bandgap has tolerance and temperature dependence, so calibrate the constant per board or report a broad warning threshold rather than false precision. ([AN2447](https://ww1.microchip.com/downloads/en/AppNotes/00002447A.pdf), [AVR120 calibration](https://ww1.microchip.com/downloads/aemDocuments/documents/OTH/ApplicationNotes/ApplicationNotes/Atmel-2559-Characterization-and-Calibration-of-the-ADC-on-an-AVR_ApplicationNote_AVR120.pdf))
3. Record idle VCC and VCC during each powered actuator test. A substantial transient sag, brown-out/reset, or unexpectedly low steady VCC is strong evidence of an overloaded rail or short, but it does not identify the exact wire.

#### B. Pin-to-pin continuity/short matrix

The usual low-cost matrix is to set every candidate pin to `INPUT_PULLUP`, then select one pin at a time as an output low and read the other pins. A non-expected low indicates a connection/short. This is useful for direct wires and net continuity, but **the output-low step is not safe against a direct VCC short**. ViBread should therefore:

* run the high-impedance pull-up observations first;
* only enable an output-low matrix for pins whose expected net includes a known series/current-limiting resistor or otherwise passes a generated safety rule;
* test one source at a time, cap dwell time, monitor VCC, abort on sag/reset, and always restore every pin to input mode in a `finally` path;
* report `not_tested_unsafe` rather than claim a clean pass for unguarded power-connected pins.

A direct wire missing from a testable endpoint can be detected by continuity; a wrong-row wire that lands on an electrically equivalent net is intentionally not distinguishable. A short between two MCU pins may be detectable only if the test is electrically safe and the short is not masked by the expected net.

#### C. Stuck-at and active digital tests

For each expected digital input, sample idle and active levels under the expected pull-up/down, then toggle the corresponding generated output through a current-limited load. A pin permanently low can mean a short to GND, a wrong row, a pressed button, a dead sensor output, or a code/configuration error; the result should be a hypothesis set, not a single diagnosis. A pin permanently high similarly can mean a short to VCC, missing ground, open wire, reversed device, or a sensor that was not stimulated.

#### D. Analog dividers, pots, and LDRs

For a generated divider/pot/LDR, take multiple ADC samples after a settling delay, check expected range, and ask the user to turn the potentiometer or cover/uncover the LDR. A valid interactive response is stronger than a single nominal value. Use the internal bandgap/VCC estimate to distinguish a rail fault from a sensor-value fault. A high-impedance divider needs either values near the ADC's recommended source impedance or an explicit longer sample/settling sequence. ([ATmega328P datasheet ADC chapter](https://ww1.microchip.com/downloads/en/DeviceDoc/Atmel-7810-Automotive-Microcontrollers-ATmega328P_Datasheet.pdf), [AVR126](https://ww1.microchip.com/downloads/en/AppNotes/Atmel-8444-ADC-of-megaAVR-in-Single-Ended-Mode_ApplicationNote_AVR126.pdf))

#### E. LEDs and other human/optical checks

Drive an LED through its generated resistor in both safe logic states and ask for a human confirmation (“Do you see LED1 turn on?”). A normal forward-drop/ADC check can identify open/reversed/shorted branches when the topology provides a measurable node, but MCU-only voltage cannot always distinguish a reversed LED from a dead LED. An LED can also be reverse-biased and used as a crude photodiode by measuring capacitor-discharge time; this is a real technique, but depends strongly on LED type, light, leakage, and timing, so it is an optional novelty check, not the LED wiring oracle. ([Analog Devices LED sensor activity](https://www.analog.com/en/resources/analog-dialogue/studentzone/studentzone-january-2023.html), [MERL bidirectional LED paper](https://merl.com/publications/docs/TR2003-35.pdf))

#### F. Interactive components

* **Button/switch:** ask the user to release, then press, then release; require a debounced edge in the expected direction. This detects wrong row, missing ground/pull-up, stuck switch, and many reversed four-pin-button placements.
* **HC-SR04:** generate a trigger pulse of at least 10 µs and measure an echo pulse with timeout. A valid echo/non-echo pattern detects many missing power/trigger/echo wires and a dead module; it cannot prove distance accuracy without a target and does not distinguish every wiring fault. ([HC-SR04 datasheet](https://cdn.sparkfun.com/datasheets/Sensors/Proximity/HCSR04.pdf))
* **Servo:** emit a bounded sweep (for example 60° → 120°) and ask the user to confirm movement. Standard hobby servos have no position feedback on the signal line, so an MCU cannot certify mechanical movement or horn orientation without an external sensor. Arduino's Servo library exposes `attach()`/`write()` but itself does not add feedback. ([Arduino Servo library](https://github.com/arduino-libraries/Servo), [Arduino Servo source/API](https://github.com/arduino-libraries/Servo/blob/006f6303a6842a61551e64d8777bf4ff41c1dbe/src/Servo.h))

### 2.7 HCI and instrumented-breadboard evidence

The literature supports ViBread's key UX idea: make hidden state visible, test each assembly step, and link physical evidence to software hypotheses rather than merely showing a red “failed” status.

* **Crossed Wires (CHI 2016).** In a 20-person Arduino Uno Love-O-Meter study, only 6/20 completed the task. Participants averaged 41.60 obstacles, 21.05 breakdowns, and 13.7 introduced bugs in 45 minutes. The paper reports 87 miswiring breakdowns; circuit construction was the most common fatal source for ten unsuccessful participants. Five participants omitted/added the wrong resistors, and four chose excessively high resistor values. This grounds ViBread's “wiring versus code” attribution and its need for live tests. ([paper](https://openaccess.city.ac.uk/id/eprint/14844/12/booth-chi2016-cr.pdf), [ACM DOI](https://doi.org/10.1145/2858036.2858533))
* **Toastboard (UIST 2016).** Toastboard instruments every breadboard row and provides approximately 100 Hz whole-board voltage scans (about 1 kHz for selected signals), visual row LEDs, and component-specific checkers. Its seven-person informal study found immediate visual feedback useful to all participants; common error classes included power/ground, polarity/placement, bad seating, defective components, wrong pin configuration, and unexpected sensor readings. ([paper](https://people.eecs.berkeley.edu/~bjoern/papers/drew-toastboard-uist2016.pdf), [ACM DOI](https://doi.org/10.1145/2984511.2984566))
* **Visible Breadboard.** This system makes voltage visible at individual holes, but uses a non-standard 3.2 cm pitch and only 36 holes; it is a conceptual precedent for “show the electricity,” not a dependency or scalable Uno accessory. ([ACM record](https://doi.org/10.1145/1836845.1836950), [CurrentViz discussion of Visible Breadboard](https://teyenwu.com/publications/CurrentViz.pdf))
* **CurrentViz (UIST 2017).** The prototype senses current at 240 points and visualizes direction with arrows and magnitude with color. In a nine-person study, six preferred both voltage and current, two current-only, and one voltage-only; four explicitly said one measurement alone was insufficient for power-management bugs, and three found current direction useful for locating the general fault region. This supports ViBread's combination of rail voltage, pin observations, and explanatory fault hypotheses, while also showing that current sensing normally requires extra hardware. ([paper](https://teyenwu.com/publications/CurrentViz.pdf), [ACM DOI](https://doi.org/10.1145/3126594.3126646))
* **Bifröst (UIST 2017, not UIST 2018).** The source paper is UIST 2017. It links instrumented code execution, variables, serial output, and digital/analog pin traces on one time axis and adds automatic/user-authored checkers. In its 10-person exploratory study, Bifröst users diagnosed 24/30 diagnostic tasks versus 18/20 controls (tasks were not identical allocations), nine of ten preferred it, and users rated trace visualization/variable tracking 4.6/5 useful and 4.7/5 easy. The key pitch lesson is the linked timeline and “design/code/wiring” attribution, not the prototype's logic-analyzer hardware. ([paper](https://jeremywrnr.com/papers/BifrostUIST2017.pdf), [ACM DOI](https://doi.org/10.1145/3126594.3126658))
* **Trigger-Action-Circuits (UIST 2017).** TAC generated candidate circuits, firmware, diagrams, and assembly instructions from behavioral descriptions. In its 12-person Love-O-Meter study, 6/6 TAC participants completed in an average 36 minutes, while 0/6 Arduino-IDE participants finished within 45 minutes. Participants especially valued diagrams and clicking a wire to highlight its corresponding instruction; the paper warns that generated code/layout were not automatically optimized for learnability or debugging. ([paper](https://www.research.autodesk.com/app/uploads/2023/03/trigger-action-circuits-leveraging.pdf_recJhQeai7lWIR6C9.pdf), [ACM DOI](https://doi.org/10.1145/3126594.3126637))
* **ElectroTutor (UIST 2018, often described as CHI-2019-era).** ElectroTutor embeds hardware/software/knowledge tests in each tutorial step and blocks progression until required tests pass. It defines ten test classes across setup (manual/automatic/none), verification (manual/automatic), and domain (software/physical). In a 12-person study, 5/6 experimental users completed versus 3/6 control; backtracking averaged 0.2 versus 18.8 instances, a significant difference. This directly supports “build one stage, run its test, then proceed.” ([paper](https://www.benlafreniere.ca/assets/papers/Warner_-_UIST2018_-_ElectroTutor.pdf), [ACM DOI](https://doi.org/10.1145/3242587.3242591))
* **CircuitSense (UIST 2017).** CircuitSense used a custom instrumented breadboard (strain gauges for pin location plus active waveform probing and ML) to recognize 22 component types and generate a Fritzing representation; its reported classification experiment was 100% for its chosen 2-pin/3-pin/IC categories. A six-person evaluation averaged 231 seconds to build a circuit and 137 seconds to draw it manually, which the system eliminated. It is persuasive evidence that physical-to-graph reconstruction is possible with hardware instrumentation, but not evidence that a phone photo alone is solved. ([paper](https://ntuhci.org/wp-content/uploads/2017/12/circuitsense.pdf), [ACM DOI](https://doi.org/10.1145/3126594.3126634))
* **SchemaBoard (UIST 2020).** SchemaBoard uses an LED matrix below a breadboard to illuminate the rows for a selected schematic component/net. Its formative study had 16 makers and its evaluation another 16. All seven uncompleted inspection tasks occurred in the baseline; 87.5% of baseline users could not complete inspection within 20 minutes. For assembly, SchemaBoard reduced time by roughly 40%/nearly six minutes and lowered workload; users valued guide mode, net highlighting, and polarity/pin-1 cues. It did not sense the final physical placement, so ViBread should combine its visual mapping idea with MCU/photo verification. ([paper](https://make.kaist.ac.kr/files/2020/Kim_SchemaBoard_UIST20.pdf), [project](https://artifab.yoonji-kim.com/publications/schemaboard))

### 2.8 Recent LLM/circuit-debugging evidence

* **WIRES / From Words to Wires (EMNLP Findings 2023).** GPT-4 scored 96% on MICRO25 schematic+code tasks in the paper's manual evaluation; Claude-V1 scored 60% schematic and 76% code. PINS100 strict pinout accuracy was 74% GPT-4, 55% GPT-3.5, and 56% Claude-V1. The open-ended six-device case studies still needed domain-expert corrections, and the authors identify the lack of automatic simulators as a bottleneck. ViBread should therefore validate every generated design and never treat LLM output as a physical pass. ([paper](https://aclanthology.org/2023.findings-emnlp.864.pdf), [code/data](https://github.com/cognitiveailab/words2wires))
* **EEE-Bench (CVPR 2025).** EEE-Bench contains 2,860 multimodal electrical/electronics questions across ten subdomains and evaluates 17 models. The reported top overall accuracy was 46.78%; the analysis identifies image-perception and reasoning failures and a tendency to ignore visual evidence. It is not a breadboard-photo benchmark, but it is strong evidence against unverified “the model saw the wiring” claims. ([paper](https://openaccess.thecvf.com/content/CVPR2025/html/Li_EEE-Bench_A_Comprehensive_Multimodal_Electrical_And_Electronics_Engineering_Benchmark_CVPR_2025_paper.html), [arXiv](https://arxiv.org/html/2411.01492))
* **ElectroVizQA (2025 version).** This benchmark has 626 digital-electronics VQA questions. On its 103-question testmini, Claude-3.5-Sonnet achieved 69.30% without CoT/71.56% with CoT on visual+question inputs; full-dataset visual accuracy was 62.27% for Claude-3.5-Sonnet and 60.39% for GPT-4o. The authors report visual-perception and conceptual errors and note that prompt-based error classification missed many manually identified errors. These are circuit diagrams, not 3-D breadboards, so use them as a lower-bound warning, not a direct Claude-photo score. ([paper](https://arxiv.org/html/2412.00102), [dataset/code](https://github.com/Pragati-Meshram/ElectroVizQA))
* **Schematic Network Extraction (Umeå thesis, 2025).** Repeated GPT-4o tests on schematic images found that adding textual labels improved component/list consistency, while RAG sometimes hurt and netlist generation was the hardest task. This supports rectifying/cropping and adding machine-readable row labels before asking a model. It is a thesis on schematics, not a breadboard product evaluation. ([thesis](https://www.diva-portal.org/smash/get/diva2:2008968/FULLTEXT01.pdf))
* **Chat Debugging (arXiv 2608.02955, 2026 preprint).** A one-year pilot of 17 voluntarily participating undergraduates found useful zero-shot root-cause suggestions from ChatGPT/Gemini on buggy analog breadboards/PCBs, but also repeated 2-D/3-D wiring mistakes and unjustified confidence. Image use increased from 2/5 logs in Spring 2025 to 5/12 in Fall 2025. This is the closest evidence to ViBread's intended use and strongly supports MCU evidence as primary, constrained photo questions as secondary, and explicit uncertainty/human confirmation. ([paper](https://arxiv.org/html/2608.02955v1))

## 3) Existing MCP servers & tools

Verdicts use the project rubric: maintained in the last six months, real capability, sane security, headless Linux operation, and stdio or Streamable HTTP. “Good” means a realistic dependency for this weekend; “usable” means useful as a local sidecar/reference but not sufficient as ViBread's full product; “toy” means narrow/low-signal; “dead” means archived or stale.

| Name | URL | License | Last activity / signal (checked 2026-09-25) | Transport | Capabilities | Verdict |
|---|---|---|---|---|---|---|
| HardwareMCP `arduino-mcp-server` | [GitHub](https://github.com/hardware-mcp/arduino-mcp-server) | MIT | 19 stars; 19 commits; latest visible commit 2026-08-22 | MCP stdio; package is headless Node 20+ | Wraps `arduino-cli`: detect board/ports, ensure cores, compile/upload, stateful serial sessions (`open/read/expect/write/close`), board reference, safety preflight | **good**, but local USB only and not a browser Web Serial bridge. |
| `qarnet/serial-mcp` | [GitHub](https://github.com/qarnet/serial-mcp) | MIT | 9 stars; latest commit 2026-09-23; 0 open issues | stdio and HTTP; prebuilt Linux x64 binary | 25 tools; allowlisted ports; always-on ring buffer; `capture_boot`; DTR/RTS/BREAK; framing/parsers (JSON lines/COBS/SLIP/AT/NMEA/Modbus); logs/profiles; MCP 2025-11-25 and 2026-07-28 support | **good** for a laptop/sidecar serial bridge; does not flash and cannot see a browser-owned port. |
| `HumbertoBernal/mcp-serial` | [GitHub](https://github.com/HumbertoBernal/mcp-serial) | MIT | 1 star; 2 commits; last activity date [UNVERIFIED] from page; explicitly “PyPI release coming” | stdio and Streamable HTTP | Python/pyserial list/open/read/query/write/read-until/tail/reset/DTR/RTS; port allowlist and bounded reads; no flashing | **usable**, but very new/small and less mature than qarnet. |
| `sushiionwest/Uno-R3-MCP` | [GitHub](https://github.com/sushiionwest/Uno-R3-MCP) | MIT | 3 stars; latest commit 2026-07-25; 1 open issue | Node stdio | Uno-specific detect, compile/upload, serial reads, deterministic mock mode | **toy/usable** for a demo reference; too small and Uno-only to be the ViBread substrate. |
| `ThanabordeeN/MCP-U` | [GitHub](https://github.com/ThanabordeeN/MCP-U) | Other/NOASSERTION (license is not a standard SPDX license) | 4 stars; pushed 2026-05-15; updated 2026-08-09 | Node client; Serial/TCP modes documented | Dynamic MCU tool discovery, GPIO/PWM/ADC/I2C-style runtime tools, firmware API, mock testing | **toy/usable**; license ambiguity and dynamic arbitrary hardware control are both poor fits for a safety-critical weekend demo. |
| `Volt23/mcp-arduino-server` | [GitHub](https://github.com/Volt23/mcp-arduino-server) | MIT | 10 stars/9 forks in listing; exact latest commit [UNVERIFIED] | Python FastMCP stdio | `arduino-cli` sketches/boards/libraries/serial monitor plus optional WireViz/AI diagram generation | **usable** as an alternative; Python sidecar and optional arbitrary file operations increase setup/security scope. |
| Arduino Cloud/Create Agent | [agent](https://github.com/arduino/arduino-create-agent), [JS client](https://github.com/arduino/arduino-create-agent-js-client) | Agent AGPL-3.0; JS client GPL-3.0 | Mature/popular (465/32 stars); exact latest activity [UNVERIFIED] | Browser ↔ local tray agent over WebSocket/REST; not MCP | Upload/serial bridge for Arduino Cloud; real cross-platform product architecture | **usable external tool, not dependency**; AGPL/GPL conflict and tray-agent setup violate the low-setup/public-repo goal. |
| `firmata-web` + Firmata | [browser adapter](https://github.com/yellow-digital/firmata-web), [firmware](https://github.com/firmata/ConfigurableFirmata) | `firmata-web` license [UNVERIFIED]; ConfigurableFirmata LGPL-2.1 | Browser adapter has 3 stars and no visible commit history; ConfigurableFirmata 193 stars, latest visible activity 2025-12-26 | Web Serial browser; not MCP | Generic pin/analog/PWM/I2C/servo control; no netlist-aware safety oracle | **usable as optional manual mode**, not primary verification. |

No existing candidate exposed a netlist-aware, safe self-test plan, photo evidence, permission modes, fault attribution, and browser-owned USB in one maintained server. ViBread needs a small domain MCP layer (Section 5) rather than cloning any of these repositories.

## 4) Recommendation per sub-area

| Sub-area | Decision | Rationale |
|---|---|---|
| Uno/Nano browser flashing | **USE + WRAP** `webserial-flasher` | MIT, TypeScript, browser STK500v1, current as of 2026-03-31. Wrap profiles, reset pulse, signature verification, retries, and user-facing errors. |
| ESP32 browser flashing | **USE + WRAP** `esptool-js` | Official Espressif implementation, Apache-2.0, active 2026-09-21 release; backend must provide image binaries and security policy. |
| Uno R4 | **DEFER/WRAP host agent** | RA4M1 uses `dfu-util`/BOSSA, not STK500. Do not claim support in the AVR demo; report board mismatch and offer host-agent path. |
| Generic Firmata pin control | **WRAP, optional** | `ConfigurableFirmata` is mature and feature-rich; a thin browser transport can support manual exploration. Keep it behind an explicit unsafe/manual permission mode and never call it a circuit pass. |
| Circuit-specific self-test firmware | **BUILD** | The netlist, expected pin roles, safe current limits, interactive prompts, VCC/ADC tests, and evidence schema are ViBread's differentiator and cannot be outsourced to Firmata. |
| Electrical fault attribution | **BUILD** | Deterministic rules should combine continuity, stuck-at, VCC sag, ADC ranges, and interaction outcomes into `design/code/wiring/component/unknown` hypotheses. An LLM may explain a result, but not originate an unsafe pin sequence. |
| HCI assembly/test UX | **BUILD, informed by USE patterns** | Copy no implementation. Reuse evidence-backed concepts: incremental tests (ElectroTutor), net/wire highlighting (TAC/SchemaBoard), pervasive values (Toastboard/CurrentViz), and linked code/electrical timeline (Bifröst). |
| Photo verification | **BUILD pipeline + WRAP Claude vision** | No mature breadboard-photo-to-netlist dependency was found. Use deterministic fiducial rectification/grid/OCR/graph extraction, then ask Claude structured region questions with `unknown` allowed. |
| Serial MCP sidecar | **USE qarnet or HardwareMCP for development; BUILD ViBread domain MCP** | qarnet provides robust bounded serial/reset/logging; HardwareMCP provides Arduino CLI workflows. Neither understands browser-owned Web Serial or ViBread test specs/permissions. |

### 4.1 Generated self-test firmware contract

The backend should generate one sketch per validated design, with a compile-time `DesignId` and an explicit list of safe tests. A compact protocol is sufficient:

```text
boot: {"event":"ready","board":"uno","mcu":"atmega328p","design":"sha256:...","fw":"selftest-1"}
command: {"op":"run","nonce":"...","tests":["rails","continuity","button1","ldr1"]}
result: {"nonce":"...","test":"rails","status":"pass|fail|unknown|unsafe","measurements":{...},"hypotheses":[...],"next":"..."}
```

The generated sketch should:

1. Put all pins into safe inputs on boot and before/after every test.
2. Report board/MCU/design hash before accepting a test command.
3. Run VCC baseline and sag checks.
4. Run only net/pin tests approved by the design's safety metadata; never accept arbitrary pin numbers from the serial client.
5. Use deterministic sample counts, ADC settling delays, debounce windows, and timeouts.
6. Emit machine-readable measurements plus human-readable explanations; preserve raw data for the debugger.
7. Ask for interactive actions through `event:"prompt"` and accept `{"op":"answer","id":...,"value":...}`.
8. Include a final cleanup path that restores high-impedance pins, detaches servos, and turns outputs off.

## 5) If BUILD: proposed MCP server and tools

**Proposed name:** `vibread-hardware` (domain MCP; the main ViBread agent may expose it directly or proxy it through A2A). Implement in TypeScript on Bun/Node 22. Offer stdio for a local Claude Code sidecar and Streamable HTTP for the tunneled/container deployment. The MCP server must not execute arbitrary shell commands; compile/upload uses fixed adapters and allowlisted working directories.

The browser owns a Web Serial port, so the server cannot directly open that same device on the container. The server therefore returns a browser action request (`requestId`, expected operation, board profile, firmware asset, permission requirement) and the browser connector posts signed result events back. A laptop-side serial sidecar is an alternative for Claude Code sessions that need MCP-native hardware access.

| Tool | Inputs | Outputs |
|---|---|---|
| `hardware.discover` | `transport: "browser"|"sidecar"`, optional USB VID/PID allowlist | Candidate devices, board/profile guesses, explicit `confidence`, no auto-selection. |
| `hardware.session_open` | `deviceId`, `transport`, baud, permission mode | Session ID, board identity, reset capability, ownership lease. |
| `hardware.flash` | session ID, board profile, firmware asset/hash, `verify: boolean`, `permissionToken` | Pending browser action or sidecar result: signature, bytes, verify status, reset/application banner, warnings. |
| `hardware.serial_read` | session, timeout/max bytes, optional regex/JSON-lines parser | Bounded records and `bytesLost`; no unbounded tail. |
| `hardware.serial_expect` | session, pattern, timeout, nonce | Matched boot/test event or typed timeout. |
| `hardware.self_test` | session, design hash, generated test plan ID, interactive policy, max duration | Ordered test results, raw measurements, prompts, hypotheses and confidence. |
| `hardware.self_test_answer` | session, prompt ID, user answer (`yes/no/value`), permission token | Next test state; never accepts a pin command. |
| `hardware.capture_snapshot` | session, image asset ID or browser camera request, fiducial/layout profile | Rectified image asset, marker/grid quality, occlusion/lighting warnings. |
| `hardware.vision_verify` | rectified image asset, expected component/net regions, structured question set | JSON observations (`present`, orientation/value/endpoint candidates, confidence, unknown) plus evidence crop IDs; no automatic pass if MCU disagrees. |
| `hardware.close` | session ID | Closed/cleanup result and any lost-data warning. |

Permission policy should mirror Claude Code modes:

* **ask-every-time:** require explicit approval for port selection, reset, flash, actuator motion, and every interactive prompt.
* **review:** allow read-only discovery/serial/self-test observation; require approval for flash, reset, pin-output tests, servo motion, and any test marked `unsafe`.
* **bypass:** still enforce immutable board safety limits, port allowlists, test-plan hash matching, bounded timeouts, and cleanup. “Bypass” must not mean arbitrary raw GPIO.

## 6) Integration notes & gotchas for the ViBread stack

### 6.1 Compile in the container, flash in the laptop browser

`arduino-cli`/the compiler can run in the Linux container and produce a HEX/BIN asset. The browser receives an immutable, content-addressed firmware artifact over the app's authenticated HTTP channel and flashes through Web Serial on the laptop. Do not have the container attempt `/dev/ttyACM0`: the USB device is not there unless an explicit USB/IP or laptop sidecar is installed. Do not have the browser and qarnet/HardwareMCP open the same port concurrently.

### 6.2 Reset and bootloader timing

Call `setSignals()` only after `port.open()`. For Uno/Nano, try a short DTR pulse (deassert/assert or assert/deassert according to the adapter's observed behavior), wait for USB-serial reset/bootloader enumeration, then send several sync attempts at the selected baud. The bootloader can time out quickly; stale application output must be drained before sync. After flashing, the board resets and the application may reopen the same port; wait for the generated `ready` banner before self-test. ([Chrome serial guide](https://developer.chrome.com/docs/capabilities/serial), [MDN signals](https://developer.mozilla.org/en-US/docs/Web/API/SerialPort/setSignals), [Optiboot source](https://github.com/arduino/ArduinoCore-avr/blob/master/bootloaders/optiboot/optiboot.c))

A Nano-old failure should offer “Try old bootloader (57600)” rather than silently retrying forever. A wrong signature should stop and ask the user to select the correct board; never write a bootloader/flash based on an unverified guessed MCU.

### 6.3 Browser UX and permission constraints

`requestPort()` must be called from a user gesture. `getPorts()` may restore a prior grant after reload, but a first-time user must click. Filter by known VID/PIDs only to reduce picker clutter; show an “other USB serial” fallback for clones. Make Chrome/Edge support explicit and show the secure-origin URL the user should open. ([Chrome Web Serial](https://developer.chrome.com/docs/capabilities/serial), [MDN `requestPort`](https://developer.mozilla.org/en-US/docs/Web/API/Serial/requestPort))

### 6.4 Fault-test safety

Do not run a strong output-low matrix over arbitrary nets. The Uno has a 20 mA recommended per-pin current figure, but current limiting is not implemented by software; the generated plan must use known resistors or skip the test. Monitor VCC and reset signs, limit dwell, and restore input mode even on exceptions. Add an explicit `unsafe/not_tested` result so the agent cannot turn an unobservable case into a green check.

The VCC-bandgap result is a calibrated estimate of AVCC, not a precision current probe. Brown-out or VCC sag can be caused by servo/motor startup current, USB cable/rail resistance, a short, or an external supply. Use it to rank hypotheses and stop hazardous tests, not to identify a wire by itself. ([AN2447](https://ww1.microchip.com/downloads/en/AppNotes/00002447A.pdf), [ATmega328P BOD/ADC](https://ww1.microchip.com/downloads/en/DeviceDoc/Atmel-7810-Automotive-Microcontrollers-ATmega328P_Datasheet.pdf))

### 6.5 Vision capture and image handling pipeline

A reliable capture contract is more important than a larger model:

1. Ask the user to place the board on a matte, contrasting surface; power off for the assembly photo unless a powered-state photo is specifically needed.
2. Use a top-down phone view far enough away to include all board edges, row/column labels, and four printed ArUco/AprilTag fiducials outside the active holes. Keep the camera parallel and avoid wide-angle close-ups.
3. Use diffuse, even lighting; disable flash if it creates specular highlights; keep hands and loose wires out of the frame. The Solderless-Breadboard-Debugger prototype explicitly reports large shadows/specular reflections as its biggest recognition failure and assumes no overlaps. ([project README](https://github.com/obwang49/Solderless-Breadboard-Debugger))
4. On the Node server, detect HEIC by MIME/magic bytes. `heic-convert` 2.1.0 is ISC, pure JavaScript, and exposes a buffer-to-JPEG/PNG API; use it as the deterministic fallback. `sharp` is Apache-2.0 and excellent for resize/rotate/crop, but its documented common input list does not guarantee HEIC decoding in every prebuilt Linux/libvips build; use it after conversion or verify the deployed libheif support. Avoid `libheif-js` if the hackathon repository cannot accept its LGPL-3.0 dependency. ([heic-convert NPM](https://www.npmjs.com/package/heic-convert), [sharp docs/license](https://sharp.pixelplumbing.com/), [libheif-js metadata](https://registry.npmjs.org/libheif-js))
5. Detect fiducials with OpenCV ArUco/AprilTag support, estimate the board plane, and apply a homography/perspective warp. OpenCV documents that a square marker's four corners provide pose correspondences and that detection canonicalizes a perspective transform before decoding; use a confidence/reprojection threshold and reject the photo if markers are missing. ([OpenCV ArUco detection](https://docs.opencv.org/4.13.0/d5/dae/tutorial_aruco_detection.html), [OpenCV calibration](https://docs.opencv.org/5.0/tutorials/objdetect/aruco_calibration/aruco_calibration.html))
6. Rectify to a canonical board coordinate system, detect the hole grid and row/column labels, and crop component/wire regions. Build a candidate endpoint graph from geometry/OCR/color/continuity; compare it to the expected netlist, preserving `unknown` for occluded or unreadable endpoints.
7. Ask Claude only structured, localized questions: “Is the resistor body present in crop R3?”, “Which of the two visible leads enters holes E12/F12?”, “Is the diode stripe at the cathode end?”, “Is the row label legible?” Include the expected component type and candidate locations, require JSON schema output with confidence and evidence crop, and ask for `unknown` when the image cannot support an answer. The Schematic Network Extraction thesis found textual labels improved GPT-4o's consistency while netlist generation remained hardest. ([thesis](https://www.diva-portal.org/smash/get/diva2:2008968/FULLTEXT01.pdf))
8. Fuse photo observations with MCU results. If photo says “wire present” but continuity says open, report a conflict and ask for a close-up/reseat; do not override the electrical evidence. Chat Debugging and ElectroVizQA show that visual models can make confident 3-D/wiring mistakes even when they are broadly useful. ([Chat Debugging](https://arxiv.org/html/2608.02955v1), [ElectroVizQA](https://arxiv.org/html/2412.00102))

### 6.6 Minimal generated test catalog

| Test | Electrical/interaction signal | Best fault classes | Explicit limitation |
|---|---|---|---|
| `rails.vcc` | Internal-bandgap ADC estimate at idle and during load | Rail missing, VCC sag/overload, gross short | Cannot localize a short or measure current precisely; calibrate bandgap. |
| `net.continuity` | Safe continuity/matrix on approved net pairs | Missing wire, wrong row, short between testable pins | Unsafe for unguarded VCC/output nets; equivalent rows are indistinguishable. |
| `digital.stuck` | Expected idle/active transitions | Stuck-at GND/VCC, wrong input row, missing pull-up | Sensor/code/button state can look identical. |
| `analog.range` | ADC median/variance/step response | Missing divider/LDR/pot, wrong value/range, rail fault | High impedance and sensor environment affect readings. |
| `led.forward` | Current-limited drive, expected node drop, optional user confirmation | Reversed/missing/dead LED, missing resistor in many topologies | Reversed versus dead often needs a physical/photo/human check. |
| `button.interactive` | Release→press→release edge | Wrong row, stuck/reversed button, missing pull-up | Requires human action and debouncing. |
| `hcsr04.echo` | 10 µs trigger then echo timeout/width | Missing power/trigger/echo, dead sensor | Needs a target for range; echo presence does not prove distance. |
| `servo.motion` | Bounded PWM sweep plus human confirmation | Missing signal/power/ground, servo dead | No position feedback; external supply/mechanical jam ambiguous. |
| `sensor.interactive` | Cover/touch/move prompt and signal delta | Wrong sensor row, missing sensor, wrong divider | Environment and user behavior can confound. |

### 6.7 Fault detectability matrix

Legend: **D** = usually detectable by that channel under stated assumptions; **C** = conditionally/indirectly detectable; **H** = needs human confirmation; **N** = not reliably detectable by that channel alone.

| Fault type | MCU self-test | Phone photo | Human confirm | Not reliably detectable / caveat |
|---|---|---|---|---|
| Missing wire | **D** when both endpoints are in an approved continuity/functional path | **D/C** if the wire and holes are visible and rectified | **D** with guided inspection | Missing wire hidden under a component or on an equivalent net can be **N**. |
| Wrong row | **D/C** if it changes continuity, input, or measured function | **D/C** with legible row labels and fiducials | **D** with a clear row guide | A wrong row on the same electrical net is intentionally **N**. |
| Short to GND | **D/C** via stuck-low, VCC sag, safe matrix, or failed function | **C** if visible; occlusion/black wires reduce confidence | **D** with unplug/reseat/meter instruction | A weak/intermittent short may be **N** without a current probe. |
| Short between pins | **D/C** on approved matrix and unexpected transitions | **C/D** if both paths are visible and graph extraction succeeds | **D** with a guided continuity/meter check | Strong shorts to VCC can make output tests unsafe; unknown without external current limit. |
| Reversed LED/diode | **C** via forward response/current and generated blink | **C/D** if stripe/lead orientation is visible | **D** by guided polarity check or seeing no light | MCU alone often cannot distinguish reversed from dead/open without a safe diode test. |
| Missing resistor | **C** via unexpected current/voltage/LED behavior; **D** if topology has a required divider | **D/C** if body/legs are visible | **D** by BOM/assembly check | If the circuit still behaves acceptably or resistor is hidden, **N/C**. |
| Wrong resistor value | **C/D** with a known divider/current/ADC model | **C** with readable color bands/OCR; reflections make it unreliable | **D** with color-code/multimeter check | MCU cannot identify arbitrary value when no excitation/observable drop exists. |
| Dead component | **C/D** when it has a generated behavior test (button/sensor/HC-SR04/LED) | **N** for internal electrical health from a still photo | **D** by swap/meter/interactive response | Passive dead/open/short part without an excitation path is **N** to MCU/photo. |

The matrix is intentionally conservative. A green photo match can never erase a red/unknown MCU result, and a green MCU behavior result cannot prove exact physical row placement when multiple layouts are electrically equivalent.

## 7) Risks & unknowns

1. **Board identity:** Uno R3/Nano/clone and Nano-old/new bootloader are unconfirmed. Add a visible board selector and signature check; do not infer only from VID/PID. ([Arduino boards](https://github.com/arduino/ArduinoCore-avr/blob/master/boards.txt))
2. **R4/ESP32 scope creep:** Uno R4 upload is DFU/BOSSA and ESP32 is a different ROM loader. Keep the demo on Uno/Nano; route alternatives explicitly.
3. **Browser support/ownership:** Web Serial is Chromium/secure-context/user-gesture gated. A laptop browser can access its USB; a container MCP cannot, and two processes cannot safely share a port. ([MDN Web Serial](https://developer.mozilla.org/en-US/docs/Web/API/Web_Serial_API))
4. **Electrical damage:** An output-low matrix can damage a pin if the user has connected it to VCC or another actively driven output. Generate only safe tests, use current-limiting hardware/topology rules, stop on rail sag, and retain `unsafe/not_tested` outcomes. ([ATmega328P electrical characteristics](https://ww1.microchip.com/downloads/en/DeviceDoc/Atmel-7810-Automotive-Microcontrollers-ATmega328P_Datasheet.pdf))
5. **Bandgap accuracy:** The nominal 1.1 V reference is not a calibrated current sensor; temperature, chip variation, AREF/AVCC noise, and USB/supply resistance affect results. Calibrate or use thresholds with generous margins. ([AN2447](https://ww1.microchip.com/downloads/en/AppNotes/00002447A.pdf), [AVR120](https://ww1.microchip.com/downloads/aemDocuments/documents/OTH/ApplicationNotes/ApplicationNotes/Atmel-2559-Characterization-and-Calibration-of-the-ADC-on-an-AVR_ApplicationNote_AVR120.pdf))
6. **Observability gaps:** MCU tests cannot certify hidden passive values, internal component health, mechanical servo position, or photo-only row semantics. The matrix must show “unknown,” not hallucinate a diagnosis.
7. **Vision:** Glare, shadows, occlusion, perspective, low-resolution row labels, transparent/black wires, and 3-D bends defeat raw VLM reasoning. Fiducials and crops improve reliability but do not solve it. ([Solderless debugger](https://github.com/obwang49/Solderless-Breadboard-Debugger), [Chat Debugging](https://arxiv.org/html/2608.02955v1))
8. **Research-study limits:** Toastboard/CurrentViz/Bifröst/SchemaBoard/ElectroTutor results are small prototype studies; they justify UX hypotheses, not production accuracy guarantees. Use the reported sample sizes and limitations in the pitch.
9. **License hygiene:** Do not embed GPL-2.0 AVRDUDE, AGPL-3.0 Arduino Cloud Agent, GPL-3.0 Create Agent JS client, or CC-BY-SA benchmark assets. MIT/Apache-2.0/BSD/ISC dependencies are preferred; ConfigurableFirmata and Servo are LGPL and should be reviewed/attributed if included. ([AVRDUDE](https://github.com/avrdudes/avrdude), [Cloud Agent](https://github.com/arduino/arduino-create-agent), [Create Agent JS client](https://github.com/arduino/arduino-create-agent-js-client), [ElectroVizQA license](https://arxiv.org/html/2412.00102), [ConfigurableFirmata](https://github.com/firmata/ConfigurableFirmata), [Servo](https://github.com/arduino-libraries/Servo))
10. **MCP security:** Existing serial servers intentionally expose bytes/control lines. ViBread must add port allowlists, bounded buffers/timeouts, ownership leases, explicit permission modes, no arbitrary shell, fixed test-plan hashes, and cleanup on all failures.
11. **No direct “photo → netlist” standard found:** CircuitSense requires custom breadboard instrumentation; the open Solderless-Breadboard-Debugger is a one-star student project with no release and lighting limitations. Build a narrow evidence pipeline for the known ViBread assembly layout, not a general CV product. ([CircuitSense](https://ntuhci.org/wp-content/uploads/2017/12/circuitsense.pdf), [Solderless-Breadboard-Debugger](https://github.com/obwang49/Solderless-Breadboard-Debugger))

## 8) Sources

### Platform, boards, protocols, and tools

* [Chrome Web Serial](https://developer.chrome.com/docs/capabilities/serial)
* [MDN Web Serial API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Serial_API)
* [MDN `requestPort`](https://developer.mozilla.org/en-US/docs/Web/API/Serial/requestPort)
* [MDN `setSignals`](https://developer.mozilla.org/en-US/docs/Web/API/SerialPort/setSignals)
* [MDN Secure Contexts](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Secure_Contexts)
* [ArduinoCore-avr boards.txt](https://github.com/arduino/ArduinoCore-avr/blob/master/boards.txt)
* [Optiboot source](https://github.com/arduino/ArduinoCore-avr/blob/master/bootloaders/optiboot/optiboot.c)
* [Optiboot STK500 constants](https://github.com/arduino/ArduinoCore-avr/blob/master/bootloaders/optiboot/stk500.h)
* [webserial-flasher README](https://raw.githubusercontent.com/vielang/webserial-flasher/main/README.md)
* [webserial-flasher NPM metadata](https://registry.npmjs.org/webserial-flasher)
* [webserial-flasher commit history](https://github.com/vielang/webserial-flasher/commits/main)
* [avrgirl-arduino](https://github.com/noopkat/avrgirl-arduino)
* [avrgirl Web Serial demo](https://github.com/noopkat/avrgirl-arduino/blob/master/tests/demos/webserial/README.md)
* [js-stk500v1](https://github.com/hujiese/js-stk500v1)
* [js-stk500v1 history](https://github.com/hujiese/js-stk500v1/commits/master)
* [avrdude](https://github.com/avrdudes/avrdude)
* [avrdude WASM](https://github.com/leaphy-robotics/avrdude-webassembly)
* [Arduino Cloud Agent](https://github.com/arduino/arduino-create-agent)
* [Arduino Cloud Agent JS client](https://github.com/arduino/arduino-create-agent-js-client)
* [Espressif esptool-js](https://github.com/espressif/esptool-js)
* [esptool-js commit history](https://github.com/espressif/esptool-js/commits/main)
* [ArduinoCore-renesas boards.txt](https://github.com/arduino/ArduinoCore-renesas/blob/main/boards.txt)
* [ArduinoCore-renesas Uno R4 bootloaders](https://github.com/arduino/ArduinoCore-renesas/tree/main/bootloaders/UNO_R4)
* [BOSSA](https://github.com/shumatech/BOSSA)
* [ATmega328P datasheet](https://ww1.microchip.com/downloads/en/DeviceDoc/Atmel-7810-Automotive-Microcontrollers-ATmega328P_Datasheet.pdf)
* [Microchip AN2447 VCC measurement](https://ww1.microchip.com/downloads/en/AppNotes/00002447A.pdf)
* [Microchip AVR120 ADC calibration](https://ww1.microchip.com/downloads/aemDocuments/documents/OTH/ApplicationNotes/ApplicationNotes/Atmel-2559-Characterization-and-Calibration-of-the-ADC-on-an-AVR_ApplicationNote_AVR120.pdf)
* [Microchip AVR126 ADC](https://ww1.microchip.com/downloads/en/AppNotes/Atmel-8444-ADC-of-megaAVR-in-Single-Ended-Mode_ApplicationNote_AVR126.pdf)
* [HC-SR04 datasheet](https://cdn.sparkfun.com/datasheets/Sensors/Proximity/HCSR04.pdf)
* [Arduino Uno official pinout](https://docs.arduino.cc/static/c57a658e0f7afad334f6f73e82dfd83d/A000066-full-pinout.pdf)
* [Arduino Servo library](https://github.com/arduino-libraries/Servo)
* [Analog Devices LED-as-sensor activity](https://www.analog.com/en/resources/analog-dialogue/studentzone/studentzone-january-2023.html)
* [MERL bidirectional LED paper](https://merl.com/publications/docs/TR2003-35.pdf)

### Firmata

* [Firmata Arduino](https://github.com/firmata/arduino)
* [ConfigurableFirmata](https://github.com/firmata/ConfigurableFirmata)
* [Firmata.js](https://github.com/firmata/firmata.js)
* [Firmata.js history](https://github.com/firmata/firmata.js/commits/master)
* [firmata-web README](https://raw.githubusercontent.com/yellow-digital/firmata-web/master/README.md)
* [firmata-web repository](https://github.com/yellow-digital/firmata-web)

### HCI and physical debugging

* [Crossed Wires paper](https://openaccess.city.ac.uk/id/eprint/14844/12/booth-chi2016-cr.pdf)
* [Crossed Wires DOI](https://doi.org/10.1145/2858036.2858533)
* [Toastboard paper](https://people.eecs.berkeley.edu/~bjoern/papers/drew-toastboard-uist2016.pdf)
* [Toastboard DOI](https://doi.org/10.1145/2984511.2984566)
* [Visible Breadboard ACM record](https://doi.org/10.1145/1836845.1836950)
* [CurrentViz paper](https://teyenwu.com/publications/CurrentViz.pdf)
* [CurrentViz DOI](https://doi.org/10.1145/3126594.3126646)
* [Bifröst paper](https://jeremywrnr.com/papers/BifrostUIST2017.pdf)
* [Bifröst DOI](https://doi.org/10.1145/3126594.3126658)
* [Trigger-Action-Circuits paper](https://www.research.autodesk.com/app/uploads/2023/03/trigger-action-circuits-leveraging.pdf_recJhQeai7lWIR6C9.pdf)
* [Trigger-Action-Circuits DOI](https://doi.org/10.1145/3126594.3126637)
* [ElectroTutor paper](https://www.benlafreniere.ca/assets/papers/Warner_-_UIST2018_-_ElectroTutor.pdf)
* [ElectroTutor DOI](https://doi.org/10.1145/3242587.3242591)
* [CircuitSense paper](https://ntuhci.org/wp-content/uploads/2017/12/circuitsense.pdf)
* [CircuitSense DOI](https://doi.org/10.1145/3126594.3126634)
* [SchemaBoard paper](https://make.kaist.ac.kr/files/2020/Kim_SchemaBoard_UIST20.pdf)
* [SchemaBoard project](https://artifab.yoonji-kim.com/publications/schemaboard)

### LLM, vision, and image processing

* [WIRES / From Words to Wires (EMNLP 2023)](https://aclanthology.org/2023.findings-emnlp.864.pdf)
* [WIRES code/data](https://github.com/cognitiveailab/words2wires)
* [EEE-Bench (CVPR 2025)](https://openaccess.thecvf.com/content/CVPR2025/html/Li_EEE-Bench_A_Comprehensive_Multimodal_Electrical_And_Electronics_Engineering_CVPR_2025_paper.html)
* [EEE-Bench arXiv](https://arxiv.org/html/2411.01492)
* [ElectroVizQA](https://arxiv.org/html/2412.00102)
* [ElectroVizQA code](https://github.com/Pragati-Meshram/ElectroVizQA)
* [Schematic Network Extraction thesis](https://www.diva-portal.org/smash/get/diva2:2008968/FULLTEXT01.pdf)
* [Chat Debugging](https://arxiv.org/html/2608.02955v1)
* [OpenCV ArUco detection](https://docs.opencv.org/4.13.0/d5/dae/tutorial_aruco_detection.html)
* [OpenCV ArUco calibration](https://docs.opencv.org/5.0/tutorials/objdetect/aruco_calibration/aruco_calibration.html)
* [Solderless-Breadboard-Debugger](https://github.com/obwang49/Solderless-Breadboard-Debugger)
* [sharp](https://sharp.pixelplumbing.com/)
* [heic-convert](https://www.npmjs.com/package/heic-convert)
* [libheif-js NPM metadata](https://registry.npmjs.org/libheif-js)

### MCP candidates

* [HardwareMCP Arduino server](https://github.com/hardware-mcp/arduino-mcp-server)
* [HardwareMCP commit history](https://github.com/hardware-mcp/arduino-mcp-server/commits/main)
* [qarnet serial-mcp README](https://raw.githubusercontent.com/qarnet/serial-mcp/main/README.md)
* [qarnet serial-mcp repository metadata](https://github.com/qarnet/serial-mcp)
* [HumbertoBernal mcp-serial](https://github.com/HumbertoBernal/mcp-serial)
* [Uno-R3-MCP](https://github.com/sushiionwest/Uno-R3-MCP)
* [MCP-U](https://github.com/ThanabordeeN/MCP-U)
* [Volt23 mcp-arduino-server](https://github.com/Volt23/mcp-arduino-server)

**Evidence note:** stars and latest visible commit/release dates above are snapshots observed on 2026-09-25; they are maintenance signals, not quality guarantees. Claims about exact license/activity for pages marked **[UNVERIFIED]** were not asserted as facts.