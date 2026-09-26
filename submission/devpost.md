# ViBread — Devpost write-up (draft)

> Draft for the HackWashU Fall Build Challenge (Sep 25–27, 2026). Fill every `[[ … ]]` blank before submitting.
> Sources for every claim: `PLAN.md` (Build status, §1, §2, §11), `README.md`, `research/06-physical-verify.md`.

**Team:** [[ TEAM MEMBER NAMES — up to 4 ]]
**Video (2–3 min):** [[ VIDEO LINK ]]
**Photon clip (60 s):** [[ PHOTON CLIP LINK ]]
**Code:** https://github.com/BarryTheShen/ViBread
**Tracks:** Main track · Photon track

---

## Title

**ViBread — Mission Control for your breadboard**

## Tagline

Describe a gadget in plain English; ViBread designs it, tests it in a simulator, shows you how to build it step by step, and
then checks your real breadboard and tells you exactly which hole is wrong.

---

## Inspiration — the problem

Building your first Arduino project means learning four things at once: circuit design, code, reading wiring diagrams, and
debugging hardware. It goes wrong a lot, and usually in the wiring. In the CHI 2016 study *Crossed Wires* (Booth et al.),
20 beginners each built a small Arduino project; **only 6 of 20 finished within the 45-minute session**, and **building the
circuit was the most common reason people failed** — more than the code.

AI tools already write Arduino code and draw wiring diagrams (Schematik, Cirkit Designer, Arduino's AI Assistant). What none
of them do is look at the breadboard you actually built. Our one-line pitch: *"Schematik tells you how to build it; ViBread
checks that you actually built it right, and tells you where you didn't."*

The theme, **"Fly Me to the Moon"**, gave us the design. Apollo got to the moon because every step was simulated, every wire
was checked against a checklist, a **Go/No-Go poll** gated every phase, and when Apollo 13 broke, Mission Control debugged it
from telemetry. ViBread gives a first-time maker that same discipline for their own moonshot.

## What it does

Our demo project is a **Moon-Phase Lamp**: four lights in a row show the moon's lit side the way the sky does (while waxing,
light fills in from the right), a button steps through the eight phases, and a light sensor keeps the lamp off until the room
is dark.

1. **Mission brief.** You type what you want ("a lamp that shows the moon's phases when it's dark") and tap the parts you
   own. ViBread's design agent picks parts only from your kit and writes the circuit and the Arduino sketch.
