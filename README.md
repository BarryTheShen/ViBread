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

Derived results (layout, build steps and their pictures, schematic, check reports) carry the version of the code that made
them. When an update changes that code, the server re-derives existing missions' current and released revisions in the
background after it starts (the old results stay on screen until the new ones are saved). The design, tests and chat are
never touched; a build in progress keeps its placement and wire colours, gets new steps drawn from that placement, and
continues where it was (timeline note). The version is a fingerprint of golden outputs, so most pipeline changes are
picked up without a manual bump; raise `DERIVATION_VERSION` in `packages/tools/src/pipeline.ts` for changes it can't see.

### Export and import a project

Use the mission’s ⋯ menu or the panel download menu to choose **Project file (.vibread)**. The single portable file keeps the mission brief, every design revision, chat history, build progress, wire-colour choices, inventory and hardware snapshot, plus any photos you attached or checked. Derived drawings, pictures and firmware are intentionally left out; when the file is opened on another ViBread server, the current design is checked again and older revisions are checked in the background.

Choose **Import project** below **New mission** in the sidebar and select the `.vibread` file (you can also drop it anywhere in the window). Import creates a new mission owned by the signed-in user; it never transfers credentials, tokens, pairing links or account identifiers. The import screen stays busy while the current revision is checked, then opens the new mission.


The same mission is reachable from **iMessage** ("CAPCOM", via Photon Spectrum) and from **Claude Code** over MCP. There
are no design permission modes: Claude can edit the design directly. **GO for build** is human-only (the web button or an
iMessage `GO`). Physical actions (flash, self-test, rewiring) still wait for a click at the bench; remote agents can only
request them.

## Install

### Option A — Desktop app (recommended)

Download, double-click, done: no Node.js, npm or terminal, and no browser choice (the app has Chromium built in, so the
USB bench works the same on every OS). How it works inside: [HOW-IT-WORKS.md](HOW-IT-WORKS.md).

