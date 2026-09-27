# ViBread — Devpost write-up (draft)

> Draft for the HackWashU Fall Build Challenge (Sep 25–27, 2026). Fill every `[[ … ]]` blank before submitting.
> Claims below are grounded in `README.md`, `HOW-IT-WORKS.md`, `PLAN.md`, the code, and the recent commit history.

**Team:** [[ TEAM MEMBER NAMES — up to 4 ]]
**Video (2–3 min):** [[ VIDEO LINK ]]
**Photon clip (60 s):** [[ PHOTON CLIP LINK ]]
**Code:** https://github.com/BarryTheShen/ViBread
**Tracks:** Main track · Photon track

---

## Title

**ViBread — Mission Control for your breadboard**

## Tagline

Describe a gadget in plain English; ViBread designs it from your inventory, tests the exact sketch in simulation, shows you how to build it step by step, and provides a USB bench self-test for finding wiring faults.

---

## Inspiration — the problem

Building a first Arduino project means learning circuit design, embedded code, wiring diagrams, and hardware debugging at the same time. It goes wrong often, usually in the wiring. In the CHI 2016 study *Crossed Wires* (Booth et al.), **only 6 of 20 beginners finished within the 45-minute session**, and circuit construction was the most common reason people failed.

Existing tools can turn a description into Arduino code or a wiring diagram. We wanted to close the gap between the proposed diagram and the breadboard that a beginner actually assembled. Our one-line description is: *“Schematik tells you how to build it; ViBread checks that you actually built it right, and tells you where you didn’t.”*

The theme, **“Fly Me to the Moon,”** gave us a useful structure rather than just a visual theme. Apollo used simulation, checklists, Go/No-Go decisions, and telemetry-driven troubleshooting. ViBread applies those ideas to a small maker circuit.

## What it does

Our demo project is a **Moon-Phase Lamp**: four lights in a row show the moon’s lit side, a button advances through eight phases, and a light sensor keeps the lamp off until the room is dark.

1. **Mission brief.** Describe the behavior and choose parts from your inventory. Inventory can come from typed input or a camera/upload scan with a review step; the typed parser handles quantities, parentheses, units, and combined entries. The part-type editor handles corrections, and missions use the resulting inventory.
2. **Design and checks.** The design agent runs in the server on pi and edits the design directly. Five consoles report GO or NO-GO:
   - **EECOM (electrical):** current limits, LED resistors, shorts, and other Uno rules, with an ngspice cross-check when available.
   - **GUIDO (firmware):** compile, memory, and code-to-circuit pin checks.
   - **FIDO (simulation):** a separate test-author call writes intent tests without seeing the sketch. Tests use simultaneous `expect-parts` checks and absolute-time annotations. A failed test is reviewed against the intent; a wrong test is corrected without changing the sketch, or set aside so it only warns. Checks are open-ended with wide tolerances. Suites remain stable across unchanged revisions, and the design can dispute a test instead of weakening behavior to satisfy it.
   - **FAO (assembly):** the allocator wires part-to-part links and fan-outs, runs LVS inside the placement loop, and stays within the 20-part/20-signal-net envelope. It follows a written layout philosophy, the same rules in the design prompt, the docs and the allocator’s scoring: repeated units sit in one regular row in the same order as their Arduino pins, with one short wire each and no crossings, like a hand-built board. The Uno is turned per layout so the pin order runs along the row. Crossing wires, irregular rows and labels out of order are findings; a placement the design asked for but the board can’t fit (`PLACEMENT-UNMET`) is a NO-GO, and every blocking finding says what the design agent can change, such as the bigger breadboard or fewer parts, so it never stops to wait for a fix.
   - **RETRO:** an independent review call compares the brief, design, sketch, and results.
3. **GO for build.** Claude can edit designs directly, but releasing a revision as the build target is human-only: press the web button or send `GO` through iMessage. Physical bench actions still require a click at the bench. When a person knows better than a check, an **“I know what I’m doing” override** lets them release past failed simulation tests, accept a failed bench self-test or power check, flash the app, or finish the mission. It is web-only, never changes a verdict, and every bypass is recorded on the mission timeline.
4. **Try it before wiring.** The resizable panel runs the compiled sketch in a browser worker. Press buttons on the drawing, change light or knob inputs, hear the buzzer (muted by default), and inspect a serial monitor with auto-scroll.
5. **Build Mode.** A phone QR code opens numbered LEGO-style steps with exact holes, pictures, and the USB plug state. A repeated sub-assembly is built once in detail (“Build one light unit (1 of 5)”), then a **“Repeat ×4 more”** step shows the other copies on the board with a checklist per copy. The binary counter went from 35 steps to 13. Rule-based wire colours can be overridden by tapping a wire or net; the choice carries through later steps, pictures, the schematic, the breadboard view, and Try it.
6. **Bench verification.** After a human connects an Arduino over USB, the bench can flash safe firmware, check power, run a read-before-drive self-test, ask for interactive observations, and diagnose likely causes with highlighted holes. On the computer running ViBread it flashes with avrdude from the bundled arduino-cli; Web Serial is the browser fallback. Practice runs on the virtual board never count as real-board results. Remote agents can request a bench action, but the browser never runs it without the person’s click.
7. **Other channels and connections.** CAPCOM provides the iMessage path through Photon: Claude’s questions and mission notices for every linked mission, answerable by text, with quiet hours. Claude Code can drive missions through MCP. A whole project exports to a `.vibread` file and imports on another computer with an integrity check. Settings offers pi-ai’s Claude sign-in with paste-back from another computer or an API key checked with Anthropic. The product has no design permission modes: there are no Plan, Ask every time, Review, or Autopilot modes.