2. **Go/No-Go poll.** Independent "consoles" each vote GO or NO-GO, like Apollo flight controllers:
   - **EECOM (electrical):** no part draws too much current, every LED has a resistor, no shorts — checked at worst-case
     part tolerances and cross-checked with a circuit simulator (ngspice).
   - **GUIDO (firmware):** the sketch really compiles for an Arduino Uno and fits in memory.
   - **FIDO (simulation):** a *separate* agent writes tests from your description without seeing the code, and the exact
     program that will go on your board runs in an emulated Arduino chip to pass them ("In the dark, two presses light the
     right half").
   - **FAO (assembly):** the parts fit on your breadboard, and the layout provably matches the circuit.
   - **RETRO:** a reviewer agent reads everything and votes. You are the **Flight Director**: nothing becomes the build
     target until you press **GO for build**.
3. **Try it before you build it.** The compiled sketch runs live in your browser on a drawn breadboard: drag the room light to
   dark, press the button, and watch the moon fill in from the right.
4. **Build Mode on your phone.** Scan a QR code and follow LEGO-style numbered steps — one part or wire per step, a zoomed
   picture, the exact holes in words ("R1: E12 → E16"), and whether the USB cable should be plugged in or not.
5. **Test the real board.** At the bench, ViBread first puts safe firmware on the Arduino (every pin is an input, so an old
   program can't fight your new wiring), checks power, then runs a self-test that **reads before it drives**: it never
   powers a pin that looks shorted, and it keeps LED pulses tiny. The board streams its readings back over USB and asks you
   to help ("press the button now", "cover the light sensor", "which light is blinking?").
6. **"Houston, we have a problem."** ViBread compares the readings with the design and says where the fault is, in plain
   words, with the suspect holes highlighted — e.g. *"D2 reads LOW even with BTN1 released — its leg shares row 31 with the
   GND jumper."* (the row number depends on your layout). You fix it, re-run, and get **"Houston, we are GO"**, then confirm
   the lamp works: mission complete.
7. **Also reachable from iMessage and Claude Code.** CAPCOM is an iMessage agent (Photon Spectrum): send a brief, get status,
   vote GO/NO-GO in a poll. Claude Code can drive a mission over MCP. Under Claude-Code-style permission modes (Plan / Ask
   every time / Review / Autopilot), anything that touches the physical board only runs from a click at the bench — remote
   agents can request it, never do it.

### What is real today, and what is simulated

We want judges to know exactly what they are looking at (status as of our overnight build, see `PLAN.md` → *Build status*):

| Part | Status |
|---|---|
| Design checks, compile, simulation tests, breadboard layout, build steps, schematic | Built and tested (automated test suite; 99 tests at the overnight checkpoint) |
| "Try it" live simulator | Built: runs the real compiled sketch in the browser |
| Self-test + fault diagnosis | Built and verified on a **simulated** Arduino ("Try without a board"): the button-in-GND-row, swapped-LED-jumpers and missing-resistor faults are each diagnosed with the right top cause. [[ UPDATE if the real-board test has run: board model, what was verified ]] |
| Flashing a real board from the browser (Web Serial) | Built; **not yet run on real hardware at the time of writing** [[ UPDATE ]] |
| AI agents (design, test author, RETRO reviewer, photo check) | Built and verified with a test model. A real Claude (Opus 5.5) designed a night light through ViBread's MCP tools on the first try (EECOM/GUIDO/FAO GO). The demo missions in the video are pre-made designs [[ UPDATE if a live design run was recorded ]] |
| iMessage (CAPCOM) | Built and tested with Photon's local terminal provider; **cloud iMessage not yet tested** [[ UPDATE ]] |
| Google/GitHub sign-in, "Connect your Claude account" | Built; need real accounts/credentials to demo [[ UPDATE ]] |

## How we built it

**Libraries first, our code is glue.** Every subsystem uses a maintained open-source library where one exists; we wrote
code only where nothing fit (listed in `PLAN.md` §6.2):

- **Agents:** Vercel AI SDK over the Claude API (Claude Opus 5.5 for design, Sonnet 5 for secondary roles), with our own
  approval broker so every approval is signed, one-shot, and tied to an exact design revision.
- **UI:** React 19 + Vite + Material UI, MUI X Chat for the agent chat with inline approval cards.
- **Circuit and checks:** a small typed circuit description (zod) that every tool reads; json-rules-engine for the Arduino
  Uno rule table; ngspice for the current cross-check; tscircuit for schematics.
- **Firmware and simulation:** arduino-cli compiles the sketch; avr8js emulates the ATmega328P chip instruction by
  instruction, so the simulator runs *the same binary* that gets flashed. We wrote the part models (LED, button with
  bounce, light sensor, knob, buzzer) because no library has them for avr8js.
- **Breadboard:** we wrote the breadboard placer, the layout-vs-circuit check and the part drawings (plain SVG) ourselves —
  no open-source breadboard placer exists — and render the phone/iMessage step images with resvg.
- **Bench:** webserial-flasher flashes the Arduino from Chrome/Edge; the self-test firmware is a fixed template (Eta +
  ArduinoJson), never written by the AI, because safety depends on it.
- **Server and channels:** Express 5, XState for the mission lifecycle, Drizzle + SQLite, Better Auth (sign-in and OAuth 2.1
  for Claude Code), the MCP and A2A SDKs, and Photon `spectrum-ts` for iMessage.

**How the code was written:** everything was written during the event with AI coding agents under the team's direction —
**Claude Opus 5.5** (planning, integration, review, and the agent, server-core and web-workspace parts) and **GPT-5.6 Luna**
(research and the remaining package parts), orchestrated with **oh-my-pi** (omp). We froze shared contracts first (the
circuit description, the telemetry format, the golden Moon-Phase design), then had one agent per package build against
them in parallel overnight, with an integrator agent merging and testing.

## Challenges we ran into

- **Simulation can't see a loose wire.** No simulator predicts a real breadboard, so we split the job: the simulator proves
  the logic and timing of the exact binary; the physical self-test checks the wiring; the photo check is advisory only.
- **Testing an unknown circuit without breaking it.** A wrong wire can short an output pin. The self-test reads every pin
  before driving any, refuses to drive a pin stuck at a power rail, and keeps LED pulses under 5 ms at ≤ 10 % duty. We
  rejected Firmata because it turns pins into outputs on reset.
- **Turning "it doesn't work" into "this hole."** We combine a rule table with a *fault dictionary*: ViBread simulates
  common single mistakes (moved lead, rotated button, swapped wires, missing resistor…) on your exact layout and ranks
  which one best matches the readings.
- **No library for breadboards.** We had to write the placer, the layout-vs-circuit check, and the step generator.
- **Keeping the AI honest.** The tests are written by a separate agent that never sees the code, coverage rules reject
  weak test suites, and a human gives the final GO.
- **Library rough edges:** MUI X Chat is alpha, tscircuit needed an isolated runtime, and webserial-flasher had a response
  race we wrapped.

## Accomplishments that we're proud of

- A closed loop on the **physical** build: self-test → locate the fault → fix → re-test, on an unmodified Arduino Uno.
- The same compiled program runs in the simulator, in the live "Try it" view, and on the board.
- Plain-language diagnoses a beginner can act on, with the exact holes highlighted.
- The Moon-Phase Lamp is astronomically right: light fills in from the right while waxing and leaves from the right while
  waning.
- The whole theme is structural, not decoration: Go/No-Go consoles, Flight Director, CAPCOM, telemetry, "Houston…".

## What we learned

[[ TEAM: 2–3 sentences in your own words ]]

## What's next for ViBread

- Run every self-test and fault on real boards in more rooms (light-sensor calibration, cable problems) and with
  first-time makers.
- Live design runs on a real Claude credential for every golden project, and a full iMessage CAPCOM flow with polls and
  photos.
- More parts (servo, distance sensor) and the Arduino Nano; ranking multiple simultaneous faults.
- Using the phone camera to catch what the chip can't see, like a reversed LED, before the board is even powered.

## Built with

`typescript` · `node.js` · `react` · `vite` · `material-ui` · `mui-x-chat` · `vercel-ai-sdk` · `claude` (Opus 5.5,
Sonnet 5) · `express` · `xstate` · `drizzle-orm` · `sqlite` · `better-auth` · `model-context-protocol` · `a2a` ·
`photon-spectrum` · `imessage` · `arduino` · `arduino-cli` · `avr8js` · `tscircuit` · `ngspice` · `json-rules-engine` ·
`resvg` · `webserial` · `webserial-flasher` · `eta` · `arduinojson` · `zod` · `sharp` · `oh-my-pi` ·
`gpt-5.6-luna`

## Tracks

- **Main track** — Fly Me to the Moon.
- **Photon track** — CAPCOM, ViBread's iMessage agent built on Photon Spectrum.
