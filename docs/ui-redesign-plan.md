# ViBread redesign plan — v2 (after plan critique)

Status: **for your review** (Sat Sep 26, ≈15:00 CT). Nothing is built yet. v1 was reviewed by a plan critic; all 18 of its
points are folded in below. Decisions you need to make are in §8.

## 1. Summary

**What changes**
1. **Works like Claude desktop.** Missions are listed in a left sidebar like Claude's sessions. A new mission starts in a
   chat box, not a form. The mission is one conversation: Claude's replies, one-line collapsible rows for each check
   ("Electrical checks · GO"), approval cards, and a slim status bar with the five checks and **GO for build**.
2. **Results in a side panel** (like Claude's artifacts): schematic, build steps, code, tests, Try it, replay, telemetry.
3. **Camera-first parts inventory.** Take photos of your parts → Claude identifies them → ViBread converts what it saw
   into standard catalog entries → you confirm → saved to your inventory. New missions use the inventory automatically.
   Typing parts ("3 red LEDs, 5x 220 ohm") works too and needs no Claude key.
4. **Claude-desktop look**: warm ivory (or warm dark gray) background, terracotta accent, sans-serif interface with a
   serif font for Claude's replies, thin borders instead of shadows.

**What stays**: all features and rules — five checks, GO for build (incl. the "without review" dialog), build steps,
phone Build Mode, bench self-test, simulation, approvals, permission modes, recorded-run labels, iMessage, Claude Code
connection, phone pairing. The Apollo names stay as small labels.

**Effort**: ≈5 h with 6 agents + 1.5 h QA/audit + 1 h re-recording the demo video. Needs a Claude credential for the
scan (see §8).

## 2. Screens

### 2.1 Shell and new mission

```
┌─────────────────┬───────────────────────────────────────────────────────────────────┐
│ ViBread       « │                 Good afternoon. What are we building?              │
│ [+ New mission] │      ┌──────────────────────────────────────────────────────────┐  │
│ ▤ Inventory  23 │      │ A lamp that fills like the moon when I press a button…   │  │
│─────────────────│      │ [Parts: all inventory (23)]   [Review ▾]             (↑) │  │
│ Today           │      └──────────────────────────────────────────────────────────┘  │
│ ● Moon lamp     │        Night light · Traffic light · Reaction game · Doorbell      │
│ ◐ Night light   │        Inventory empty? [Scan your parts]                          │
│ Earlier         │                                                                    │
│ ✓ Launch control│                                                                    │
│─────────────────│                                                                    │
│ ⚙ Settings      │                                                                    │
│ ● Claude ready  │                                                                    │
└─────────────────┴───────────────────────────────────────────────────────────────────┘
```

- Enter creates the mission with the inventory attached; the text becomes the first message. Cmd/Ctrl+N = new mission.
- Status dot per mission (from the 9 mission phases):

| Phases | Dot | Label |
|---|---|---|
| BRIEF, CLARIFY, DESIGN | ● accent | Designing |
| GONOGO | ◐ amber | Ready for GO |
| ASSEMBLE | ▲ blue | Building |
| VERIFY, DEBUG | ◆ blue | Testing |
| LAUNCH | ★ green | Launched |
| DONE | ✓ green | Done |

### 2.2 Mission conversation + panel

```
┌────────┬─────────────────────────────────────────────┬──────────────────────────────┐
│sidebar │ Moon lamp   ●●●●○ checks   [GO for build] ⋯ │ Schematic ▾   r2 ▾   ⤓   ✕  │
│        │─────────────────────────────────────────────│──────────────────────────────│
│        │                   ┌───────────────────────┐ │                              │
│        │                   │ A lamp that fills …   │ │     (schematic drawing)      │
│        │                   └───────────────────────┘ │                              │
│        │ I'll use your 4 yellow LEDs and 220 Ω …     │                              │
│        │ ▸ Design r1 proposed                        │                              │
│        │ ▸ Electrical checks                  GO     │                              │
│        │ ▸ Simulation tests            NO-GO 7/8     │                              │
│        │ ▸ Design r2 proposed        all checks GO   │                              │
│        │ ┌ Release r2 as the build target? ───────┐  │                              │
│        │ │ [Allow once] [Allow for mission] [Deny]│  │                              │
│        │ └────────────────────────────────────────┘  │                              │
│        │ ┌─────────────────────────────────────────┐ │                              │
│        │ │ Reply…                 [Review ▾]   (↑) │ │                              │
│        │ └─────────────────────────────────────────┘ │                              │
└────────┴─────────────────────────────────────────────┴──────────────────────────────┘
```

- **Where rows come from**: the check/release/bench/phase rows are timeline events (console reports, releases, bench
  runs, phase changes), not chat messages. The chat merges them in time order as MUI X Chat custom `data-*` parts
  ([MUI docs](https://mui.com/x/react-chat/display/message-parts/custom-parts/)). This is what makes the 3 example
  missions (which have no chat history) show their story: design r1 → checks → release.
- Every existing feature gets a home:

| Feature | New home |
|---|---|
| Five checks + findings | Header dots (tooltip = Apollo name); click → "Checks" view in the panel |
| GO for build + "without review" dialog | Header button, same rules and dialog |
| Approvals from the agent | Inline card in the chat |
| Approvals from iMessage / Claude Code | Pinned cards above the composer |
| Permission mode + "board actions always wait for you" note | Mode picker in the composer; the note is its help text |
| Agent working / offline / Claude not connected | Small chip in the header |
| Recorded run banner + models | Banner under the header; chips on messages (unchanged) |
| Schematic, steps, code, tests, Try it, replay, telemetry, photo check | Panel views with revision picker |
| Bench | ⋯ menu → Bench (full screen inside the shell, restyled only) |
| Phone link / QR | Build steps view + ⋯ menu |
| Mission complete | Inline card in the chat |
| Settings | Dialog; `/settings` still works as a link and opens it |
| Claude Code sign-in (`/login`, `/consent`) and phone pages (`/b`, `/scan`) | Stay outside the shell |

*Inspiration, not a copy*: Claude desktop's Chat tab opens artifacts in a right-side window; the Code tab uses
arrangeable panes; "Allow once / Always allow / Deny" is Claude Code's site-permission card. [1][3]

### 2.3 Inventory

```
┌────────┬──────────────────────────────────────────────────────────────────────────┐
│sidebar │ Inventory · 23 parts          [📷 Scan parts]  [Type parts]  [+ Add]     │
│        │ LEDs          Red LED            [− 6 +]   ready                    ⋯   │
│        │               Yellow LED         [− 4 +]   ready                    ⋯   │
│        │ Resistors     220 Ω              [− 10 +]  ready                    ⋯   │
│        │               10 kΩ              [− 5 +]   needs a look (10k or 1k?) ⋯   │
│        │ Inputs        Push button        [− 2 +]   ready                    ⋯   │
│        │ Board         Arduino Uno R3     [− 1 +]   ready                    ⋯   │
│        │ Other         Blue 4-pin module  [− 1 +]   not in library           ⋯   │
└────────┴──────────────────────────────────────────────────────────────────────────┘
```

Status words: **ready** (catalog part, used by missions) · **needs a look** (unsure reading, fix before use) ·
**not in library** (kept for reference; used only after you give its pins and role).

## 3. Inventory system

### 3.1 The catalog (the standardized database)

A versioned catalog in code (`packages/core/src/catalog.ts`). Each inventory entry = catalog kind + normalized
parameters. How it maps into a mission (missions keep today's `InventoryItem`, so agents and checks don't change):

| Catalog kind | Parameters | Into a mission as |
|---|---|---|
| LED | color: red, yellow, green, blue, white (same list as the module library) | `led {color}` |
| Resistor | ohms (4-band: E24 · 5-band: E96/E24) | `resistor {ohms}` |
| Push button | — | `button` |
| Light sensor | — | `photoresistor` |
| Knob | ohms (printed code "103" = 10 kΩ, "B10K") | `potentiometer {ohms}` |
| Buzzer | active / passive | `buzzer-active` / `buzzer-passive` |
| Arduino | Uno R3 / Nano | mission board setting (SHOULD); not a part |
| Breadboard | 400 / 830 holes | mission breadboard setting (SHOULD); not a part |
| Jumper wires | type | never copied (assumed available) |
| Other | description + photo crop | `generic` only after you enter role + pinout |

**Identity** = kind + normalized parameters (e.g. `resistor/220`). Unknown LED lens color → "needs a look".

### 3.2 Merge rules

- Review rows show **have 10 → will be 19** with an **Add / Replace** switch per row. Replace is the default when that
  part is already in the inventory (so scanning the same kit twice doesn't double counts — this matters because the
  design agent never uses more than the listed count).
- Editing a part so it matches another existing entry merges them.

### 3.3 Camera scan

**Handoff (laptop ↔ phone)**
1. Laptop: **Scan parts** creates an empty scan (`POST /api/inventory/scans` → id) and shows a QR code to
   `/scan/<id>?pair=…`. Alternatives in the same dialog: **Upload photos** (laptop), **Laptop camera** (SHOULD).
2. Phone: opens the scan page, takes photos with its camera (file input `capture=environment`, already proven in Build
   Mode over the LAN address), each uploaded with `POST …/scans/<id>/photos` (12 MB limit, like the photo check).
3. Phone: **Done** → `POST …/scans/<id>/analyze`.
4. Laptop polls `GET …/scans/<id>`: "Waiting for photos…" → "Reading 2 photos…" → review list. Review also works on
   the phone.
5. Scans still running when the server restarts are marked failed ("Try again").

**Identify** (Claude Sonnet 5, structured output, effort low/medium to keep it fast)
- Photos resized for the high-resolution tier: long edge ≤ 2576 px, ≤ 4784 visual tokens [5]. Crop thumbnails are cut
  from exactly the image Claude saw, with a margin (Claude's boxes are approximate [5]).
- Per group Claude reports only what it sees: kind or "unknown", lens color, band colors left→right, printed code, pin
  count, count, confidence. It never guesses a value.
- Counts are approximate for many small objects [5]: count fields are editable and hinted "may be off". Tips before
  capture: white paper, one kind per group, ≤ 10 per group, spaced apart, good light, photograph each pile once.

**Normalize** (our code, no AI, unit-tested)
- Resistors: decode the bands in both directions; keep values in E24 (4-band) or E96/E24 (5-band). Mark **ready** only
  if exactly one value remains, it's 4-band with a gold/silver end, and Claude was confident; otherwise **needs a look**
  with the candidates in a dropdown. Printed values on tape/bags win. Test: every E24 value round-trips through the
  existing `resistorBands()`.
- Knob codes, color words and text ("220R", "4k7") → catalog values.

**Review** → **Add N parts**. Without a Claude key the Scan button says so and opens **Type parts** instead. Scans are
rate-limited (they spend the owner's key; ≈1–3 ¢ per photo). Photos stay in ViBread's data folder.

### 3.4 Storage and API

- Tables: `inventory_items` (user, identity, kind, params, quantity, source scan/typed/manual) and `inventory_scans`
  (user, photos, status, detections, created).
- Routes: `GET /api/inventory` · `POST /api/inventory/items` (batch add/replace) · `PATCH`/`DELETE
  /api/inventory/items/:id` · `POST /api/inventory/parse` (typed text → preview, no AI) · scans: `POST /scans`,
  `POST /scans/:id/photos`, `POST /scans/:id/analyze`, `GET /scans/:id`, `GET /scans/:id/crops/:n`,
  `POST /scans/:id/accept`.
- Paired phones may use exactly: the `/scan/*` page and the scan routes above (plus what Build Mode already uses). The
  scan route tells the phone when Claude isn't connected.
- **Every channel uses the inventory**: the copy into the mission happens in the mission service (`create`) whenever no
  parts are given — so web, iMessage, Claude Code (MCP) and A2A missions all get it. New read-only MCP tool
  `vibread_get_inventory`.

## 4. Theme

- **Fonts** (bundled, offline, open licenses): **Inter** for the interface and headings (600), **Lora** for Claude's
  replies, **JetBrains Mono** for code/telemetry.
- **No Anthropic logos, spark/asterisk or names**; About says "Not affiliated with Anthropic". Our rocket icon stays.
- **Tokens** (WCAG contrast measured; text ≥ 4.5:1, UI parts ≥ 3:1):

| Token | Light | Contrast | Dark | Contrast |
|---|---|---|---|---|
| main background | `#FAF9F5` | — | `#262624` | — |
| sidebar | `#F0EEE6` | — | `#1F1E1D` | — |
| cards / composer | `#FFFFFF` | — | `#30302E` | — |
| text | `#141413` | 17.5 | `#FAF9F5` | 12.6+ |
| secondary text | `#6B6A63` | 4.7+ | `#B0AEA5` | 6.0+ |
| primary (buttons, links, focus ring) | `#AD4F2D`, white text | 4.6+ / white 5.3 | `#E3896A` links/focus; buttons `#D97757` + `#141413` text | 5.1+ / 5.9 |
| accent (send button, icons only) | `#D97757` | 3.1 on white (graphic) | `#D97757` | 4.2+ |
| success / GO | `#5E7046` | 4.7+ / white 5.4 | `#9DB47F` | 5.8+ |
| info | `#3B6A99` | 4.9+ / white 5.7 | `#8DB6DD` | 6.2+ |
| warning | `#8A5A0B` | 5.1+ / white 5.9 | `#E0B04A` | 6.6+ |
| error / NO-GO | `#B3432F` | 4.8+ / white 5.6 | `#E4806A` | 4.8+ |
| input borders | `#8F8D85` | 3.2+ | `#7A7973` | 3.0+ |
| dividers (decorative) | `#E8E6DC` | — | `#3D3D3A` | — |

- MUI settings: `contrastThreshold: 4.5`; dark `primary.contrastText: #141413`; radius 8 (buttons/inputs), 12 (cards),
  18 (composer); borders instead of shadows; no uppercase buttons; System/Light/Dark switch in Settings.
- **Hard-coded dark colors**: ≈25 places outside `theme.ts` (workspace, chat, tabs, bench, Build Mode, components) get
  theme values. The breadboard/step/Try-it drawings stay as dark "canvas" frames (no re-render, no re-seed).

## 5. Build plan

**Step 0 — contracts (integrator, 30 min)**: catalog + mapping table, inventory/scan types, `CreateMissionRequest`,
routes, component props (`StatusStrip`, `ArtifactPanel`, `Composer`, `ToolRow`, `TimelineRow`), theme tokens.
Shared files (`api/hooks.ts`, `api/client.ts`, `packages/core/src/api.ts`) are integrator-owned.

**Step 0.5 — scan reality check (20 min, needs a Claude credential)**: throwaway script sends 3 real photos of the
team's kit through the scan schema + normalizer. Decides whether scanning is demo-ready.

| Slice | Owns | Work | Est. |
|---|---|---|---|
| S1 Shell + theme | `theme.ts`, `main.tsx`, `shell/*`, `components/*`, Settings dialog | theme + fonts, sidebar, settings dialog, `/settings` route, replace hard-coded colors | 2 h |
| S2 Conversation | new-mission page, `pages/MissionPage.tsx` (mounts S3 parts), `chat/*`, `Composer` | empty state, composer, messages, tool rows, **timeline → chat merge**, approval cards, pinned outside approvals | 2.5 h |
| S3 Panel + status | `workspace/*` | artifact panel + revision picker, status strip, GO button + dialog, checks view, inline mission complete | 2 h |
| S4 Inventory UI | `inventory/*`, phone `/scan` page | inventory table, type/add/edit, scan dialog (QR + upload), review with have→will be | 2.5 h |
| S5 Inventory server | `catalog.ts`, normalizer, server routes/tables, vision scan, phone scope, mission-service snapshot, MCP tool | as in §3 | 2.5 h |
| S6 Restyle | `bench/*`, `build/*` | new theme only, no logic changes | 1 h |
| S7 Desktop (SHOULD) | `apps/desktop` | camera permission for our window only, macOS camera description | 0.5 h |

**Schedule** (if approved at ≈15:30): Step 0 → 16:00 · slices 16:00–20:30 · **gate at 19:00**: if phone → review
doesn't work end to end, ship laptop upload + typed entry and drop phone scanning to SHOULD · QA + audit 20:30–22:00 ·
re-record demo video Sun morning (1 h) · submit by 11:00.

**MUST**: everything in the table except S7. **SHOULD**: laptop live camera, per-mission part subset, board/breadboard
from inventory, photo attachments in the composer, sidebar search, drag-resize panel, starter-kit presets.
**Cut**: merging duplicates across photos, barcode, online part databases, drag-and-drop panes.

## 6. Done when (measurable)

1. Empty state → Enter → conversation opens with the brief as the first message and the inventory as parts.
2. Each example mission shows its timeline rows (design r1 → checks → release) in the chat.
3. Approval cards (3 choices) and GO for build work exactly as today; bench virtual self-test and phone Build Mode pass.
4. Kit photo: ≥ 80 % of groups get the right kind, and every resistor is either correct or "needs a look".
5. Phone: pair → `/scan` → 2 photos → review on the laptop in ≤ 60 s.
6. No key: phone `/scan` explains it; Type parts works; iMessage/MCP missions get the inventory.
7. Contrast unit test over the token pairs passes; a search for hex colors outside `theme.ts` finds only the approved
   drawing canvases.
8. `npm test` + `npm run typecheck` green; one clean audit round.

## 7. Risks

| Risk | Plan |
|---|---|
| Time; the demo video must be re-recorded | MUST list ≈5 h; 19:00 gate; SHOULDs dropped first |
| Resistor bands from photos are unreliable | strict "ready" rule; mandatory review; printed labels preferred |
| No working Claude credential yet (omp login lost at 12:31) | Step 0.5 blocked until you log in or give an API key |
| MUI X Chat (alpha) styling limits | composer is our own MUI component; custom parts for rows |
| Regressions in bench / Build Mode | restyle only; existing tests + QA |

## 8. Decisions for you

1. **Go ahead now?** (The redesign replaces today's screens; the demo video must be re-recorded after it.)
2. **Claude credential**: run `omp login anthropic` in the container or give an Anthropic API key — needed for scanning
   and Step 0.5.
3. **Theme default**: follow the computer's light/dark setting (like Claude desktop) or always light?
4. **Scan priority**: phone + upload MUST, laptop live camera SHOULD — OK?
5. **Board and breadboard from the inventory** (Uno/Nano, 400/830): SHOULD — OK?

## Sources

[1] Claude Code Docs, *Desktop application* — https://code.claude.com/docs/en/desktop ·
[2] *Choose a permission mode* — https://code.claude.com/docs/en/permission-modes ·
[3] Claude Help Center, *What are artifacts and how do I use them?* — https://support.claude.com/en/articles/9487310 ·
[4] Anthropic brand-guidelines skill (palette reference) — https://github.com/anthropics/skills/blob/main/skills/brand-guidelines/SKILL.md ·
[5] Claude API Docs, *Vision* (resolution tiers, counting and coordinate limits) — https://platform.claude.com/docs/en/build-with-claude/vision
