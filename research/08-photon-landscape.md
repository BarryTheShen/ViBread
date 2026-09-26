# ViBread slice 08 — Photon Spectrum and competitor landscape

**Research snapshot:** 2026-09-25 (the hackathon build window).  **Scope:** Photon Spectrum (`spectrum-ts`) integration, Photon track expectations, and differentiation research for ViBread.  Claims below are tied to the source list in §8; marketing claims are labelled as such and anything not independently verified is marked **[UNVERIFIED]**.

## 1) Scope

ViBread is an AI-assisted Arduino prototyping loop: intent → checked circuit IR/netlist + sketch → ERC/electrical/MCU/code validation → visual assembly → real-board self-test (primary) → photo check (secondary) → fault attribution. Photon is a bonus-track interface, not the product’s source of truth. The recommendation is therefore:

> **Use Spectrum for the conversation surface; keep ViBread’s design state, permissions, validation, hardware evidence, and fault diagnosis in ViBread; build a small ViBread MCP server rather than depend on Photon’s archived MCP project.**

### Evidence and maintenance policy

* Photon’s current docs and package metadata were read directly. `https://photon.codes/docs/llms-spectrum.txt` currently returns 404 even though the docs index links to it; the equivalent individual pages and `https://photon.codes/llms-full.txt` were available. Treat the linked docs as the contract, pin the package version, and re-check before the final demo.
* Maintenance numbers are a point-in-time signal, not a quality guarantee. The current `spectrum-ts` repository showed 1,802 stars, 232 forks, MIT license, and a 2026-09-25 push; release `v12.10.1` was published 2026-09-22. The Photon CLI package registry reported `@photon-ai/cli` 2.2.0, MIT, Node >=18/Bun >=1.3. [P1][P2][P3][P4]
* “No” in the competitor matrix means “not publicly documented in the cited first-party material,” not proof that a private or unreleased implementation does not exist.

### Spectrum feature → ViBread moment checklist

| Spectrum capability | ViBread moment | Integration checklist / observable demo | Plan and gotchas |
|---|---|---|---|
| Unified inbound `app.messages`, replies, `responding`, typing | **Clarifying questions and progress** | Map each iMessage/terminal `Space` to a ViBread session. When the design agent needs board, voltage, or component information, send one concise question; wrap long work in `space.responding(...)` so the user sees typing; store the answer in the ViBread session, not only in the chat transcript. | Cloud iMessage supports typing and threaded replies. A local Mac provider accepts typing as a no-op and does not support replies. `responding` clears typing on exceptions. [P5][P6][P7] |
| `poll()` and inbound `poll_option` | **Go / No-Go approval** | Send “Run self-test now?” or “Choose Uno R3 / Uno R4 / ESP32?” as a native poll. Branch on `message.content.type === "poll_option"`; persist sender, poll identity, option title, `selected`, timestamp, and current design revision. Never infer approval from a text reply. | Votes arrive as `poll_option`; generic webhook delivery docs currently say poll votes are not delivered through webhooks, so use the long-lived SDK loop for this feature. [P8][P9] |
| Outbound `attachment()` and `group()` | **Step images and compact build artifacts** | Render each breadboard step as a PNG/JPEG, send an explanatory text plus the image (or a grouped image album), and include a short step number. Preserve the ViBread artifact ID beside the returned Spectrum message ID. | `attachment()` accepts a path, URL, or `Buffer`; MIME must be supplied when it cannot be inferred. Provider fallbacks differ; test image size and ordering on the actual iMessage line. [P10][P11] |
| Inbound attachment content: `read()`, `stream()`, stable `id` | **Phone photo check** | On `attachment`, record `id`, `name`, `mimeType`, `size`; call `read()` once, hash/store bytes, and pass a bounded image artifact to Claude vision. Use `stream()` only when a streaming consumer is useful. For a late retry or missing message, call cloud `imessage(app).getAttachment(guid, phone?)`. | `.read()` and `.stream()` each trigger a download; cache bytes. Cloud GUID lookup is unavailable in the local provider. HEIC/HEIF conversion is available through Photon’s MIT `heif2jpeg` utility and works on Node/Bun/Deno, but Spectrum’s inbound docs do **not** promise that every provider will deliver HEIC specifically: route by MIME and mark unsupported decodes as “photo inconclusive,” not “wiring wrong.” [P12][P13] |
| Generic `app(url, {live:true})` and cloud iMessage Apps | **Live build-status card** | Send one card linking to the current ViBread session: “Step 3/7 — connect LED anode.” Update the same message with `edit(...)` as validation, assembly, and self-test status changes. Keep the original returned card message for all edits. | Live rendering requires a supported platform and the Spectrum iMessage App extension. The recipient may need to install the Spectrum by Photon iMessage App once. Other providers see a URL. In-place updates require cloud `@spectrum-ts/imessage`, not local iMessage. [P14] |
| `customizedMiniApp()` | **Richer phone-sized dashboard** | Use only if a ViBread iMessage extension is actually built/available. The static layout can show caption/subcaption/image/summary; `live:true` can show installed extension UI. | This is a cloud-only custom iMessage App surface; the recipient needs the matching extension. The Photon pricing page puts “bring your own iMessage mini apps” under Business, so do not make it a hard demo dependency on Free/Pro. [P15][P16] |
| iMessage bubble/screen `effect()` | **Fault alert and success celebration** | Use a subtle bubble effect for “short detected — power off,” and reserve `confetti`/`fireworks` for a verified “launch successful” event. Wrap text or an attachment; keep the plain inner content readable if the effect is unavailable. | Effects require cloud iMessage; local iMessage rejects effect sends. Effects do not establish proof of success; the MCU self-test remains authoritative. [P17] |
| `space.create`, `space.get`, group `Space`, membership | **Team group chat** | If Business is available, create one dedicated-line group with teammates, announce the design revision, and have votes/photos arrive in the same shared session. Otherwise use one DM with the builder plus optional per-user DMs; do not promise a native group. | Free/Pro use managed shared numbers and do not support group creation or inbound group-change events. Business dedicated lines support groups. Existing shared-mode groups can be looked up but membership/metadata changes are not streamed. [P18][P19] |
| `message.reply`, reactions, read receipts | **Inline review and fault acknowledgement** | Reply to the specific approval or photo message so a group can see what was answered; react with a tapback to acknowledge receipt. Keep the ViBread revision ID in the reply text. | Cloud supports replies/reactions; local does not. Send-routed unsupported operations may warn-and-skip rather than throw, so do not treat a resolved promise as proof that a tapback rendered. [P7][P20] |
| Terminal provider | **Local deterministic testing and pitch fallback** | Run the same Spectrum handler with `terminal.config()` and no credentials. Use non-TTY stdin/stdout for scripted smoke tests; use multiple terminal spaces to simulate builder/reviewer conversations. | The provider auto-downloads `tuichat` on first run, uses a TTY UI, and falls back to readline in CI/pipes. This is the fastest no-credential demo if cloud credentials or an iMessage line fail. [P21] |
| A2A/MCP permission modes around Spectrum actions | **Ask-every-time / review / bypass** | ViBread, not Spectrum, owns an action policy: `ask-every-time` for flash/power/physical tests, `review` for generated design/code/assembly changes, `bypass` only for read-only simulation. Expose pending approvals to the web UI and iMessage poll; deny stale approvals when the design hash changes. | Spectrum delivers messages; it does not replace ViBread’s permission gate or agent-to-agent contract. Never make “send an iMessage” equivalent to “flash USB hardware.” |

**Minimum Photon demo path:** terminal first; cloud iMessage DM second; inbound photo → HEIC/JPEG bytes → Claude vision → poll approval → Wokwi/MCU simulation result → one edited app card → physical self-test alert/celebration. Native team group and custom live mini-app are stretch goals.

## 2) Industry standard

