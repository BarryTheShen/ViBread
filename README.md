# ViBread — Mission Control for your breadboard

ViBread helps non-technical makers go from "a lamp that turns on when it's dark" to a working Arduino breadboard. You
describe what the circuit should do; ViBread's agent designs it (parts from your kit, netlist, Arduino sketch), a
**Go/No-Go poll** of independent checkers verifies it, LEGO-style numbered steps show how to build it on laptop and
phone, and a **self-test over USB** checks the real build and says *where* it is wrong ("Houston, we have a problem: D2
reads LOW even with the button released — its leg shares row 17 with the GND jumper").

Built for the HackWashU Fall Build Challenge (Sep 25–27, 2026; theme "Fly Me to the Moon"). The full plan is in
[PLAN.md](PLAN.md); research and hands-on library audits are in [research/](research/).

## What's in the box

| Console | What it checks | Built on |
|---|---|---|
| **EECOM** electrical | Typed ERC + Uno rule table (current per pin/total, LED resistor, floating button, PWM/I²C/SPI/serial pins, shorts, KiCad-style pin-type conflicts) at worst-case corners; ngspice cross-check | json-rules-engine, ngspice |
| **GUIDO** firmware | The sketch compiles for the chosen board; flash/RAM budget; pin modes observed in simulation match the design | arduino-cli, avr8js |
| **FIDO** simulation | An independent test author's scenarios pass against the exact binary, with coverage rules (every output asserted, every input exercised, bounce/threshold/hysteresis cases) | avr8js |
| **FAO** assembly | A deterministic breadboard layout fits, and LVS proves the layout's nets equal the design's nets | our allocator + LVS |
| **RETRO** review | A separate agent compares brief, design, sketch and results and votes GO/NO-GO | Claude |

Then: numbered build steps with the USB plug state on every step (phone Build Mode polls the server), safe firmware
before any wiring, a rail checkpoint, and a read-before-drive self-test whose telemetry is diagnosed against the design
(rule table + a simulated single-fault dictionary). A "Try it" tab runs the real compiled sketch live in the browser.
Photo check (Claude vision) is advisory only.

The same mission is reachable from **iMessage** ("CAPCOM", via Photon Spectrum) and from **Claude Code** over MCP, under
Claude-Code-style permission modes: **Plan / Ask every time / Review (default) / Autopilot**. Physical actions (flash,
self-test, rewiring) only ever run from a click at the bench browser; iMessage can pre-approve them, remote agents can
only request them.

## Quick start (laptop or the dev container)

Requirements: Node ≥ 22.12, npm ≥ 10, Linux x64 (arduino-cli binary), Chrome or Edge for Web Serial. ngspice is optional
(`apt install ngspice`) for the SPICE cross-check.

```bash
npm install                  # also installs the isolated tscircuit runtime (packages/assembly/schematic-runtime)
npm run setup:toolchain      # arduino-cli 1.5.1 (checksum-pinned) + arduino:avr@1.8.8 + ArduinoJson 7.4.2 → .toolchain/
npm run build                # builds the web app (apps/web/dist), served by the server
npm run seed                 # optional: pre-warmed golden missions (Moon-Phase Lamp, Knob Night-Light, Launch Control)
npm start                    # http://localhost:8787
```

Development: `npm run dev:server` (port 8787) and `npm run dev:web` (Vite on 5173, proxies `/api`, `/mcp`, `/a2a`).
Tests: `npm test` (vitest; compiles firmware and runs the simulator, ~30 s). Typecheck: `npm run typecheck`.

### Configuration (`.env` in the repo root, all optional)

| Variable | Meaning |
|---|---|
| `PORT`, `HOST`, `PUBLIC_URL` | Listen address (default `0.0.0.0:8787`) and the public origin used in links, OAuth metadata and the `claude mcp add` command |
| `DATA_DIR` | SQLite database, artifacts and generated secrets (default `./data`, relative to the repo root) |
| `ANTHROPIC_API_KEY` | Enables the agents (design, test author, RETRO, photo check). Without it, everything except the agents works and the chat says Claude is not connected |
| `VIBREAD_MODEL`, `VIBREAD_FAST_MODEL` | Default `claude-opus-5-5`, `claude-sonnet-5` |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google sign-in; without them the server runs in single-operator mode (no sign-in) |
| `BETTER_AUTH_SECRET`, `VIBREAD_APPROVAL_SECRET` | Generated and stored in `DATA_DIR` when unset |
| `CAPCOM_PROVIDER` | `off` (default), `terminal` (local test chat), or `cloud` (iMessage) with `PHOTON_PROJECT_ID`, `PHOTON_PROJECT_SECRET`, `CAPCOM_NUMBER`; `CAPCOM_ALLOW_OFF_HOURS=1` disables the quiet-hours guard |
| `VIBREAD_ARDUINO_CLI`, `VIBREAD_ARDUINO_CONFIG`, `VIBREAD_COMPILE_TIMEOUT_MS` | Override the toolchain location / compile timeout |
| `VIBREAD_NO_STATIC=1` | Don't serve `apps/web/dist` |

## Using it

1. **Home** — describe the circuit and tap the parts you own. Pick a permission mode.
2. **Mission workspace** — chat with the agent; tool cards show each check; approval cards ask before a design becomes
   the build target (Review) or before every change (Ask). Tabs: Schematic, Steps, Code, Tests, Try it, Replay,
   Telemetry, Photo. The console bar shows EECOM · GUIDO · FIDO · FAO · RETRO.
3. **Build Mode on the phone** — scan the QR code in the Steps tab (`/b/<mission>`): one step at a time, focused picture,
   exact holes, plug state, "I did this", "Check with camera".
4. **Bench** (`/m/<mission>/bench`, Chrome/Edge) — connect the board, flash safe firmware, rail checkpoint, self-test with
   on-screen prompts, diagnosis with the suspect holes highlighted, then flash the app firmware with the light-sensor
   calibration. "Try without a board" runs the same firmware in a simulated board, with injectable wiring faults.
   Fallback flashing: `arduino-cli upload --input-file <hex> -p <port> -b arduino:avr:uno` with the HEX from the revision.

### Claude Code (MCP) and other agents (A2A)

Settings → **Connect Claude Code** mints a short-lived token and shows the command, e.g.

```bash
claude mcp add --transport http vibread https://<public-host>/mcp --header "Authorization: Bearer vb_…"
```

Scopes: `circuits:read`, `circuits:write`, `bench:request`. Without a header, Claude Code can also use OAuth 2.1 (Better
Auth authorization server with protected-resource metadata, PKCE and client ID metadata documents). Tools include every
ViBread tool (checks, compile, simulation, layout, diagnosis…) plus `vibread_list_missions`, `vibread_create_mission`,
`vibread_say`, `vibread_status`, `vibread_continue_task`. An A2A agent card is served at
`/.well-known/agent-card.json` (endpoint `/a2a`, bearer auth).

### iMessage (Photon Spectrum)

Settings → **Link iMessage** shows a one-time code; text it to your CAPCOM number. Then text a brief, `status`, answers
to the agent, and GO / NO-GO to approval polls (text fallback for devices without iOS 26 polls).

## Supported circuits

Arduino Uno R3 or Nano (ATmega328P, 5 V, USB power), one breadboard (30 or 63 rows), ≤ 12 parts, ≤ 10 signal nets. Module
library: LED, resistor, push button, photoresistor, potentiometer, active and passive buzzer; other parts can be added as
generic digital/analog modules (simulated with basic logic only, always labeled unverified). The simulator runs the exact
binary that gets flashed at instruction level with protocol-level part models: it validates logic, timing and pin
configuration, not current, noise, brown-out or contact quality — the physical self-test covers those.

## Repository layout

```
apps/server        Express 5: auth (Better Auth), REST, chat stream, MCP /mcp, A2A /a2a, CAPCOM, mission machine (XState), approvals
apps/web           React 19 + Vite + Material UI: workspace (MUI X Chat), Build Mode, bench (Web Serial), Try it, settings
packages/core      Contracts: circuit IR (vibread.circuit/0.1), boards, breadboards, modules, scenarios, telemetry, results, services
packages/tools     Tool registry + pipeline (every console for a revision) + AI SDK / MCP adapters + policy gate
packages/checks    EECOM + GUIDO rules and the ngspice cross-check
packages/firmware  arduino-cli service, bench self-test firmware template (Eta + ArduinoJson), calibration injection
packages/sim       avr8js ATmega328P simulator, device models, scenario runner, coverage (Node workers + browser)
packages/assembly  Breadboard allocator, LVS, steps, SVG/PNG rendering; schematic via an isolated tscircuit runtime
packages/bench     Self-test plan, NDJSON decoding, telemetry evaluation, diagnosis rules, fault catalog + fault dictionary
fixtures           Golden designs with test suites and pre-built HEX
scripts            Toolchain setup, golden seeding
```

## Libraries and licenses

ViBread's own code is MIT (see [LICENSE](LICENSE)). Main dependencies: Vercel AI SDK (`ai`, `@ai-sdk/anthropic`,
Apache-2.0), Material UI + MUI X Chat/Charts/Data Grid Community (MIT), Better Auth and its MCP/OAuth plugins (MIT),
Model Context Protocol SDK (MIT), A2A JS SDK (Apache-2.0), Photon `spectrum-ts` (MIT), Express (MIT), XState (MIT),
Drizzle ORM (Apache-2.0), better-sqlite3 (MIT), tscircuit core / circuit-json / circuit-to-svg (MIT/ISC, isolated in
`packages/assembly/schematic-runtime`), json-rules-engine (ISC), avr8js (MIT), webserial-flasher (MIT), Eta (MIT),
ArduinoJson (MIT, compiled into the bench firmware), yaml (ISC), zod (MIT), sharp (Apache-2.0).

Notices: `@resvg/resvg-js` is MPL-2.0 (used unmodified as a library). `heif2jpeg` is MIT but statically bundles libheif and
libde265 (LGPL-3.0); their sources are available from their upstream projects. arduino-cli (GPL-3.0) and ngspice
(BSD-3-Clause) are external tools invoked as separate programs and not redistributed in this repository; the Arduino AVR
core (LGPL) is installed by `setup:toolchain` and linked into sketches as Arduino libraries normally are.

## Data and privacy

Missions, designs, chat history and bench telemetry are stored in SQLite under `DATA_DIR`. Agent calls send the brief,
the design and (for the photo check) the uploaded photo to Anthropic's API; see Anthropic's commercial data-retention
terms. Photos are resized server-side and stored with the mission. Nothing is sent anywhere else, except iMessage traffic
through Photon when CAPCOM is enabled.

## How this was built

Everything in this repository was written during the event (Sep 25–27, 2026). Planning, research and code were produced
with AI coding agents under the team's direction: Claude Opus 5.5 (planning, integration, review, and the agent,
server-core and web-workspace slices) and GPT-5.6 Luna (research and the remaining package slices), orchestrated with
oh-my-pi. Libraries are used through their public APIs; no code was copied from other projects.
