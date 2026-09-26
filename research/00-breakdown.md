# ViBread — subsystem breakdown for research

Status: research input for PLAN.md. Written Fri Sep 25 2026, ~22:20 CT.

## 1. Project in one paragraph

ViBread is an AI-assisted Arduino circuit-prototyping system: the user describes circuit
behavior in plain language → an agent produces a schematic (netlist) + Arduino sketch →
a validation layer checks circuitry (ERC / electrical sim), compiles + tests the code, and
simulates the design → the design becomes "LEGO-like" step-by-step breadboard visuals
(desktop + phone) → the user assembles → the system verifies the physical build (MCU-run
self-tests for shorts/miswiring as the primary path; phone photo checked by Claude vision
as a secondary path) → a closed-loop debugger attributes faults to design vs code vs wiring
and proposes fixes. It must be reachable agent-to-agent (A2A + MCP) so a user's Claude Code
can connect, converse with ViBread's main agent (which may ask back for more information),
with Claude-Code-style permission modes (ask-every-time / review / bypass). Photon Spectrum
(iMessage agent SDK) is integrated for the Photon bonus track; the main track stays priority.

## 2. Hard constraints (from the event material)

| Constraint | Source |
|---|---|
| Submission hard deadline Sun Sep 27 12:00 PM (Devpost). Finalists announced Sun 3–4 PM, 5-min pitch+demo at 4:30 PM. | Hackathon deck p.7, p.32–33 |
| Must be new this weekend; teams ≤ 4. | Deck p.36 |
| Main-track prompt: "Fly Me to the Moon" (moon/space, exploration, dreams, cycles, light, distance…). | Deck p.24 |
| Rubric: Impact (addresses prompt?), Creativity (more impactful than existing solutions?), UX (intuitive for intended user? design supports theme?). | Deck p.34 |
| Photon track: must integrate Spectrum (`spectrum-ts`); judged on Vision, Craft, Depth, Traction; "real human-in-the-loop collaboration… context-awareness that persists across time, channels, and teammates". Promo code HACKWITHPHOTON. | Photon slides 3, 5 |
| User rule: do not copy any project online. Libraries/SDKs/CLIs/MCP servers as dependencies are fine; our app code is written this weekend. | User |

## 3. Facts already verified (Sep 25 2026)

- Claude API models: `claude-opus-5-5` (recommended default), `claude-sonnet-5`, `claude-haiku-4-5`, `claude-fable-5-1`. All support vision + tool use. (platform.claude.com/docs/en/models/overview)
- A2A spec v1.0.0 released; `@a2a-js/sdk` v1.0.x stable (JSON-RPC, HTTP+JSON/REST, gRPC; `AgentExecutor` + `DefaultRequestHandler`; `TASK_STATE_INPUT_REQUIRED` for ask-back). (github.com/a2aproject/a2a-js)
- MCP TS SDK v2 (split packages `@modelcontextprotocol/server` + framework adapters) implements spec 2026-07-28, where elicitation became multi-round-trip (`inputRequired`); v1 `@modelcontextprotocol/sdk` 1.30.x still maintained with push-style elicitation.
- Claude Code supports MCP elicitation (form + URL) since v2.1.76; Claude Code **Channels** (v2.1.80+, research preview): a stdio MCP server declaring `experimental['claude/channel']` can push `notifications/claude/channel` events into a running session, expose a reply tool (two-way), and opt into permission relay. Custom channels need `--dangerously-load-development-channels server:<name>`.
- Photon Spectrum: one agent loop over iMessage/WhatsApp/Telegram/terminal; inbound `attachment` content with `read()`; outbound attachments, polls, app cards (live, editable in place), iMessage screen effects, typing indicators, groups; terminal provider needs no credentials.
- Existing AI-circuit products in the space (differentiation targets, NOT to copy): Cirkit Designer, cirkit.ai, Schematik, Tinkered, CircuitAI, ProtoPulse, CircuitMuse.

## 4. Environment

Linux x64 container (16 cores, 123 GB RAM, RTX 5080), Node 22, Bun, Python 3.14, outbound
internet, passwordless sudo. Barry reaches dev servers through an SSH tunnel (so the USB
Arduino sits on his laptop → Web Serial in Chrome is the likely hardware path). Target board
assumption: Arduino Uno R3 / Nano (ATmega328P) — unconfirmed. No Anthropic API key in env yet.

## 5. Subsystem breakdown → research slices

| # | Slice | Subsystems covered (whiteboard terms) | Core questions |
|---|---|---|---|
| 01 | agent-interop | Agent → MCP; A2A; permission control | Agent harness (Claude Agent SDK vs Messages API loop vs frameworks); A2A v1.0 server/client; MCP v2 vs v1; Claude Code Channels + elicitation; existing A2A↔MCP bridges; HITL/permission-mode patterns across web/iMessage/Claude Code |
| 02 | circuit-ir-schematic | Design schematic; list of modules | Industry-standard circuit representations (KiCad, SPICE, circuit-json/tscircuit, atopile, SKiDL, Wokwi diagram.json, Fritzing fzp); best IR for LLM output; browser schematic rendering; component/module data + licenses; KiCad/tscircuit/parts/datasheet MCPs |
| 03 | erc-spice | QA system to check circuitry | ERC practice (KiCad pin matrix) + Arduino/breadboard design rules with numeric limits; SPICE engines headless (ngspice CLI/shared lib/WASM, Xyce…); device models; SPICE/ERC MCPs; accuracy limits |
| 04 | mcu-sim | Simulation (logic simulator); tests built in | Wokwi (CLI/CI/MCP, licensing), avr8js, simavr, SimulIDE, QEMU, Renode; mixed-signal co-simulation; scenario-based automated tests; simulation MCPs; fidelity statement |
| 05 | firmware-toolchain | Code verification | arduino-cli vs PlatformIO; Arduino MCP servers; static analysis; embedded unit/behavior test frameworks; code↔netlist cross-check; library management |
| 06 | physical-verify | Short-circuit check; physical hardware test; debug if wrong | Web Serial flashing (STK500), Firmata vs generated self-test firmware, MCU-only fault detectability, instrumented-breadboard + HCI debugging research, vision-based breadboard verification, serial/hardware MCPs |
| 07 | assembly-visuals | "LEGO" schematic; animation/picture/visual; personalized | Breadboard auto-placement/routing, assembly-instruction design research, rendering stack (SVG/web components/3D), PNG export for iMessage, personalization, related MCPs |
| 08 | photon-landscape | Photon track; creativity rubric | Spectrum features/limits for our flows (photos in, images out, polls, app cards, groups, pacing), Photon skills/CLI/MCP, judge expectations; competitor matrix + differentiation gaps |

## 6. "Good MCP" evaluation rubric (all slices)

A candidate MCP server/tool counts as **good** only if: maintained within ~6 months; real
capability (not a thin toy wrapper); sane security (no unsandboxed arbitrary shell); runs
headless on Linux; license compatible with a public hackathon repo; stdio or Streamable HTTP
transport. Verdicts: good / usable (with caveats) / toy / dead. If nothing qualifies, specify
the MCP we build: server name, tools (name + input/output sketch), backing library/CLI.