### 2.1 Spectrum/iMessage operating model

**Cloud versus local is a provider choice, not a flag.** Cloud uses `@spectrum-ts/imessage` and Photon credentials; local uses `@spectrum-ts/imessage-local`, reads a macOS Messages database, and is macOS-only. Cloud is the viable deployment for ViBread’s Linux container; local is useful only for a Mac-side experiment. The cloud package supports Node.js or Bun, but strict browser/worker isolates are not supported because the current transport uses Node-compatible gRPC. [P5][P6]

**Free/Pro are shared-pool DMs; Business is the group tier.** Photon’s pricing page lists Free at $0 with up to 10 users, Pro at $25/month with up to 100 users, and Business at $250/line/month with dedicated iMessage lines, full group messaging, own mini apps, and unlimited users when Auto Scale is enabled. The connection docs describe Free/Pro as a shared pool and Business as dedicated. [P16][P18]

**The “allowlist” is a project-user registration requirement.** Photon’s provider skill says Free/Pro recipients must be registered as project users before outreach; otherwise sends fail with `Target not allowed for this project`. The project API creates a `shared` user by phone number (Photon assigns a pool number) or a `dedicated` user tied to an owned line. The dashboard and CLI are the low-setup paths; avoid guessing API internals during the hackathon. [P22][P23][P24]

**Provisioning is asynchronous from a running SDK.** Cloud automatic discovery renews tokens at 80% TTL. A line provisioned while the app is running is learned at the next token renewal, not immediately; restart when a newly added line must be available for the demo. With multiple dedicated lines, pass `phone` to `space.get()` and usually pin `space.create()` so a conversation does not route unpredictably. [P18]

### 2.2 Event processing: long-lived loop first; webhooks for public deployment

A long-lived `for await (const [space, message] of app.messages)` process is the best hackathon default: no public endpoint, no raw-body signature middleware, and no webhook retry window. Photon documents the loop as a merged cross-provider stream. [P5]

Use webhooks when an externally reachable HTTPS service is preferable. The native webhook contract is HMAC-SHA256 over the exact raw bytes with a five-minute replay window; the SDK can verify it. Photon’s delivery service is at-least-once, retries up to six attempts on 5xx/408/429/network errors, has a 30-second per-attempt timeout, sends handler work fire-and-forget after the response, has no dead-letter queue, rejects HTTP/private/redirecting endpoints, and offers no global/per-space ordering guarantee. Dedupe on webhook/event plus message ID and return 2xx only after durable enqueue. A plain SSH tunnel from the developer laptop is not a public HTTPS webhook endpoint. [P9][P25]

Photon’s production inbound-pipeline guidance is directly relevant to ViBread’s “ask back” behavior:

1. Insert each message into a durable per-space queue.
2. Debounce a burst for a few seconds; Photon’s example uses a five-second window.
3. Drain in the handler, not the enqueuer, so cancellation does not lose rows.
4. Carry drained messages forward if an LLM job is cancelled mid-generation.
5. Store per-chain cancellation state and poll it during send; the documented example checks every 500 ms.
6. Use stable IDs/idempotency for outbound work and a failure audit log.

This prevents “hey / wait / actually” from creating three conflicting design runs and lets a late answer invalidate a stale flash approval. [P26][P27]

### 2.3 Attachments, images, polls, cards, and pacing

* **Inbound attachments:** Spectrum exposes `id`, `name`, `mimeType`, optional `size`, `read()`, and `stream()`. Cloud attachment IDs preserve native IDs such as iMessage GUIDs. A cached `Buffer` and SHA-256 hash should be ViBread’s canonical photo evidence. [P7][P12]
* **HEIC:** The first-party converter `heif2jpeg` consumes a HEIF/HEIC `Buffer` and emits a JPEG `Buffer`, with native binaries for Linux glibc/musl x64/arm64, macOS, and Windows; it is MIT and works with Node/Bun/Deno. Spectrum does not state that HEIC is guaranteed on every inbound path; use MIME detection and a conversion failure state. [P13]
* **Outbound attachments:** `attachment(path|URL|Buffer, options)` supports explicit name/MIME/ID. `group(...)` bundles multiple pieces for an album-like visual group; unsupported platforms may send items sequentially. [P10][P11]
* **Polls:** `poll(title, choices...)` is native at the content layer. Inbound votes are the `poll_option` content arm with `selected`, `option`, `poll`, and `title`. [P8]
* **Live cards:** Generic `app(url, {live:true})` is a URL card whose live rendering depends on the recipient’s installed supported extension. Keep the returned message because Spectrum’s provider-managed `miniAppCardSession` identifies the card for edits. Custom cards require `customizedMiniApp({appName, extensionBundleId, teamId, url, layout, live})`; the extension must exist, and static fallback is safer for this weekend. [P14][P15]
* **Effects:** iMessage bubble constants include slam/loud/gentle/invisible; screen effects include confetti/fireworks/balloons/heart/lasers/celebration/sparkles/spotlight/echo. Use effects for emotional punctuation, not state. [P17]
* **Natural pacing:** Photon warns that automated burst sending, cold outreach, off-hours sending, links/media in the first message, and repeated follow-ups can trigger Apple filtering. Their guidance is inbound-first, text-only opener, at least three user messages to establish trust, consistent replies, no more than 2–3 follow-ups, and <5,000 outbound messages/server/day plus <50 new conversations/line/day. ViBread should send one answer or one card per turn, wait for a user signal before proactive pushes, and fan out team alerts conservatively. [P28]

### 2.4 Photon CLI, skills, and MCP finding

**CLI:** `npx @photon-ai/cli login` or `bunx @photon-ai/cli login`, then `photon projects`, `photon spectrum users`, `photon spectrum lines`, `photon projects open`, and `photon billing`. The CLI manages projects, users, lines, platforms, avatars, and secrets; it does not run ViBread’s agent or replace its permission system. Current npm metadata reports `@photon-ai/cli` 2.2.0, MIT, Node >=18/Bun >=1.3. [P2][P3]

**Skill:** `https://skills.sh/photon-hq/skills/spectrum` is a coding-agent skill backed by `photon-hq/skills`; its `SKILL.md` is MIT, version 2.1.0, targets `spectrum-ts` 12.2.0, and instructs agents to read provider capability semantics before writing code. Use it as a reference, but pin the newer package and verify differences (for example, Spectrum 12.10.0 changed signal-shutdown behavior). The skill repository showed 15 stars and a 2026-08-04 push, but no repository license was declared in the GitHub metadata. [P29][P30][P31]

**MCP:** Photon’s discoverable `photon-hq/mcp` now resolves to the archived `photon-hq/mcp-legacy` repository (3 stars, no declared license, last push 2026-04-03). It exposes a legacy remote iMessage endpoint with 67 tools, but it is built on deprecated `@photon-ai/advanced-imessage-kit`; do not make it a ViBread dependency. Spectrum itself is an SDK, not an MCP server. The viable pattern is to build `vibread-mcp` and use Spectrum as one backing provider. [P32][P33]

## 3) Existing MCP servers & tools

