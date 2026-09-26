# ViBread — Mission Control for your breadboard

ViBread helps non-technical makers go from "a lamp that turns on when it's dark" to a working Arduino breadboard. You
describe what the circuit should do; ViBread's agent designs it (parts from your kit, netlist, Arduino sketch), a
**Go/No-Go poll** of independent checkers verifies it, LEGO-style numbered steps show how to build it on laptop and
phone, and a **self-test over USB** checks the real build and says *where* it is wrong ("Houston, we have a problem: D2
reads LOW even with the button released — its leg shares row 17 with the GND jumper").

**New here? Read [HOW-IT-WORKS.md](HOW-IT-WORKS.md)** — what the app does, step by step, in plain words.

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

## Install

### Option A — Desktop app (recommended)

Download, double-click, done: no Node.js, npm or terminal, and no browser choice (the app has Chromium built in, so the
USB bench works the same on every OS). How it works inside: [HOW-IT-WORKS.md](HOW-IT-WORKS.md).

| OS | Download ([release desktop-v0.1.0](https://github.com/BarryTheShen/ViBread/releases/tag/desktop-v0.1.0)) | First launch if unsigned-app warnings appear |
|---|---|---|
| Linux x64 | [`ViBread-0.1.0-linux-x86_64.AppImage`](https://github.com/BarryTheShen/ViBread/releases/download/desktop-v0.1.0/ViBread-0.1.0-linux-x86_64.AppImage) or [`.deb`](https://github.com/BarryTheShen/ViBread/releases/download/desktop-v0.1.0/ViBread-0.1.0-linux-amd64.deb) | AppImage: `chmod +x ViBread-*.AppImage` then run it (needs FUSE — present on desktop distros; else `sudo apt install libfuse2` or run with `APPIMAGE_EXTRACT_AND_RUN=1`). Deb: `sudo apt install ./ViBread-*.deb`, then *ViBread* in the app menu |
| Windows 10/11 x64 | [`ViBread-0.1.0-win-x64.exe`](https://github.com/BarryTheShen/ViBread/releases/download/desktop-v0.1.0/ViBread-0.1.0-win-x64.exe) (installer) | SmartScreen: **More info → Run anyway** |
| macOS (Apple silicon / Intel) | [`ViBread-0.1.0-mac-arm64.dmg`](https://github.com/BarryTheShen/ViBread/releases/download/desktop-v0.1.0/ViBread-0.1.0-mac-arm64.dmg) / [`-mac-x64.dmg`](https://github.com/BarryTheShen/ViBread/releases/download/desktop-v0.1.0/ViBread-0.1.0-mac-x64.dmg) | Drag to Applications, open once, then **System Settings → Privacy & Security → Open Anyway** (or `xattr -dr com.apple.quarantine /Applications/ViBread.app`) |

- **First launch** shows a setup window: it downloads the Arduino toolchain (arduino-cli 1.5.1 + AVR core 1.8.8 +
  ArduinoJson 7.4.2, SHA-256 checked, ~150 MB) and builds the example missions — about 2–3 minutes, internet needed
  once. Later launches start in ~10 s. The download is ~160–200 MB; installed size ~600 MB plus the toolchain.
- **USB on Linux:** add yourself to the serial group once and log out/in: `sudo usermod -aG dialout $USER` (Arch:
  `uucp`). Then the bench's *Choose filtered USB port* picks the Arduino automatically (or asks when several are plugged in).
- **Phones:** menu **ViBread → Show phone link / QR** (same Wi-Fi). Allow ViBread through the firewall when your OS
  asks (Windows/macOS prompt on first phone connection; private networks only).
- **AI agents:** menu **ViBread → Set Anthropic API key…** (stored encrypted in the system keychain), or connect a
  Claude account in Settings.
- **Your data** lives in `~/.config/ViBread` (Linux), `%APPDATA%\ViBread` (Windows), `~/Library/Application Support/ViBread`
  (macOS): `data/` (missions), `toolchain/`, `logs/server.log`, `logs/setup.log`. Menu: *Open data folder*, *Open logs*,
  *Reset example missions*.
- **SPICE cross-check** needs [ngspice](https://ngspice.sourceforge.io/) installed (`sudo apt install ngspice` /
  `brew install ngspice` / Windows: add `ngspice.exe` to `PATH`); without it EECOM reports SPICE as unavailable.

### Option B — From source (developers)

Tested from a clean clone of this repository (install → toolchain → build → seed → 99 tests → app) on Linux x86_64.

### 1. What you need

| | Version | Check with | Notes |
|---|---|---|---|
| OS | macOS (Intel or Apple silicon), Linux x86_64/arm64, or Windows 10/11 x64 | — | The Arduino compiler is downloaded for your platform |
| Node.js | **22.12 or newer** | `node -v` | https://nodejs.org or `nvm install 22` |
| npm | **10 or newer** | `npm -v` | Upgrade with `npm install -g npm@11` |
| git, tar | any | — | Preinstalled on macOS/Linux and Windows 10+ |
| Browser | Chrome or Edge | — | Needed for the bench (Web Serial talks to the Arduino). Other screens work in any modern browser |
| Disk / network | ~1.5 GB, internet for the first install | — | node_modules + Arduino toolchain |

Optional: **ngspice** for the SPICE cross-check (`brew install ngspice` / `sudo apt install ngspice`), the **oh-my-pi**
`omp` CLI on the server for "Connect your Claude account", **Claude Code** to drive ViBread over MCP.

### 2. Install and run

```bash
git clone https://github.com/BarryTheShen/ViBread.git
cd ViBread
npm install               # ~1 min; also installs the isolated schematic renderer (packages/assembly/schematic-runtime)
npm run setup:toolchain   # ~1 min; arduino-cli 1.5.1 (SHA-256 pinned) + Arduino AVR core 1.8.8 + ArduinoJson 7.4.2 → .toolchain/ (any OS)
npm run build             # builds the web app into apps/web/dist (the server serves it)
npm run seed              # optional: three ready-made demo missions (Moon-Phase Lamp, Knob Night-Light, Launch Control)
cp .env.example .env      # optional: add ANTHROPIC_API_KEY etc. (see Configuration)
npm start                 # → http://localhost:8787
```

Open **http://localhost:8787**. Without a Claude credential everything works except the AI agents (the chat says Claude
isn't connected): add `ANTHROPIC_API_KEY` to `.env`, or use Settings → *Connect your Claude account*.

Check the install: `npm test` (~30 s; compiles firmware, runs the simulator, the checks and the server tests) and
`npm run typecheck`.

### 3. Other devices and the bench

- **Phone (Build Mode):** the server finds the first non-internal Wi-Fi IPv4 address when `PUBLIC_URL` is left unset; scan the QR
  code in the workspace's Steps tab. Set `VIBREAD_PHONE_URL=http://<laptop-ip>:8787` if automatic discovery is not right.
- **Bench (Arduino over USB):** open the bench on the laptop the board is plugged into, at `http://localhost:8787` (Web
  Serial needs localhost or HTTPS). On a remote server, forward the port: `ssh -L 8787:<server>:8787 <host>`.
- **Development mode** (hot reload): `npm run dev:server` (port 8787) and `npm run dev:web` (http://localhost:5173, proxies
  the API to 8787).

### 4. Troubleshooting

| Problem | Fix |
|---|---|
| `npm install` complains about the engine or lockfile | Upgrade Node to 22.12+ and npm to 10+ |
| Port 8787 is busy | `PORT=8788 npm start` |
| "Claude is not connected" in the chat | Expected without a credential — set `ANTHROPIC_API_KEY` or connect a Claude account in Settings |
| Schematic tab says the drawing isn't ready | Re-run `npm install` (it installs `packages/assembly/schematic-runtime`) |
| Compile errors mentioning `arduino-cli` / missing core | Re-run `npm run setup:toolchain` |
| Bench can't see the board | Use Chrome/Edge on `localhost`; try another USB cable (charge-only cables have no data); close the Arduino IDE serial monitor; on Linux add yourself to the `dialout` group |
| Flashing from the browser fails | Use the fallback shown on the bench page: `.toolchain/bin/arduino-cli upload --input-file <hex> -p <port> -b arduino:avr:uno` |
| Start over with fresh demo data | Stop the server, `rm -rf data`, `npm run seed`, `npm start` |

### Configuration (`.env` in the repo root, all optional)

| Variable | Meaning |
|---|---|
| `PORT`, `HOST`, `PUBLIC_URL` | Listen address (default `0.0.0.0:8787`) and the public origin used in links, QR codes, OAuth metadata and the `claude mcp add` command |
| `VIBREAD_PHONE_URL` | Phone/QR origin override; when unset, an HTTP localhost `PUBLIC_URL` uses the first non-internal LAN IPv4 address |
| `DATA_DIR` | SQLite database, artifacts and generated secrets (default `./data`, relative to the repo root) |
| `ANTHROPIC_API_KEY` | ViBread's server key for the agents (design, test author, RETRO, photo check). Users can instead connect their own Claude account (below). Without either, everything except the agents works and the chat says Claude is not connected |
| `VIBREAD_MODEL`, `VIBREAD_FAST_MODEL` | Default `claude-opus-5-5`, `claude-sonnet-5` |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google sign-in (callback `${PUBLIC_URL}/api/auth/callback/google`) |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | GitHub sign-in (callback `${PUBLIC_URL}/api/auth/callback/github`). With Google or GitHub configured, single-operator mode (no sign-in) is turned off |
| `BETTER_AUTH_SECRET`, `VIBREAD_APPROVAL_SECRET` | Generated and stored in `DATA_DIR` when unset |
| `CAPCOM_PROVIDER` | `off` (default), `terminal` (local test chat), or `cloud` (iMessage) with `PHOTON_PROJECT_ID`, `PHOTON_PROJECT_SECRET`, `CAPCOM_NUMBER`; `CAPCOM_ALLOW_OFF_HOURS=1` disables the quiet-hours guard |
| `VIBREAD_ARDUINO_CLI`, `VIBREAD_ARDUINO_CONFIG`, `VIBREAD_COMPILE_TIMEOUT_MS` | Override the toolchain location / compile timeout |
| `VIBREAD_NO_STATIC=1` | Don't serve `apps/web/dist` |
| `VIBREAD_OMP_BIN` | oh-my-pi CLI used for "Connect your Claude account" (default `omp` on `PATH`); ViBread starts its auth broker on a private random loopback port |

## Using it

1. **Home** — describe the circuit and tap the parts you own. Pick a permission mode.
2. **Mission workspace** — chat with the agent; tool cards show each check; approval cards ask before a design becomes
   the build target (Review) or before every change (Ask). Tabs: Schematic, Steps, Code, Tests, Try it, Replay,
   Telemetry, Photo. The console bar shows EECOM · GUIDO · FIDO · FAO · RETRO, and **GO for build** (you are the Flight
   Director) releases the design as the build target once the checks are GO.
3. **Build Mode on the phone** — scan the QR code in the Steps tab (`/b/<mission>`): one step at a time, focused picture,
   exact holes, plug state, "I did this", "Check with camera".
4. **Bench** (`/m/<mission>/bench`, Chrome/Edge) — connect the board, flash safe firmware, rail checkpoint, self-test with
   on-screen prompts, diagnosis with the suspect holes highlighted, then flash the app firmware with the light-sensor
   calibration. "Try without a board" runs the same firmware in a simulated board, with injectable wiring faults.
   Fallback flashing: `arduino-cli upload --input-file <hex> -p <port> -b arduino:avr:uno` with the HEX from the revision.

### Connect your Claude account

Settings → **Connect your Claude account** lets your own Claude account power your missions instead of ViBread's key. It
runs oh-my-pi's Claude sign-in (`omp login anthropic`, needs the `omp` CLI on the server): open the claude.ai link, approve,
then paste the code Claude shows — or the address of the page that fails to load (`localhost:54545/…`) — into ViBread. If
your browser runs on the server machine, the sign-in finishes by itself. The grant is kept by an oh-my-pi auth broker under
`DATA_DIR/claude-accounts` (never your own `~/.omp`), and your agent calls go through an oh-my-pi auth gateway restricted to
your account. Disconnect removes it. When your account can't serve the model, ViBread falls back to its server key. Note:
Anthropic's terms restrict using Claude.ai login in third-party apps — see PLAN.md §9.

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
Apache-2.0), Material UI + MUI X Chat (MIT), Better Auth and its MCP/OAuth plugins (MIT),
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