### What is real today, and what is simulated

Status as of Sep 27, 2026:

| Part | Status |
|---|---|
| Checks, compile, simulation, layout, steps, and schematic | Built and tested. `npx vitest run` from the repo root passed **78 files / 566 tests**. Schematic drawings use elkjs layered layout plus a connectivity/overlap check; failures become a titled connection table. |
| Breadboard allocator and FIDO behavior | Built and tested with every net wired, LVS in the loop, placement summaries, stable suites, test review, set-aside tests, and open-ended checks. |
| Try it | Built and tested with the exact compiled sketch in the browser simulator, interactive controls, muted-by-default buzzer audio, and the serial monitor. |
| Self-test and fault diagnosis | Built and verified on a simulated Arduino. The fault table injects 23 single wiring faults that change a connection across the golden designs: 20 are caught, with the true cause ranked first in 14 and second in 6; the 3 missed are a wrong resistor value, which a digital self-test can’t measure. **A real Arduino run is not yet verified.** [[ UPDATE with board results if available ]] |
| Camera-first inventory and photo check | Built with typed parts, laptop/phone/upload scanning, review and editing, and advisory per-part photo answers. A real phone photo and live scan with the team’s credential are not yet verified. [[ UPDATE ]] |
| pi agents and Claude connection | The pi design agent and pi-ai structured calls for test author, RETRO, photo check, and scan are built and covered by tests. The documented real-model benchmark is historical; a live design run through the current pi path with the real Claude API is **not yet verified**. [[ UPDATE ]] |
| Desktop app | Electron installers are numbered and published by CI after green builds. Each packaged app is launch-tested on its target OS; Windows also has a server/sign-in smoke. |
| Real Arduino over USB | Tried by a tester on Windows with a CH340 Uno (Optiboot): the bench opens the port and the bootloader answers, but the Web Serial upload lost sync. The tester’s logs showed Optiboot ignores the first ~440 ms after reset and buffers only 3 bytes, and the tester’s pull request fixed the sync (desktop 0.1.91). A complete real flash and self-test is **not yet confirmed**. [[ UPDATE with the tester’s result ]] |
| iMessage and sign-in | The terminal Photon provider and OAuth test paths are covered. **Cloud iMessage, real Google/GitHub OAuth accounts, and a real Claude account sign-in remain unverified.** [[ UPDATE ]] |

## How we built it

**Libraries first, our code is glue.** We used maintained libraries where they fit and wrote the circuit-specific pieces that had no suitable library:

- **Agents:** `@earendil-works/pi-agent-core` and `pi-ai` run the design agent in-process in the server. Test author, RETRO, photo check, and scan are pi-ai structured calls. The server translates pi events into the AI SDK UI-message stream; AI SDK is not the agent loop.
- **UI:** React, Vite, Material UI, and assistant-ui provide the MUI-styled chat. Tool calls become grouped rows, questions are answerable cards, and a stopped response gets a Stop marker. The web uses `@ai-sdk/react` and the UI-message stream contract.
- **Circuit and schematic:** a typed zod circuit description, json-rules-engine, ngspice, and an isolated elkjs runtime. elkjs supplies layered layout and routing; every drawing gets a connectivity and geometry check, with a titled connection table as fallback.
- **Firmware and simulation:** arduino-cli compiles the sketch; avr8js emulates the ATmega328P instruction by instruction, so the simulator runs the same binary that would be flashed. We wrote the modeled LED, button, light sensor, knob, and buzzer behavior.
- **Breadboard and bench:** the allocator handles full net wiring, fan-outs, placement groups, and LVS in the loop. SVG drawings and resvg produce browser and phone/iMessage artifacts. webserial-flasher handles browser flashing, while the fixed Eta/ArduinoJson self-test firmware is never written by the AI.
- **Server and channels:** Express, XState, Drizzle, SQLite, Better Auth, the MCP and A2A SDKs, and Photon `spectrum-ts` provide the mission lifecycle, storage, external agent channel, sign-in, and iMessage path. Settings → Diagnostics shows redacted server and mission logs.