Every successful build of `main` is published as a new, numbered release (**ViBread desktop 0.1.N**); download the
newest from **[Releases → Latest](https://github.com/BarryTheShen/ViBread/releases/latest)**. Pushes build Linux and
Windows; the macOS apps are built on request (Actions → *Desktop app* → *Run workflow* → tick *macOS*), and every
release's notes link the newest macOS build.

| OS | File in the latest release | First launch if unsigned-app warnings appear |
|---|---|---|
| Linux x64 | `ViBread-<version>-linux-amd64.deb` (recommended on Ubuntu/Debian, required for the full sandbox on Ubuntu 24.04+) or `ViBread-<version>-linux-x86_64.AppImage` (any distro) | Deb: `sudo apt install ./ViBread-*.deb`, then *ViBread* in the app menu. AppImage: `chmod +x ViBread-*.AppImage` then run it (needs FUSE's `fusermount3`, present on desktop distros; without FUSE run it with `APPIMAGE_EXTRACT_AND_RUN=1`) |
| Windows 10/11 x64 | `ViBread-<version>-win-x64.exe` (installer) | SmartScreen: **More info → Run anyway** |
| macOS (Apple silicon / Intel) | `ViBread-<version>-mac-arm64.dmg` / `ViBread-<version>-mac-x64.dmg` (in the newest release that has them — see the release notes) | Drag to Applications, open once, then **System Settings → Privacy & Security → Open Anyway** (or `xattr -dr com.apple.quarantine /Applications/ViBread.app`) |

- **First launch** shows a setup window: it downloads the Arduino toolchain (arduino-cli 1.5.1 + AVR core 1.8.8 +
  ArduinoJson 7.4.2, SHA-256 checked, ~150 MB) and builds the example missions — about 2–3 minutes, internet needed
  once. Later launches start in ~10 s. The download is ~160–200 MB; installed size ~600 MB plus the toolchain.
- **Chromium sandbox on Linux:** Ubuntu 23.10+ blocks unprivileged user namespaces (AppArmor), which Electron's
  sandbox normally uses. The `.deb` installs the setuid `chrome-sandbox` helper, so the sandbox keeps working there. The
  AppImage can't ship a setuid helper: its launcher tests `unshare -Ur true` and, when namespaces are blocked, starts
  with `--no-sandbox` by itself, so it opens instead of failing with "No usable sandbox" (the window only ever loads
  ViBread's own local server). For the full Chromium sandbox on Ubuntu 24.04+, use the `.deb`.
- **USB on Linux:** add yourself to the serial group once and log out/in: `sudo usermod -aG dialout $USER` (Arch:
  `uucp`). Then the bench's *Choose filtered USB port* picks the Arduino automatically (or asks when several are plugged in).
- **Phones:** menu **ViBread → Show phone link / QR** (same Wi-Fi). Phones pair by scanning the QR code; other devices
  on the Wi-Fi can't open your ViBread. Allow ViBread through the firewall when your OS asks (Windows/macOS prompt on
  first phone connection; private networks only).
- **AI agents:** the primary route is **Settings → Connect your Claude account**: ViBread runs pi-ai's Anthropic OAuth in
  the server. Paste the code Claude shows, `code#state`, or the whole `localhost:53692/callback…` address; this also works
  when the browser is on another computer. The other route is **Settings → Claude → Use an API key instead**. ViBread
  checks that key with Anthropic before saving it, and stores either credential per user in the server database. No helper
  program or `HOME`/`USERPROFILE` credential file is used. In the desktop menu, **ViBread → Set Anthropic API key…** sets
  the server's fallback key in the OS credential store.
- **Your data** lives in `~/.config/ViBread` (Linux), `%APPDATA%\ViBread` (Windows), `~/Library/Application Support/ViBread`
  (macOS): `data/` (missions), `toolchain/`, `logs/server.log`, `logs/setup.log`. Menu: *Open data folder*, *Open logs*,
  *Reset example missions*.
- **SPICE cross-check** needs [ngspice](https://ngspice.sourceforge.io/) installed (`sudo apt install ngspice` /
  `brew install ngspice` / Windows: add `ngspice.exe` to `PATH`); without it EECOM reports SPICE as unavailable.

### Option B — From source (developers)

Tested from a clean clone of this repository (install → toolchain → build → seed → `npm test` → app) on Linux x86_64.

### 1. What you need

| | Version | Check with | Notes |
|---|---|---|---|
| OS | macOS (Intel or Apple silicon), Linux x86_64/arm64, or Windows 10/11 x64 | — | The Arduino compiler is downloaded for your platform |
| Node.js | **22.12 or newer** | `node -v` | https://nodejs.org or `nvm install 22` |
| npm | **10 or newer** | `npm -v` | Upgrade with `npm install -g npm@11` |
| git, tar | any | — | Preinstalled on macOS/Linux and Windows 10+ |
| Browser | Chrome or Edge | — | Needed for the bench (Web Serial talks to the Arduino). Other screens work in any modern browser |
| Disk / network | ~1.5 GB, internet for the first install | — | node_modules + Arduino toolchain |

Optional: **ngspice** for the SPICE cross-check (`brew install ngspice` / `sudo apt install ngspice`), **Claude Code** to
drive ViBread over MCP.

### 2. Install and run

```bash
git clone https://github.com/BarryTheShen/ViBread.git
cd ViBread
npm install               # runs postinstall for the isolated schematic runtime (packages/assembly/schematic-runtime);
                         # rerun after git pull so new runtime dependencies such as elkjs are installed
npm run setup:toolchain   # ~1 min; arduino-cli 1.5.1 (SHA-256 pinned) + Arduino AVR core 1.8.8 + ArduinoJson 7.4.2 → .toolchain/ (any OS)
npm run build             # builds the web app into apps/web/dist (the server serves it)
npm run seed              # optional: the example missions (Moon-Phase Lamp, Knob Night-Light, Launch Control) plus one recorded real Claude run
cp .env.example .env      # optional: add ANTHROPIC_API_KEY etc. (see Configuration)
npm start                 # → http://localhost:8787
```

Open **http://localhost:8787**. Without a Claude credential, everything works except live Claude calls (the chat says Claude
isn't connected): set the server fallback `ANTHROPIC_API_KEY`, or use Settings → **Claude** to connect your account or save
your own Anthropic API key.

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
| "Claude is not connected" in the chat | Expected without a credential — set the server fallback `ANTHROPIC_API_KEY`, or connect an account or API key in Settings → **Claude** |
| Schematic tab says the drawing isn't ready | Re-run `npm install` (its postinstall installs `packages/assembly/schematic-runtime`, including elkjs) |
| Compile errors mentioning `arduino-cli` / missing core | Re-run `npm run setup:toolchain` |
| Bench can't see the board | Use Chrome/Edge on `localhost`; try another USB cable (charge-only cables have no data); close the Arduino IDE serial monitor; on Linux add yourself to the `dialout` group |
| Flashing from the browser fails | Copy the command the bench page shows under *Laptop fallback* (it has the right paths and board), e.g. `.toolchain/bin/arduino-cli --config-file .toolchain/arduino/arduino-cli.yaml upload --fqbn arduino:avr:uno --port <port> --input-file <hex>` |
| Start over with fresh demo data | Stop the server, `rm -rf data`, `npm run seed`, `npm start` |

## Inventory, interface, and diagnostics

- **Inventory:** type a list of parts or scan from the laptop camera, a phone, or an upload. The typed parser handles
  parentheses, `N each`, `A & B`, and units. Scans have explicit upload and analysis failure states with **Retry**, and
  Settings lets you edit part types.
- **Chat:** the mission chat uses assistant-ui with MUI styling. Tool calls fold into grouped rows, Claude's questions are
  answerable cards, and the chat supports stop/resume.
- **Theme:** the light and dark palettes follow the system setting and use space cadet, cool gray, anti-flash white, and
  red tokens.
- **Debug logs:** the server writes redacted JSONL to `data/logs/server.jsonl` and `data/logs/missions/<missionId>.jsonl`.
  Settings → **Diagnostics** shows the server or a selected mission log with area/level filters; browser errors are sent to
  the server. Follow a log from the repository root with `node scripts/debug-log.mjs [missionId] --follow`.

### Configuration (`.env` in the repo root, all optional)

| Variable | Meaning |
|---|---|
| `PORT`, `HOST`, `PUBLIC_URL` | Listen address (default `0.0.0.0:8787`) and the public origin used in links, QR codes, OAuth metadata and the `claude mcp add` command |
| `VIBREAD_PHONE_URL` | Phone/QR origin override; when unset, an HTTP localhost `PUBLIC_URL` uses the first non-internal LAN IPv4 address |
| `VIBREAD_LAN_PAIRING=off` | Disable the single-operator LAN pairing guard (only on a trusted network) |
| Tunnels (cloudflared/ngrok) | Treated as remote devices; `ssh -R`-style raw forwarding looks like the laptop itself, so use multi-user sign-in for any public tunnel |
| `DATA_DIR` | SQLite database, artifacts and generated secrets (default `./data`, relative to the repo root) |
| `ANTHROPIC_API_KEY` | Optional server fallback key for design, test author, RETRO, photo check, and scan calls. A user can instead connect a Claude account or save an API key in Settings → Claude. Without both a user credential and this fallback, live Claude calls are unavailable |
| `ANTHROPIC_BASE_URL` | Anthropic API origin for every Claude call (a proxy or local bridge; default `https://api.anthropic.com`) |
| `VIBREAD_MODEL`, `VIBREAD_FAST_MODEL` | Default `claude-opus-5-5`, `claude-sonnet-5` |
| `VIBREAD_CLAUDE_PROTOCOL` | `managed` (default: pi-ai's per-model request protocol — for claude-opus-5-5 adaptive thinking, mid-conversation system messages and their beta headers) or `plain`. If Claude answers 400 to a managed feature, ViBread retries that request plain and stays plain for that model (logged in Diagnostics) |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google sign-in (callback `${PUBLIC_URL}/api/auth/callback/google`) |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | GitHub sign-in (callback `${PUBLIC_URL}/api/auth/callback/github`). With Google or GitHub configured, single-operator mode (no sign-in) is turned off |
| `BETTER_AUTH_SECRET`, `VIBREAD_APPROVAL_SECRET` | Generated and stored in `DATA_DIR` when unset |
| `CAPCOM_PROVIDER` | `off` (default), `terminal` (local test chat), or `cloud` (iMessage) with `PHOTON_PROJECT_ID`, `PHOTON_PROJECT_SECRET`, `CAPCOM_NUMBER`. On the ViBread computer, Settings → iMessage can save the Photon project instead (it starts CAPCOM at once; the secret is never sent back to the browser) |
| `VIBREAD_ARDUINO_CLI`, `VIBREAD_ARDUINO_CONFIG`, `VIBREAD_COMPILE_TIMEOUT_MS` | Override the toolchain location / compile timeout |
| `VIBREAD_NO_STATIC=1` | Don't serve `apps/web/dist` |

## Using it

1. **Home** — describe the circuit and tap the parts you own.
2. **Mission workspace** — Claude edits the design directly; grouped tool rows show its work, and question cards let you
   answer clarifications. Stop/resume is available while a run is active. The side panel's **Show** menu lists its views
   by stage, in build order: **1 Design** (Parts, Schematic, Code) · **2 Simulate** (Try it, Tests with each scenario's
   replay, Checks) · **3 Build** (Build steps, Bench, Photo checks) · **4 Debug** (Bench results: the latest diagnosis
   and everything the board reported). The view and design version are kept in the address (`?panel=…&rev=…`). The status
   dots show EECOM · GUIDO · FIDO · FAO · RETRO. **GO for build** (you are the Flight Director) is a human action from the
   web button or iMessage `GO`.
3. **Build Mode on the phone** — scan the QR code in Build steps (`/b/<mission>`): one step at a time, focused picture,
   exact holes, plug state, "I did this", "Check with camera". After the inventory and the board-orientation steps comes
   a bare-board check: plug in just the Arduino, connect, flash the safe firmware and check its power before anything
   goes on the breadboard.
4. **Bench** (the panel's Bench view, `/m/<mission>?panel=bench`; Chrome/Edge) — connect the board, flash safe
   firmware, power checkpoint, self-test with on-screen prompts, diagnosis with the suspect holes highlighted, then flash
   the app firmware with the light-sensor calibration. A build step's checkpoint opens it scoped to that step's tests;
   the old `/m/<mission>/bench` address redirects here. "Try without a board" runs the same firmware in a simulated board,
   with injectable wiring faults. Physical actions always wait for the click in this view.

### Connect your Claude account

Settings → **Connect your Claude account** is the primary way to let your own Claude account power missions instead of
ViBread's key. ViBread runs the Claude sign-in itself (pi-ai's Anthropic OAuth, no helper program): open the claude.ai
link, approve, then paste the code Claude shows, `code#state`, or the address of the page that fails to load
(`localhost:53692/callback?code=…`) into ViBread; that works when your browser is on a different machine than the
server. If your browser runs on the server machine, the sign-in finishes by itself (unless another program holds port
53692 — then paste as well; the server log says so). You can connect an Anthropic API key
instead (`POST /api/connections/claude/key`). The credential is stored in ViBread's database for your user only (pi-ai
refreshes the sign-in when it expires); Disconnect removes it. When your credential can't be used, ViBread falls back to
its server key. Note: Anthropic's terms restrict using Claude.ai login in third-party apps — see PLAN.md §9.

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

Settings → **iMessage (CAPCOM)** shows a one-time code; text it to your CAPCOM number (with `CAPCOM_PROVIDER=terminal`, type it
in the server's terminal chat). Once linked, CAPCOM texts you about **all** your missions, wherever they were started:
Claude's questions (text + a poll of its choices; pick one or reply with your own answer — the first answer, laptop or phone,
wins), design ready / NO-GO / a ViBread limit / a failed run, bench self-test results and fault alerts. The mission a text is
about becomes the one your replies go to (`mission` lists and switches). You can also text a brief, `status`, `GO` to start
building, and GO / NO-GO to bench approval polls. Settings has a test message, a switch per kind of notification, and opt-in
quiet hours in your own time zone: notifications are held, never dropped, and arrive as one digest when they end; replies to
your texts always go through.

## Supported circuits

Arduino Uno R3 or Nano (ATmega328P, 5 V, USB power), one breadboard (30 or 63 rows), ≤ 20 parts, ≤ 20 signal nets. Module
library: LED, resistor, push button, photoresistor, potentiometer, active and passive buzzer; other parts can be added as
generic digital/analog modules (simulated with basic logic only, always labeled unverified). The simulator runs the exact
binary that gets flashed at instruction level with protocol-level part models: it validates logic, timing and pin
configuration, not current, noise, brown-out or contact quality — the physical self-test covers those.

## Repository layout

```
apps/server        Express 5: auth, REST, UI-message chat stream, MCP /mcp, A2A /a2a, CAPCOM, mission machine, bench-request broker
apps/web           React 19 + Vite + Material UI + assistant-ui: workspace, Build Mode, bench (Web Serial), Try it, settings
packages/core      Contracts: circuit IR (vibread.circuit/0.1), boards, breadboards, modules, scenarios, telemetry, results, services
packages/tools     Tool registry + pi AgentTool/MCP adapters + physical bench-request gate
packages/checks    EECOM + GUIDO rules and the ngspice cross-check
packages/firmware  arduino-cli service, bench self-test firmware template (Eta + ArduinoJson), calibration injection
packages/sim       avr8js ATmega328P simulator, device models, scenario runner, coverage (Node workers + browser)
packages/assembly  Breadboard allocator, LVS, steps, SVG/PNG rendering; schematic via elkjs layout + a geometry check (isolated runtime)
packages/bench     Self-test plan, NDJSON decoding, telemetry evaluation, diagnosis rules, fault catalog + fault dictionary
fixtures           Golden designs with test suites and pre-built HEX
scripts            Toolchain setup, golden seeding, debug-log CLI
```

## Libraries and licenses

ViBread's own code is MIT (see [LICENSE](LICENSE)). Main dependencies: pi-agent-core + pi-ai (MIT; in-process Claude
agents and structured calls), AI SDK (`ai`, `@ai-sdk/react`, Apache-2.0; the web UI-message stream format), assistant-ui
(MIT; chat rendering), Material UI (MIT), Better Auth and its MCP/OAuth plugins (MIT), Model Context Protocol SDK (MIT),
A2A JS SDK (Apache-2.0), Photon `spectrum-ts` (MIT), Express (MIT), XState (MIT), Drizzle ORM (Apache-2.0),
better-sqlite3 (MIT), elkjs (EPL-2.0, schematic layout; isolated in `packages/assembly/schematic-runtime`), json-rules-engine
(ISC), avr8js (MIT), webserial-flasher (MIT), Eta (MIT), ArduinoJson (MIT, compiled into the bench firmware), yaml (ISC),
zod (MIT), sharp (Apache-2.0).

Notices: `@resvg/resvg-js` is MPL-2.0 and `elkjs` is EPL-2.0 (both used unmodified as libraries; elkjs sources:
https://github.com/kieler/elkjs). `heif2jpeg` is MIT but statically bundles libheif and
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
server-core and web-workspace slices) and GPT-5.6 Luna (research and the remaining package slices). The runtime design
agent runs on pi inside the server; no external sign-in helper is needed. Tester GitHub issues #1–#14 drove an issue-by-issue QA
loop before the final docs pass. Libraries are used through their public APIs; no code was copied from other projects.