| Name | URL | License | Last activity / maintenance signal | Transport | Capabilities | Verdict |
|---|---|---|---|---|---|---|
| Photon MCP (`photon-hq/mcp` → `mcp-legacy`) | [repo](https://github.com/photon-hq/mcp), [old endpoint](https://mcp.photon.codes/imessage) | Not declared in repo metadata | Archived; 3 stars; pushed 2026-04-03; based on deprecated Advanced iMessage Kit | Hosted HTTPS endpoint; headers `x-server-url` and `x-api-key` | 67 legacy iMessage tools: chats/messages/attachments/contacts/polls/scheduled messages/FaceTime/Find My | **dead** — useful as historical evidence only; no new code should depend on it. [P32][P33] |
| Wokwi CLI MCP | [MCP docs](https://docs.wokwi.com/wokwi-ci/mcp-support), [CLI repo](https://github.com/wokwi/wokwi-cli) | MIT | 66 stars, 15 forks, 191 commits visible in snapshot; experimental MCP feature; active first-party docs | Local stdio: `wokwi-cli mcp`; `WOKWI_CLI_TOKEN` | Run embedded simulations/tests, monitor serial logs, interact with virtual hardware; WITL automation, screenshots/VCD/GDB through CLI | **usable** (close to **good**) — excellent ViBread simulation backing, but token/cloud dependency and experimental MCP surface need a pinned smoke test. [P34][P35] |
| Flux MCP Server | [official docs](https://docs.flux.ai/reference/flux-mcp-server) | Proprietary hosted service; no OSS license | Live docs; commercial SaaS; no public repo maintenance signal | Streamable HTTP `https://app.flux.ai/mcp`; OAuth or bearer API key | Read live PCB projects, nets/pins/designators, generate firmware pin maps, start Flux agent threads, request schematic/layout changes | **usable** for comparison, **not a ViBread dependency** — strong agent interop but PCB-focused, cloud/account/ACU-bound, and cannot verify a physical breadboard. [P36] |
| Spectrum SDK (not an MCP server) | [GitHub](https://github.com/photon-hq/spectrum-ts), [npm](https://www.npmjs.com/package/spectrum-ts) | MIT | 1,802 stars/232 forks; `v12.10.1` published 2026-09-22; repo pushed 2026-09-25 | Node/Bun SDK loop; webhooks also available | Native iMessage/terminal attachments, polls, replies, typing, groups, effects, app cards, content builders | **good dependency**, **not MCP** — wrap behind ViBread’s own messaging adapter. [P1][P5] |
| Photon Spectrum skills | [skills.sh](https://skills.sh/photon-hq/skills/spectrum), [repo](https://github.com/photon-hq/skills) | `SKILL.md` says MIT; repo metadata has no license field | 15 stars; pushed 2026-08-04; targets SDK 12.2.0 | Static Markdown skill, no transport | Provider-aware coding guidance and capability/fallback semantics | **usable reference**, **not a runtime server** — load selectively; do not vendor blindly. [P29][P30] |

**MCP decision:** use Wokwi MCP for simulated MCU interaction if a token is available; use Flux only as a landscape example; ignore Photon’s archived server; build `vibread-mcp` for ViBread’s design/validation/assembly/hardware evidence actions. No candidate provides the entire ViBread closed loop.

## 4) Recommendation per sub-area: USE / WRAP / BUILD

### 4.1 Photon and interaction choices

| Sub-area | Recommendation | Rationale |
|---|---|---|
| Spectrum runtime and cloud iMessage | **USE** `spectrum-ts` 12.10.1 (pin exact version) | Mature, MIT, active, Node/Bun-compatible, and has the exact bonus-track native features: attachments, polls, effects, typing, replies, terminal provider. [P1][P5] |
| ViBread messaging abstraction | **WRAP** Spectrum | Define a small `MessagingPort` (`sendText`, `sendAttachment`, `sendPoll`, `editCard`, `reply`, `startTyping`) and keep provider/platform capability results. This prevents application logic from depending on raw `Space` objects and allows terminal fallback. |
| Photon cloud setup/admin | **USE** Dashboard + CLI | Lowest-setup path: use the public Luma instructions, redeem `HACKWITHPHOTON` for free Pro if still honored, create the project, add test phone numbers as users, and verify a DM before the build. [P24] |
| iMessage group collaboration | **USE** Business only if already provisioned; otherwise **WRAP** DM fan-out | Free/Pro shared pools cannot create groups. Do not burn hackathon time or money on a Business line solely for the stretch goal. Use a single builder DM plus terminal/web for reviewers if needed. [P16][P18] |
| Attachments and HEIC | **USE** Spectrum attachment primitives; **WRAP** `heif2jpeg` | Avoid a custom downloader; cache `read()` bytes and convert only when MIME/decode requires it. [P12][P13] |
| Poll approvals | **USE** native Spectrum polls in the SDK loop | Strong native UX, but webhook docs currently exclude votes. Persist vote-to-revision mapping. [P8][P9] |
| Live app cards | **USE** generic `app()` static card first; **BUILD** a ViBread web route that serves the card state | This gives a polished deep link without requiring a custom Apple extension. Add `live:true` only after confirming the Spectrum iMessage App appears on a test phone. Custom extension is out of weekend scope. [P14][P15] |
| Effects | **USE** sparingly | One success celebration and one safety-critical power-off alert are memorable; effects cannot substitute for evidence. [P17] |
| Event ingestion | **USE** long-lived `app.messages`; **WRAP** webhook later | Long-lived loop avoids public HTTPS and webhook-loss semantics. Add HMAC webhook support only for a deployed, multi-instance service. [P5][P9] |
| Local test surface | **USE** terminal provider | No credentials, same message/content contract, non-TTY operation for smoke scripts, and multiple spaces for role simulation. [P21] |
| Photon MCP | **AVOID** archived server; **BUILD** ViBread MCP | The old server is archived, unlicensed in metadata, and built on a deprecated kit. [P32][P33] |

### 4.2 Competitor matrix (differentiation only; do not copy)

**Legend:** `✓` publicly documented; `△` partial/limited or simulation-only; `—` not publicly documented; `N/A` not the product’s job. “Physical verification” means evidence from the actual assembled breadboard/MCU, not merely flashing firmware or running a virtual circuit.

| Competitor (source) | NL → design | Code gen | Simulation | Assembly instructions | Physical-build verification | Debug loop | Agent interop (MCP/A2A) | Messaging presence | Pricing / availability |
|---|---|---|---|---|---|---|---|---|---|
| **Cirkit Designer** ([site](https://www.cirkitdesigner.com/), [docs](https://www.cirkitdesigner.com/docs/tutorials/simulating-your-circuit)) | ✓ AI wiring and circuit-aware questions | ✓ Arduino/ESP32/Pico project code | ✓ Browser firmware simulation and component responses | △ Wiring diagrams/docs export, not a verified step ledger | △ Uploads tested firmware to real hardware; no public breadboard short/miswire verifier | ✓ AI help to debug/improve circuits/code | — found in cited docs | — | Free to start/no install; membership page advertises Community/Hobby/Pro/Max, exact current plan details should be rechecked. [P37][P38] |
| **cirkit.ai / Cirkit** ([site](https://www.cirkit.ai/), [terms](https://www.cirkit.ai/terms)) | ✓ Plain-English idea → wiring diagram, enclosure, parts | ✓ Validated Arduino-style firmware | — separate simulator not verified in accessible first-party page | △ Shopping list and generated enclosure, not assembly verification | — | △ claims validated code, no closed physical loop | — | — | Product/early-access state and pricing **[UNVERIFIED]**; first-party site was not fetchable in this run. [P39][P40] |
| **Schematik** ([site](https://www.schematik.io/), [AI info](https://www.schematik.io/ai-info.md), [comparison](https://www.schematik.io/compare/tinkercad-circuits)) | ✓ Plain English → project | ✓ Arduino/ESP32/Pico source | — explicitly focused on physical build, not simulation | ✓ Parts, pin map, wiring, six-step style assembly walkthrough | △ Browser deploy to supported boards; no public physical wiring/short verification | — | — | — | Browser/desktop; pricing not published in cited pages; AI info page last updated 2026-04-28. The old `schematik.ai` domain was parked; use `.io`. [P41][P42][P43] |
| **Tinkered** ([design](https://www.tinkered.ai/circuit-design), [simulate](https://www.tinkered.ai/simulate), [deploy](https://www.tinkered.ai/deploy)) | ✓ Editable schematic/device model from behavior | ✓ Board-specific C/C++ firmware | ✓ Firmware + electrical/analog + 3D, Wi-Fi/MQTT/HTTP | △ Connected project/build/deploy flow; no public phone-friendly assembly ledger | △ USB/serial deployment and serial observation; no camera/self-test verifier | ✓ Simulate → observe → refine; compatibility/voltage/pin checks | — | — (Discord community is not product messaging) | Free to start/no install is advertised; paid tiers not found in cited pages. [P44][P45][P46] |
| **CircuitAI** ([marketing site](https://www.circuitai.design/), [small implementation](https://github.com/KshKnsl/CircuitAI)) | ✓ marketing claim; implementation is digital-logic-oriented | ✓ marketing claims MCU firmware; not independently verified | ✓ marketing claims SPICE/fault detection; small implementation uses DigitalJS | — | — | △ digital simulation/debug | — | — | Official marketing domain returned 404 in this run; current status/pricing **[UNVERIFIED]**. The GitHub implementation had 7 stars and one visible commit in the fetched page, so treat as toy evidence, not a dependency. [P47][P48] |
| **Flux Copilot** ([Copilot](https://docs.flux.ai/flux/reference/copilot), [simulator](https://docs.flux.ai/reference/simulator-tool), [MCP](https://docs.flux.ai/reference/flux-mcp-server)) | ✓ Context-aware PCB schematic/part selection and direct approved edits | △ Generates Python analysis scripts; not Arduino firmware as a core feature | ✓ Ngspice AC/DC/transient/op-point; digital simulation limited | — PCB/placement workflow, not breadboard steps | — | ✓ Design feedback/FMEA/SPICE; no physical attribution loop | ✓ First-party Streamable HTTP MCP, live PCB context and agent threads | — | Explore free trial; Build/Pro/Teams/Enterprise with ACU-based AI usage. [P36][P49][P50] |
| **Wokwi + AI/MCP** ([MCP](https://docs.wokwi.com/wokwi-ci/mcp-support), [CI](https://docs.wokwi.com/wokwi-ci/getting-started)) | △ AI can operate a supplied project via MCP; not a first-party NL circuit planner | △ User supplies/builds firmware; agent can run it | ✓ Strong digital MCU/peripheral/Wi-Fi simulation, WITL tests, serial, GDB | — | — | ✓ Automated scenarios, serial assertions, GDB | ✓ Experimental stdio MCP | — | Community $0; Hobby €5.6/mo, Hobby+ €8.1/mo, Pro €20/seat/mo annual prices shown. [P34][P35][P51] |
| **Tinkercad Circuits** ([Circuits](https://www.tinkercad.com/circuits), [guide](https://www.tinkercad.com/blog/official-guide-to-tinkercad-circuits)) | — drag/drop beginner workspace | ✓ Arduino/micro:bit text and Codeblocks | ✓ Browser virtual circuit simulation | △ Tutorials and virtual breadboard, not physical instructions | — | △ Virtual behavior/debug only | — | — | Free browser product; strong education availability, not a physical verification service. [P52][P53] |
| **Arduino AI Assistant / Cloud** ([AI help](https://support.arduino.cc/hc/en-us/articles/19958917855132-About-the-Arduino-AI-Assistant), [data](https://support.arduino.cc/hc/en-us/articles/19958862731804-Understand-how-the-Arduino-AI-Assistant-works-and-how-it-uses-your-data)) | △ Prompt-to-sketch, board context; no circuit topology generator | ✓ Generates/fixes/explains sketches | — Cloud Editor is not a circuit simulator | — Tutorials/examples, not personalized assembly | △ Upload/monitor real devices; no public breadboard verifier | ✓ Code debugging/explanation | — | — | All Cloud plans: Free 30 interactions/month, Maker/School 1500, Team/Enterprise unlimited; Arduino blog lists Maker $6.99/month. [P54][P55][P56] |
| **circuito.io** ([home](https://www.circuito.io/), [builder](https://www.circuito.io/app)) | △ Select high-level blocks; not natural language | ✓ Test code snippets for selected components | — | ✓ Parts list, detailed wiring guide, Fritzing diagram | — | △ Test-code path, no persistent diagnosis | — | — | Free web tool / pricing not stated in cited pages. [P57] |
| **Fritzing** ([home](https://fritzing.org/), [repo](https://github.com/fritzing/fritzing-app)) | — manual | △ Arduino code/examples/export, not AI | — | ✓ Excellent native breadboard view and documentation | — | — | — | — | Desktop 1.0.8 released 2026-08-12; purchase funds development. Source GPLv3; documentation/parts CC BY-SA 3.0, so incompatible as a copied application basis under ViBread’s rules. [P58][P59] |
| **EasyEDA** ([home](https://easyeda.com/)) | — manual EDA; no NL planner in cited page | — | △ Simple simulation in Standard; full schematic/PCB/3D | — PCB/manufacturing docs, not breadboard steps | — | ✓ Schematic/PCB rules and manufacturing checks | — | — | Free web/desktop Standard; Pro and on-premise options; closed/proprietary service. [P60] |
| **ProtoPulse** ([repo](https://github.com/wtyler2505/ProtoPulse), [guide](https://raw.githubusercontent.com/wtyler2505/ProtoPulse/main/docs/AI_AGENT_GUIDE.md)) | ✓ AI architecture/schematic actions | ✓ Firmware scaffold | ✓ SPICE/frequency analysis | ✓ Breadboard/PCB views and exports; camera verification is listed as future work | — roadmap says camera-based component ID, not shipped physical verification | ✓ ERC/DRC/BOM/FMEA/audit and AI review | △ repo has a `.mcp.json` for Playwright/Desktop Commander/QMD/NotebookLM, not a ProtoPulse MCP server | — | MIT/free claim; 2 stars, repo pushed 2026-08-07; broad but low adoption/experimental. Do not copy. [P61][P62][P63] |
| **CircuitMuse** ([repo](https://github.com/meshackbahati/circuit-muse), [README](https://raw.githubusercontent.com/meshackbahati/circuit-muse/main/README.md)) | ✓ local AI can add/wire components | ✓ Arduino C++/MicroPython/ESP-IDF | ✓ CPU emulation (AVR/RP2040/ESP32/STM32), ngspice-WASM mixed mode | △ Drag/drop canvas; imports/exports Wokwi/Fritzing | — serial simulation is not real-build verification | ✓ AI design/wiring/compile-debug | — | — | MIT desktop/local; release 1.0.2, 4 stars in fetched repo page; promising but tiny project. [P64][P65] |

#### Maintenance / availability snapshot

The following records the maintenance signal requested for this landscape. A dash means that the vendor does not publish a comparable public commit/release signal; it is not evidence of inactivity. Commercial sites were checked as live documentation/marketing surfaces on the snapshot date.

| Product | Public signal at snapshot | Interpretation |
|---|---|---|
| Cirkit Designer | Live docs/site; no public source repository or release feed found | Active-looking hosted product; exact release date/stars **[UNVERIFIED]**. |
| cirkit.ai | Privacy policy says updated 2026-02-03; product site was not fetchable in this run | Early-access/product availability **[UNVERIFIED]**; no public stars/release feed found. |
| Schematik | AI-info page last updated 2026-04-28; `.io` site live; old `.ai` domain parked | Active hosted/desktop product signal; no public repo/stars/release feed found. [P41][P43] |
| Tinkered | Live design/simulation/deploy pages; no public repo/release feed found | Active hosted beta/product signal; exact release date/stars/pricing **[UNVERIFIED]**. [P44][P45][P46] |
| CircuitAI | Official marketing domain returned 404; `KshKnsl/CircuitAI` showed 7 stars and one visible commit | Treat official product status as **[UNVERIFIED]** and the public implementation as toy evidence. [P47][P48] |
| Flux | Live first-party docs and pricing; proprietary SaaS, no public product repo | Active commercial product; stars/releases are not applicable. [P36][P49][P50] |
| Wokwi CLI | 66 stars/15 forks and 191 commits in the repository snapshot; experimental MCP docs live | Maintained first-party CLI, but exact latest commit/release date was not surfaced by the fetched GitHub page **[UNVERIFIED]**. [P34][P35] |
| Tinkercad Circuits | Live Autodesk product/guide; no public product repository or release feed | Established hosted education product; stars/releases not applicable. [P52][P53] |
| Arduino AI Assistant | First-party support article and 2025-04-17 announcement; no public product repo/release feed | Maintained commercial Cloud feature; exact current model/release signal **[UNVERIFIED]**. [P54][P56] |
| circuito.io | Live builder/site metadata; no public source/release feed found | Hosted maker service; exact maintenance/pricing **[UNVERIFIED]**. [P57] |
| Fritzing | Version 1.0.8 released 2026-08-12; GitHub page showed about 4.8k stars/960 forks | Active, established desktop open-source project; GPLv3 and CC BY-SA assets are a licensing boundary. [P58][P59] |
| EasyEDA | First-party page claims 13 years of development and live Standard/Pro/on-premise surfaces; no public product repo/release feed | Established proprietary EDA; stars/releases not applicable. [P60] |
| ProtoPulse | 2 stars; repository `pushed_at` 2026-08-07; MIT | Active-looking but very small/experimental; do not treat marketing breadth as production proof. [P61] |
| CircuitMuse | 4 stars in repo snapshot; release feed exposes v1.0.2/v1.0.1; exact release dates not surfaced | Promising MIT toy/early desktop project; verify before depending. [P64][P65] |
| CircuitLM | 7 stars/4 forks and one visible commit in the fetched GitHub page; 2026 paper/repo | Research/early implementation; useful ideas, not a mature dependency. [P67][P68] |

### 4.3 Notable academic systems (one-line descriptions)

* **WIRES** — generates functioning electronic devices from natural-language descriptions, demonstrating the research baseline for intent-to-physical-device generation. [P66]
* **CircuitLM** — multi-agent natural-language → grounded CircuitJSON schematic pipeline with component retrieval, pin canonicalization, deterministic ERC, and a visualizer; its own README lists human review/closed-loop fixing as TODO. [P67][P68]
* **ChatEDA** — LLM controller that decomposes natural-language EDA tasks, generates scripts, and orchestrates RTL-to-GDSII tools. [P69]
* **AutoEDA** — MCP-based natural-language control plane that validates a structured EDA spec and renders executable Tcl for RTL-to-GDSII flows. [P70]
* **SchemaBoard** — projects dynamic in-situ light cues through a breadboard to guide component placement, polarity, net mapping, and final verification. [P71]
* **CircuitSense** — senses breadboard pin locations/components and reconstructs a virtual circuit for interactive debugging and sharing. [P72]
* **BlinkBoard** — LED-instrumented breadboard that remotely guides and monitors physical-computing assembly and sensor readings. [P73]
* **WireWay** — hardware-contextualized guidance and in-situ tests for circuit prototyping/debugging, especially relevant to ViBread’s physical closed loop. [P74]

### 4.4 What ViBread can own

The credible gap is not “AI draws a circuit.” Cirkit Designer, Schematik, Tinkered, CircuitMuse, ProtoPulse, Flux, and academic work already cover parts of that. The gap is a **proof-carrying, conversational, physical loop**:

1. Design intent and revision hash are explicit.
2. ViBread checks the netlist, firmware, simulation, and expected self-test before asking the user to power anything.
3. Each assembly step is personalized to the user’s board/photo and delivered in the surface they already use.
4. The MCU runs a safe self-test that can distinguish many wiring/short/power faults; Claude vision is secondary and reports uncertainty.
5. The agent attributes a failure to design, code, or wiring and proposes the next discriminating test.
6. Claude Code can call this loop through MCP/A2A with permission modes, while teammates can approve/observe through a Photon group/DM.

**Crisp differentiation statement for the Creativity rubric:**

> **ViBread is not another circuit generator or simulator: it is the flight controller for a real breadboard mission—an agent that asks before acting, turns intent into a checked design, guides each physical connection over iMessage, proves the assembled Arduino with an MCU self-test, and closes the loop by telling the team whether the fault is design, code, or wiring.**

That statement is intentionally narrower and more defensible than “we beat every competitor.” Publicly documented competitor materials do not establish that no one has any physical verification; they do establish that the dominant products stop at design/simulation/deploy, while the academic systems that address physical guidance are not messaging-native product loops. [P44][P71][P72][P73][P74]

### 4.5 Photon judge expectations and public track evidence

**Internal event slides (provided in the project brief):** Photon’s track rubric names **Vision, Craft, Depth, Traction**, and emphasizes real human-in-the-loop collaboration plus context that persists across time, channels, and teammates. The slide URL was not included in the research workspace; cite the supplied deck in the final submission as “Photon track slides, pp. 3–5” and treat an external URL as **[UNVERIFIED]** until the organizers provide one.

**Public Photon-track evidence:** the Beta Fund hackathon page says the Photon prize is for the “best interface” using Spectrum, requires iMessage integration through Spectrum, and offered two “Best Photon Interfaces” awards; its judging criteria explicitly score Spectrum chat-interface quality, technical depth, innovation versus a wrapper, and continuity after build day. [P24]

Translate the four slide words into the ViBread pitch:

| Judge word | What to show, not merely claim |
|---|---|
| Vision | “Fly Me to the Moon” as a real mission: an agent navigates a novice from intent to a verified launch, with a short story and a user who would otherwise be blocked by wiring uncertainty. |
| Craft | Native iMessage details that feel intentional: typing while thinking, one debounced answer, a poll for approval, a step image, an edited status card, restrained effect, readable fallback text, and no message spam. |
| Depth | Structured design revision IDs, ERC/simulation/compile evidence, MCU self-test signals, photo uncertainty, attribution logic, MCP/A2A tools, and permission modes. |
| Traction | A live builder, teammate, or judge who can send a message/photo and alter the outcome; replayable terminal fallback; metrics such as time-to-first-build, approval latency, self-test pass rate, and number of faults correctly attributed. |

**Named public examples:**

* **Jacky Zhong & Daniel Ou — “Six Degrees,”** the public Moonlighting Hackathon Photon/iMessage pitch winner reported as using iMessage invites to show degrees of separation. This is a winner example, not a circuit competitor. [P75]
* **BEACON — Kylie Trousil, Pavankumar Suresh, and Jason Cao,** an iMessage emergency assistant that reached the top five at HackWithSeattle; it is a placement example, not a Photon winner. [P76]
* **naval.chat — Julie Chen,** a Photon community highlight that sent four personalized daily insights and reportedly reached 100+ users in one day; not labelled a contest winner. [P77]
* **Hackkey — public Photon Residency spotlight,** an iMessage agent that converted a Luma link into an Apple Wallet invite with a QR code; again a community example, not a contest winner. [P78]

I found no authoritative public archive naming all Spectrum/Photon hackathon winners. Do not invent a winner list; show the one sourced winner and describe the others with their actual placement/status.

## 5) If BUILD: proposed ViBread MCP server

### 5.1 Server shape and safety boundary

**Name:** `vibread-mcp` (stdio for Claude Code first; optional Streamable HTTP/A2A adapter later).

**Backing components:** ViBread’s own structured design/session store; Anthropic Claude tool/vision calls; `arduino-cli` or the firmware peer’s selected toolchain; Wokwi CLI/MCP where available; `spectrum-ts`/`heif2jpeg`; browser Web Serial for the laptop-side board; the existing ERC/SPICE/MCU/assembly implementations from sibling slices. The MCP server must call allowlisted binaries with bounded working directories and timeouts, never expose arbitrary shell execution, and return artifact references/hashes rather than huge binary payloads.

Every mutating tool receives `permissionMode` (`ask-every-time | review | bypass`) and `expectedRevision`. A stale revision returns `revision_conflict` rather than silently applying to a newer design. Flash/power-on/physical-test tools **must not** be bypassable by an iMessage text or a model-generated confirmation alone.

### 5.2 Minimal tool contract

| Tool | Inputs | Outputs |
|---|---|---|
| `vibread.plan_circuit` | `intent`; `board` (`uno-r3`, `nano`, `uno-r4`, `esp32`, `pico`, or `unknown`); `constraints`; optional `components`; `sessionId`; `permissionMode` | `designId`, `revision`, structured IR/netlist/schematic artifact refs, BOM, pin map, assumptions, ERC preflight, `clarifyingQuestions[]`, `requiresApproval` |
| `vibread.validate_design` | `designId`, `revision`, checks (`erc`, `electrical`, `simulation`, `all`), optional scenario IDs | Per-check pass/fail/warn, machine-readable findings with net/component IDs, numeric measurements, simulator/tool versions, artifact refs, next actions |
| `vibread.generate_firmware` | `designId`, `revision`, behavior/test requirements, target board, permission mode | Source-file artifact refs, pin-map hash, library requirements, generated self-test hooks, compile command selected by policy, approval status |
| `vibread.run_simulation` | `designId`, `revision`, firmware artifact, scenario list, timeout | Pass/fail per scenario, serial log, traces/screenshots, virtual input events, simulator identity/version, evidence refs |
| `vibread.compile_firmware` | firmware artifact, board/FQBN, library lock, timeout, permission mode | Build status, binary/ELF artifact refs and hashes, compiler output, warnings/errors, upload eligibility |
| `vibread.assembly_plan` | `designId`, `revision`, available parts, board/rail orientation, user skill/viewport, optional personalization | Ordered idempotent steps, each with source/target pins and net, SVG/PNG artifact refs, estimated verification cue, confidence/ambiguity flags |
| `vibread.inspect_photo` | `sessionId`, `designId`, `revision`, image artifact or attachment ID, MIME, optional prior step | Detected board/components/wires/rails, expected-vs-observed mismatches, occlusions, confidence, “inconclusive” reasons, recommended second photo/MCU test; never a binary “safe” claim from vision alone |
| `vibread.start_self_test` | `designId`, `revision`, browser/device session ID, requested test profile, explicit power/flash approval token | Test plan, safe preflight, pending physical approval or run ID; never silently powers or flashes |
| `vibread.read_self_test` | `runId`, cursor | Serial/ADC/GPIO/current evidence, fault candidates, pass/fail, abort reason, board identity, evidence hash |
| `vibread.diagnose_fault` | `designId`, `revision`, evidence refs (ERC/sim/build/self-test/photo/message), user observations | Ranked attribution `design|code|wiring|unknown`, rationale tied to evidence, next discriminating test, rollback/fix proposal, approval requirement |
| `vibread.get_session_state` | `sessionId` | Current phase, design/revision hash, pending approvals, known users/chats, evidence timeline, permission mode, last failure |

`vibread.ask_user` is better represented as MCP elicitation/A2A `input_required` where supported; Spectrum handles the human-facing delivery. The same pending question should render in the web UI, iMessage, terminal, and Claude Code without duplicating state.

## 6) Integration notes & gotchas for the ViBread stack

### 6.1 Setup sequence (time-boxed)

1. **Cloud smoke:** sign in at [Photon Dashboard](https://app.photon.codes), create/enable Spectrum, redeem `HACKWITHPHOTON` from the public hackathon instructions, add Barry’s test number and one teammate as project users, and send a text-only inbound-first DM. [P24]
2. **Install:** pin `spectrum-ts` 12.10.1; import `Spectrum` and `imessage` from the package’s documented entry points. Put `SPECTRUM_PROJECT_ID` and `SPECTRUM_PROJECT_SECRET` in secrets, never browser code. [P1][P5]
3. **Terminal fallback:** configure `terminal.config()` in a separate composition module and test the same handler in a non-TTY pipe. Do not statically import the macOS-only local provider into the Linux cloud bundle. [P6][P21]
4. **Loop:** start one long-lived async message loop; filter outbound echoes by `message.direction`; route inbound `attachment`, `poll_option`, `text`, `reply`, and `reaction` explicitly. [P7]
5. **State:** map `space.id` to a ViBread thread, sender address/user ID to a per-person memory scope, and every action to a design revision hash. Never let a group message mutate the wrong user’s hardware session. [P27]
6. **Demo:** use a pre-rendered step image and a deterministic terminal test if cloud provisioning is delayed; add cards/effects only after text, attachment, and poll are proven.

### 6.2 Node/Bun and process lifecycle

* Cloud Spectrum supports Node.js or Bun; Node 22 and Bun are both compatible with the documented runtime surface. `heif2jpeg` supports Node/Bun/Deno. [P6][P13]
* `spectrum-ts` 12.10.0 removed automatic SIGINT/SIGTERM handlers and `process.exit()` behavior; install an explicit signal handler that calls `await app.stop()` in a standalone process. This matters when ViBread runs Spectrum inside an HTTP host. [P1]
* Keep cloud and local provider imports in separate composition files. The local adapter pulls native/macOS SQLite dependencies; it must not enter the Linux deployment graph. [P6]
* Do not put Spectrum credentials, Photon CLI tokens, Wokwi tokens, Anthropic keys, or attachment URLs in an iMessage message or browser bundle.

### 6.3 Attachments and photo pipeline

```text
Spectrum attachment event
  → validate MIME/size and attachment ID
  → await content.read() exactly once
  → content-addressed store + metadata (GUID/hash/revision)
  → if HEIC/HEIF: heif2jpeg(Buffer, { quality: 85 })
  → downscale/redact as needed
  → Claude vision with expected assembly step + design revision
  → structured findings (observed / expected / uncertain)
  → ask for a better photo or run MCU self-test
```

Do not use a URL supplied by a message as an unrestricted server fetch. For cloud GUID retrieval, call the narrowed iMessage provider and pass `phone` when multiple dedicated lines exist. Keep a byte budget and hash before handing an image to the model. A photo can prove “looks like a red wire enters this row”; it cannot prove an electrical short, so the MCU self-test is primary. [P12][P13][P18]

### 6.4 Permissions and closed loop

* **Ask-every-time:** flash firmware, enable board power, run a current/short test, send a group-wide alert, change a design revision after approval.
* **Review:** generate/modify schematic, choose a component, update firmware, create a new assembly route, upload a photo for vision analysis.
* **Bypass:** read-only state, list artifacts, run a pure simulation with no external side effects, format a message.

The approval token must bind `(sessionId, designRevision, action, actor, expiresAt)`. A poll vote on revision `r7` must not authorize flashing `r8`. The web UI and Claude Code MCP client should display the same pending action and evidence.

### 6.5 Web Serial placement

The Arduino is on the developer’s laptop while ViBread’s backend is in a Linux container behind an SSH tunnel. Therefore the browser must own device permission and Web Serial/USB transfer, while the backend owns policy, design artifacts, and expected test vectors. Do not attempt to open `/dev/tty*` in the remote container and assume it is the laptop board. The browser-side bridge should send signed, short-lived commands to the backend and stream serial evidence back into `vibread-mcp` state. [P79]

### 6.6 Board assumptions

Photon does not care which MCU is used; the ViBread validators do. Lock the initial demo to **Uno R3/Nano ATmega328P** unless the user confirms otherwise. Uno R4 uses Renesas RA4M1 and changes pin/CPU/toolchain/simulation behavior; ESP32 adds Wi-Fi, 3.3-V constraints, and a different boot/upload path; Pico uses RP2040 and a different firmware toolchain. Every Spectrum message and MCP tool should display the board identity and design revision to prevent an apparently valid but wrong self-test.

### 6.7 Rate limits and deliverability guardrails

* Spectrum API default: **5 requests/second/project**, returning 429 when exceeded; implement bounded retry/backoff for management calls. [P80]
* Cloud messaging: **5,000 outbound messages/server/day** and **50 new conversations/line/day** by default; shared-pool Free/Pro also require registered project users. [P18][P22]
* Avoid the first-message link/image. Send a text opener that invites a reply; after the user responds, send the step card/image. Use one debounced response per turn and no 3 a.m. proactive alerts. [P28]
* For team review, prefer one group update or one edited status card, not dozens of individual messages. Keep the terminal/web dashboard as the authoritative event log.

### 6.8 Capability truth table

| Feature | Cloud `imessage` | Local `localIMessage` | Terminal |
|---|---|---|---|
| Text and attachments | Native | Native | Native-ish buffer/drag-drop |
| `read()` inbound attachment | Yes | Yes | Yes, local buffer |
| GUID fetch `getAttachment` | Yes | No | N/A |
| Polls/effects/app cards | Cloud iMessage features | Unsupported/degraded | Terminal-native/fallback behavior |
| Replies/reactions/edits/unsend | Yes | No | Replies/reactions supported |
| Groups/create/membership events | Dedicated Business lines | Existing only; no create | Multiple terminal spaces, not iMessage groups |
| Typing | Yes | No-op | Yes |
| Webhook | Yes, native HMAC | Not the cloud route | No credentials needed |

The universal TypeScript method existing is not proof of provider support. Handle native, fallback, warn-and-skip, no-op, and thrown resolver errors according to the provider capability semantics. [P20][P21]

## 7) Risks & unknowns

1. **Promo and plan drift:** `HACKWITHPHOTON`, Free/Pro limits, and line availability come from the public event page/pricing page and may expire or change; redeem and test immediately. **[UNVERIFIED after redemption]** [P16][P24]
2. **Group cost/schedule:** native groups require a Business dedicated line; provisioning, billing, and line token renewal can exceed the 36-hour window. Plan DM + terminal fallback. [P18]
3. **HEIC guarantee:** `heif2jpeg` is real and MIT, but Spectrum does not explicitly promise an inbound HEIC content type for all Apple paths. Treat MIME/decode as a runtime capability check. [P12][P13]
4. **App-card install:** live rendering depends on the recipient having the Spectrum iMessage App or the ViBread extension. Static URL cards are the safe default. [P14][P15]
5. **Webhook loss:** webhooks are at-least-once with bounded retries and no DLQ; use the long-lived SDK loop for the demo and durable dedupe if webhooks are added. [P9]
6. **Apple filtering:** cloud lines are subject to Apple behavior filters; bursts/cold outreach/first-message media can harm deliverability. Keep all sends inbound-first and sparse. [P28]
7. **Archived Photon MCP:** the old server is not a safe integration foundation. Its repo is archived and license metadata is absent. Build `vibread-mcp`. [P32][P33]
8. **Version drift:** Photon skills target 12.2.0 while npm is 12.10.1; package behavior around shutdown and provider capabilities changed. Pin and run a targeted smoke test. [P1][P29]
9. **Vision false positives:** a photo can be occluded, rotated, low-light, or misleading; Claude must emit uncertainty and request the MCU self-test. Never claim electrical safety from an image.
10. **Physical safety:** a generated self-test can damage hardware if it drives a shorted rail. Begin with power-off continuity/known-safe resistance checks where possible, low-current/fused supply, then a staged MCU test; require explicit approval.
11. **Competitor evidence quality:** many AI-hardware sites are marketing pages, beta products, or tiny repositories. Feature claims in the matrix are sourced but not independent benchmarks; do not reproduce their UI/code or imply they are all production competitors.
12. **Licensing:** Fritzing’s GPLv3/CC-BY-SA assets cannot be copied into a permissive ViBread app; use only documented concepts or separately licensed libraries. MIT dependencies are still dependencies, not permission to clone a competitor. [P59]
13. **No complete public winner archive:** only one named Photon/iMessage hackathon winner was independently found; do not state that a community spotlight was a contest win. [P75][P76][P77][P78]
14. **Board mismatch:** Uno R4/ESP32/Pico are not drop-in variants of ATmega328P; the selected board must flow through IR, compiler, simulator, assembly visuals, self-test, and chat copy.

## 8) Sources

### Photon Spectrum, SDK, CLI, and operations

* **[P1]** Spectrum repository and MIT license/maintenance snapshot: <https://github.com/photon-hq/spectrum-ts>
* **[P2]** Photon CLI npm metadata (`@photon-ai/cli` 2.2.0): <https://registry.npmjs.org/@photon-ai%2fcli/2.2.0>
* **[P3]** Photon CLI overview/commands: <https://docs.photon.codes/docs/cli/overview>, <https://docs.photon.codes/docs/cli/projects>, <https://docs.photon.codes/docs/cli/spectrum>
* **[P4]** Spectrum npm metadata (`spectrum-ts` 12.10.1): <https://registry.npmjs.org/spectrum-ts/12.10.1>
* **[P5]** Spectrum getting started/messages: <https://photon.codes/docs/spectrum-ts/getting-started>, <https://photon.codes/docs/spectrum-ts/messages>
* **[P6]** iMessage provider/runtime comparison: <https://photon.codes/docs/spectrum-ts/providers/imessage>
* **[P7]** Content, spaces, replies, typing, and capability semantics: <https://photon.codes/docs/spectrum-ts/content/attachments>, <https://photon.codes/docs/spectrum-ts/spaces-and-users>, <https://photon.codes/docs/spectrum-ts/content/replies>, <https://photon.codes/docs/spectrum-ts/content/typing-indicators>, <https://github.com/photon-hq/skills/blob/main/skills/spectrum/capability-semantics.md>
* **[P8]** Polls/content narrowing: <https://photon.codes/docs/spectrum-ts/content/polls>, <https://photon.codes/docs/spectrum-ts/messages>
* **[P9]** Webhooks and delivery/retry contract: <https://photon.codes/docs/spectrum-ts/webhooks>, <https://photon.codes/docs/webhooks/delivery>
* **[P10]** Outbound attachments: <https://photon.codes/docs/spectrum-ts/content/attachments>
* **[P11]** Grouped content: <https://photon.codes/docs/spectrum-ts/content/groups>
* **[P12]** Cloud GUID attachment fetch: <https://photon.codes/docs/spectrum-ts/providers/imessage/messaging-features/fetching-attachments>
* **[P13]** Photon `heif2jpeg` utility: <https://photon.codes/docs/utilities/heif2jpeg>
* **[P14]** Generic app cards/live editing: <https://photon.codes/docs/spectrum-ts/content/app>
* **[P15]** Customized iMessage Apps: <https://photon.codes/docs/spectrum-ts/providers/imessage/messaging-features/apps>
* **[P16]** Photon pricing and plan capabilities: <https://photon.codes/pricing>
* **[P17]** iMessage effects: <https://photon.codes/docs/spectrum-ts/providers/imessage/messaging-features/message-effects>
* **[P18]** Cloud lines, groups, per-phone routing, quotas: <https://photon.codes/docs/spectrum-ts/providers/imessage/connection-and-routing>
* **[P19]** Photon iMessage provider skill (allowlist detail, tested SDK note): <https://github.com/photon-hq/skills/blob/main/skills/spectrum/providers/imessage.md>
* **[P20]** Provider capability/fallback semantics: <https://github.com/photon-hq/skills/blob/main/skills/spectrum/capability-semantics.md>
* **[P21]** Terminal setup/interactions: <https://photon.codes/docs/spectrum-ts/providers/terminal/setup-and-usage>, <https://photon.codes/docs/spectrum-ts/providers/terminal/interactions>
* **[P22]** Photon create-user API: <https://photon.codes/docs/api-reference/users/create-user>
* **[P23]** Photon users CLI: <https://docs.photon.codes/docs/cli/spectrum>
* **[P24]** Public Photon prize setup, promo code, qualification, and judging: <https://luma.com/eipveunj>
* **[P25]** Webhook verification/signature details: <https://photon.codes/docs/webhooks/verifying-signatures>
* **[P26]** Inbound debounce/cancellation/carry-forward: <https://photon.codes/docs/best-practices/inbound-pipeline>
* **[P27]** Spectrum architecture/recovery/idempotency: <https://photon.codes/docs/best-practices/architecture>, <https://photon.codes/docs/best-practices/recovery-and-state>
* **[P28]** iMessage deliverability: <https://photon.codes/docs/best-practices/imessage-deliverability>
* **[P29]** Photon Spectrum coding skill: <https://skills.sh/photon-hq/skills/spectrum>
* **[P30]** Photon skill source: <https://raw.githubusercontent.com/photon-hq/skills/main/skills/spectrum/SKILL.md>
* **[P31]** Photon skills repository metadata: <https://api.github.com/repos/photon-hq/skills>
* **[P32]** Photon MCP redirect/archive: <https://github.com/photon-hq/mcp>, <https://github.com/photon-hq/mcp-legacy>
* **[P33]** Archived MCP README and tool list: <https://github.com/photon-hq/mcp-legacy#readme>
* **[P75]** Public report of Moonlighting Photon/iMessage Pitch Challenge winner: <https://www.linkedin.com/posts/photonhq_yesterday-photon-co-hosted-the-moonlighting-activity-7495596476601937920-sn8l>
* **[P76]** Public report of HackWithSeattle BEACON top-five placement: <https://www.linkedin.com/posts/aishgupta26_hackwithseattle-hackwithseattle-generativeai-activity-7466262640336506880-GH5c>
* **[P77]** Photon community highlight for naval.chat: <https://photon.codes/weekly-update/may-7-2026>
* **[P78]** Photon community highlight for Hackkey: <https://photon.codes/weekly-update/may-28-2026>
* **[P79]** Browser Web Serial API reference: <https://developer.mozilla.org/en-US/docs/Web/API/Web_Serial_API>
* **[P80]** Photon API request rate limit: <https://photon.codes/docs/api-reference/rate-limit>

### Competitors and tools

* **[P34]** Wokwi MCP docs: <https://docs.wokwi.com/wokwi-ci/mcp-support>
* **[P35]** Wokwi CI/CLI/testing: <https://docs.wokwi.com/wokwi-ci/getting-started>, <https://docs.wokwi.com/wokwi-ci/cli-usage>
* **[P36]** Flux MCP: <https://docs.flux.ai/reference/flux-mcp-server>
* **[P37]** Cirkit Designer: <https://www.cirkitdesigner.com/>
* **[P38]** Cirkit Designer simulation docs and membership: <https://www.cirkitdesigner.com/docs/tutorials/simulating-your-circuit>, <https://app.cirkitdesigner.com/membership>
* **[P39]** Cirkit AI: <https://www.cirkit.ai/>
* **[P40]** Cirkit AI terms: <https://www.cirkit.ai/terms>
* **[P41]** Schematik overview/AI info: <https://www.schematik.io/>, <https://www.schematik.io/ai-info.md>
* **[P42]** Schematik comparison: <https://www.schematik.io/compare/tinkercad-circuits>
* **[P43]** Schematik download: <https://www.schematik.io/download>
* **[P44]** Tinkered circuit design: <https://www.tinkered.ai/circuit-design>
* **[P45]** Tinkered simulation: <https://www.tinkered.ai/simulate>
* **[P46]** Tinkered deployment: <https://www.tinkered.ai/deploy>
* **[P47]** CircuitAI marketing site: <https://www.circuitai.design/>
* **[P48]** CircuitAI small implementation: <https://github.com/KshKnsl/CircuitAI>
* **[P49]** Flux Copilot: <https://docs.flux.ai/flux/reference/copilot>
* **[P50]** Flux SPICE simulator: <https://docs.flux.ai/reference/simulator-tool>
* **[P51]** Wokwi pricing: <https://wokwi.com/pricing>
* **[P52]** Tinkercad Circuits: <https://www.tinkercad.com/circuits>
* **[P53]** Tinkercad Circuits guide: <https://www.tinkercad.com/blog/official-guide-to-tinkercad-circuits>
* **[P54]** Arduino AI Assistant: <https://support.arduino.cc/hc/en-us/articles/19958917855132-About-the-Arduino-AI-Assistant>
* **[P55]** Arduino AI data/RAG and privacy: <https://support.arduino.cc/hc/en-us/articles/19958862731804-Understand-how-the-Arduino-AI-Assistant-works-and-how-it-uses-your-data>
* **[P56]** Arduino AI announcement/pricing examples: <https://blog.arduino.cc/2025/04/17/code-faster-with-the-new-arduino-ai-assistant/>
* **[P57]** circuito.io: <https://www.circuito.io/>, <https://www.circuito.io/app>
* **[P58]** Fritzing overview/download: <https://fritzing.org/>, <https://fritzing.org/download/>
* **[P59]** Fritzing source/license: <https://github.com/fritzing/fritzing-app>
* **[P60]** EasyEDA overview: <https://easyeda.com/>
* **[P61]** ProtoPulse repository/readme: <https://github.com/wtyler2505/ProtoPulse>
* **[P62]** ProtoPulse AI-agent guide/roadmap: <https://raw.githubusercontent.com/wtyler2505/ProtoPulse/main/docs/AI_AGENT_GUIDE.md>
* **[P63]** ProtoPulse MCP config (not a ProtoPulse server): <https://raw.githubusercontent.com/wtyler2505/ProtoPulse/main/.mcp.json>
* **[P64]** CircuitMuse repository/readme: <https://github.com/meshackbahati/circuit-muse>, <https://raw.githubusercontent.com/meshackbahati/circuit-muse/main/README.md>
* **[P65]** CircuitMuse MIT license: <https://raw.githubusercontent.com/meshackbahati/circuit-muse/main/LICENSE>

### Academic systems and physical-prototyping research

* **[P66]** WIRES: <https://arxiv.org/abs/2305.14874>
* **[P67]** CircuitLM paper: <https://arxiv.org/html/2601.04505>
* **[P68]** CircuitLM implementation: <https://github.com/Khandakar227/CircuitLM>
* **[P69]** ChatEDA: <https://arxiv.org/html/2308.10204>
* **[P70]** AutoEDA: <https://arxiv.org/pdf/2508.01012>
* **[P71]** SchemaBoard: <https://make.kaist.ac.kr/files/2020/Kim_SchemaBoard_UIST20.pdf>
* **[P72]** CircuitSense: <https://teyenwu.com/publications/CircuitSense.pdf>
* **[P73]** BlinkBoard: <https://pmc.ncbi.nlm.nih.gov/articles/PMC10844966/>
* **[P74]** WireWay: <https://arxiv.org/pdf/2603.05085>

### Photon public positioning and launch context

* **[P75]** Moonlighting Hackathon winner report (public LinkedIn): <https://www.linkedin.com/posts/photonhq_yesterday-photon-co-hosted-the-moonlighting-activity-7495596476601937920-sn8l>
* **[P76]** HackWithSeattle BEACON report (public LinkedIn): <https://www.linkedin.com/posts/aishgupta26_hackwithseattle-hackwithseattle-generativeai-activity-7466262640336506880-GH5c>
* Photon Spectrum launch/positioning: <https://photon.codes/blog/introducing-spectrum>
* Photon launch and event updates: <https://photon.codes/weekly-update/april-17-2026>, <https://photon.codes/weekly-update/april-24-2026>, <https://photon.codes/weekly-update/may-7-2026>, <https://photon.codes/weekly-update/may-28-2026>