**How the code was written:** everything was written during the event with AI coding agents under the team’s direction — Claude Opus 5.5 for planning, integration, review, and major agent/server/web slices, and GPT-5.6 Luna for research and remaining package slices. In the final stretch, every change from a Luna agent was checked by an independent AI reviewer before it was merged, and the reviews caught real bugs. We used **oh-my-pi only as the team’s development orchestration tool**; it is not part of ViBread. We froze shared contracts first (the circuit description, telemetry format, and golden Moon-Phase design), then built package slices in parallel with an integrator running the checks.

## Challenges we ran into

- **Simulation cannot see a loose wire.** The exact compiled program and modeled parts prove logic, timing, and pin setup; the physical self-test is responsible for wiring and contact problems, while photo checking stays advisory.
- **Testing an unknown circuit safely.** The fixed self-test reads pins before driving them, refuses a pin that looks stuck at a rail, and limits LED pulses. Firmata was not suitable because it can set pins to outputs during reset.
- **Turning “it does not work” into a location.** The rule table and fault dictionary compare telemetry with simulated single-fault variants and rank likely causes with highlighted holes. The remaining unknowns are reported instead of invented.
- **Keeping tests independent and useful.** FIDO tests are authored without the sketch. `expect-parts`, absolute times, test review, stable suites, and `dispute_test` prevent a failing or stale test from forcing a design regression.
- **Making layout claims honest.** The allocator had to wire every net, check LVS during placement, and expose placement summaries and no-fit findings so the agent only describes the layout it actually received.
- **Moving the agent runtime without breaking the chat.** We moved the design loop to pi while preserving the UI-message stream consumed by assistant-ui and `@ai-sdk/react`; the single-shot roles also moved to pi-ai structured calls.
- **Flashing a real Uno from a browser.** Optiboot ignores the first ~440 ms after reset and its receive buffer holds 3 bytes, so a burst of sync requests overruns it. The fix sends one GET_SYNC at a time, and the fake Uno in our tests now models the deaf window.
- **QA under event time.** Two independent testers filed 24 GitHub issues and a pull request. We reproduced each, fixed it with a regression test, closed it with the root cause, and used the resulting issue-driven loop for the final passes.

## Accomplishments that we're proud of

- A complete software path from inventory and brief through design, independent tests, review, layout/LVS, build steps, Try it, and a bench self-test with fault explanations.
- The exact compiled binary runs in the headless simulator and live Try it view; the same generated sketch is the artifact prepared for a board. The physical-board result is still explicitly unverified.
- An allocator that wires part-to-part links and fan-outs, checks LVS inside the loop, supports placement groups, and tells the agent when the requested layout cannot be met.
- Camera-first inventory, typed parsing, editable part types, persistent wire-colour overrides, and diagnostics that are useful during a real run.
- The Moon-Phase Lamp behavior and its eight-phase test suite, plus a schematic fallback that never presents a failed drawing as trustworthy.
- The Apollo structure is functional: console findings, human GO for build, staged bench actions, telemetry, and “Houston” diagnoses.
- Tester issues turned into reproduced fixes, regression tests, and closed root causes: 25 of 26 issues closed, and a tester’s own pull request merged.

## What we learned

[[ TEAM: 2–3 sentences in your own words ]]

## What's next for ViBread

- Run the safe flash, rail check, calibration, self-test, and final sketch on a real Uno or Nano over USB, then repeat with first-time makers in different rooms.
- Run the current pi pipeline with a real Claude credential for the golden projects and complete the cloud Photon/iMessage round trip.
- Verify real Google/GitHub OAuth accounts and the real Claude account sign-in path.
- Add more supported parts such as a servo and distance sensor, and improve diagnosis of multiple simultaneous faults.
- Use camera checks to catch faults the microcontroller cannot observe, such as a reversed LED, before power is applied.

## Built with

`typescript` · `node.js` · `react` · `vite` · `material-ui` · `assistant-ui` · `pi-agent-core` · `pi-ai` · `vercel-ai-sdk` (`ai` / `@ai-sdk/react`; UI-message stream only) · `electron` · `elkjs` · `express` · `xstate` · `drizzle-orm` · `sqlite` · `better-auth` · `model-context-protocol` · `a2a` · `photon-spectrum` · `imessage` · `arduino` · `arduino-cli` · `avr8js` · `ngspice` · `json-rules-engine` · `resvg` · `webserial` · `webserial-flasher` · `eta` · `arduinojson` · `zod` · `sharp`

## Tracks

- **Main track** — Fly Me to the Moon.
- **Photon track** — CAPCOM, ViBread’s iMessage agent built on Photon Spectrum.
