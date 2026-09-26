# ViBread Slice 07 — assembly visuals

## 1) Scope

This slice covers the path from a checked circuit netlist to a physically plausible solderless-breadboard layout, an ordered assembly guide, interactive desktop/mobile visuals, and PNGs suitable for iMessage/MMS. The target is an Arduino Uno R3/Nano-class build, with the board choice still a runtime input rather than a constant. A layout is considered correct only when its *derived* hole-level connectivity is equivalent to the source netlist; a pretty drawing is not evidence of correctness.

The report intentionally does **not** copy Fritzing, Trigger-Action-Circuits (TAC), or another existing project. Those projects are cited as prior art. The proposed layout kernel, footprint records, SVG renderer, instruction data, and MCP server remain ViBread code written for this weekend. Existing libraries are recommended only where they are dependencies with a compatible license and a bounded API.

**Decision in one line:** BUILD a small, deterministic, netlist-first 2-D layout/LVS kernel and custom SVG renderer; USE Wokwi Elements only for compatible board/part glyphs; USE `@resvg/resvg-js` for the default PNG path; WRAP Fritzing only as an optional import/export boundary, never as ViBread's source of truth.

## 2) Industry standard and prior art

### 2.1 Source of truth: netlist, footprint, and derived views

Professional EDA tools separate logical connectivity from physical presentation. Wokwi's documented `diagram.json` has separate `parts` and `connections`, with coordinates/rotation as presentation fields and orthogonal wire-placement instructions as optional geometry ([Wokwi diagram format](https://docs.wokwi.com/diagram-format)). Fritzing similarly stores part metadata and connector/bus definitions separately from up to four SVG views (breadboard, schematic, PCB, and icon); connector SVG element IDs are referenced by the part metadata ([Fritzing part-file format](https://github.com/fritzing/fritzing-app/wiki/2.1-Part-file-format)). Fritzing synchronizes breadboard, schematic, and PCB views, but that synchronization does not make a screenshot a netlist ([Fritzing Project View](https://fritzing.org/learning/get-started/project-view)).

ViBread should therefore persist:

1. **Logical IR:** component instances, pin identities, named nets, electrical roles, voltage/current constraints, and NC markers.
2. **Footprint library:** exact hole offsets, body keep-outs, orientation/polarity cues, permitted rotations, and component-specific assembly notes. A “5-mm LED” or “TO-92 transistor” is not a sufficient footprint key because lead-forming and pin order vary by part.
3. **Board geometry:** hole coordinates and the board's internal electrical equivalence classes (terminal strips, segmented power rails, channel boundaries).
4. **Layout:** a mapping from each physical pin to a hole, explicit jumper paths, optional rail bridges, and a canonical score/diagnostic record.
5. **Instruction steps:** immutable snapshots or deltas over the layout, each linked to logical parts/nets and test checkpoints.
6. **Derived connectivity:** a union-find result computed from board contacts, component pin occupancy, rail bridges, and jumper paths.

The SVG, PNG, animation, and mobile card are all *derived views*. Re-rendering the same canonical layout with the same theme must be deterministic.

### 2.2 Solderless-breadboard geometry and style conventions

The following are common, but must be encoded as board profiles rather than assumed globally:

| Feature | Common geometry/convention | Implementation consequence |
|---|---|---|
| Hole pitch | 0.1 in / 2.54 mm ([SparkFun breadboard anatomy](https://learn.sparkfun.com/tutorials/how-to-use-a-breadboard/all:raw), lines 669–675; [BusBoard BB400 datasheet](https://www.busboard.com/documents/datasheets/BPS-DAT-(BB400)-Datasheet.pdf)) | Store integer `(column,row)` coordinates; render in pitch units. |
| Main terminal strip | Five clips per side of the centre ravine; the two sides of a row are electrically isolated ([SparkFun](https://learn.sparkfun.com/tutorials/how-to-use-a-breadboard/all:raw), lines 675–681) | A full visual row is two distinct electrical groups: A–E and F–J, not ten connected holes. |
| Centre channel | A ravine isolates A–E from F–J and accepts DIP packages ([SparkFun](https://learn.sparkfun.com/tutorials/how-to-use-a-breadboard/all:raw), lines 677–681, 699–707) | DIP footprints should straddle the channel; the channel itself is a keep-out. |
| Full/half variants | BusBoard BB830 has 630 IC-area tie points plus four 50-point rail strips; BB400 has 300 IC-area points plus four 25-point rail strips ([BB830](https://www.busboard.com/documents/datasheets/BPS-DAT-(BB830)-Datasheet.pdf); [BB400](https://www.busboard.com/documents/datasheets/BPS-DAT-(BB400)-Datasheet.pdf)). Many retail “full” boards expose 63 rows and “half” boards 30 rows, but rail segmentation and row counts vary by manufacturer ([SparkFun product descriptions](https://learn.sparkfun.com/tutorials/how-to-use-a-breadboard/all:raw), lines 247–279). | Board profile must name every rail segment and terminal group. Never infer continuity from a red/blue stripe. |
| Power rails | Rails are commonly vertical and labeled `+`/`-`, red/blue/black, but left and right rails are normally not connected; some rails are split midway ([SparkFun](https://learn.sparkfun.com/tutorials/how-to-use-a-breadboard/all:raw), lines 683–697). | Treat `5V`, `3V3`, and `GND` rails as separate segments. Add explicit jumpers only when the profile says they are needed. |
| Wiring style | CircuitStyle's instructor study identifies useful practices: polarity before insertion, ICs first, power last, use rails, avoid wires over ICs, use as little wire as possible, lay wires/components flat, and check split rails ([CircuitStyle paper](http://www.sfu.ca/~xingdong/papers/CircuitStyle.pdf), Table 1). | Style is a routing objective and an instruction checklist, not merely decoration. |
| Color convention | Red for positive/power and black/blue for ground is common practice, but color is not electrically authoritative ([SparkFun](https://learn.sparkfun.com/tutorials/how-to-use-a-breadboard/all:raw), lines 691–697; [Wokwi editor](https://docs.wokwi.com/guides/diagram-editor) auto-selects black for ground, red for 5 V, and green for other wires). | Store a semantic wire role plus a color/pattern. Render labels and endpoint names so color can never be the only cue. |

**Footprints to encode, not guess:**

- A common 5-mm through-hole LED is available with 2.54-mm lead spacing (for example, the [Kingbright WP7113SYTKTNR254 datasheet](https://www.kingbrightusa.com/images/catalog/SPEC/WP7113SYTKTNR254.pdf)). Its footprint record must also identify anode/cathode and the chosen lead-form. ViBread should show `A`/`K`, `+`/`−`, and a flat-edge cue instead of relying on a red/green fill; the physical cues are documented by [Arduino](https://support.arduino.cc/hc/en-us/articles/360021532580-How-are-the-LEDs-represented-in-the-Starter-Kit-projects-book) and [SparkFun](https://learn.sparkfun.com/tutorials/light-emitting-diodes-leds/all).
- Axial resistors are non-polarized, but the usable hole span depends on the lead-form and body length. The renderer may draw resistor color bands from the value, but the placer must use a selected footprint span, not “resistor = two adjacent holes.” The band semantics are documented by [SparkFun's resistor guide](https://learn.sparkfun.com/tutorials/resistors/decoding-resistor-markings) and normatively by [IEC 60062](https://webstore.iec.ch/en/publication/25395).
- A 6×6-mm through-hole tactile switch has four terminals and several variants; the [Schurter datasheet](https://www.schurter.com/en/datasheet/typ_6x6_mm_tact_switches.pdf) shows through-hole dimensions and 4.5/7.0-mm drilling dimensions for variants. A typical four-pin tact switch is a candidate for straddling the centre channel, but the exact two-pin electrical grouping and body orientation must come from the selected switch footprint, not from the “6 mm” label.
- TO-92 lead order is device-specific. NXP's [SOT54/TO-92 package page](https://www.nxp.com/packages/SOT54) documents a 2.54-mm lead pitch, while individual part datasheets define pin order and lead forming. Store `pinOrder` and the visible flat-side/orientation cue per part.
- Standard DIP packages use 0.1-in pin pitch; common row spacing is 0.3 in or 0.6 in. A representative 3M DIP data sheet documents 0.100-in pitch and 0.300-in row spacing ([3M DIP series](https://media.digikey.com/pdf/Data%20Sheets/3M%20PDFs/3000_Series_100_Dip.pdf)). The board profile must verify that the package width fits its centre channel.
- Pots and modules are not one universal footprint. A breadboard trimmer can use 0.1-in pin spacing (example data sheet: [Farnell 356](https://www.farnell.com/datasheets/1734496.pdf)), while a larger panel potentiometer may use 0.2 in. Breakout/module headers are often 2.54 mm; the [Arduino UNO breakout carrier](https://store.arduino.cc/products/uno-breakout-carrier) is one official example. A footprint record must include header pitch, pin order, body keep-out, and whether a header is populated.

### 2.3 Breadboard placement/routing prior art

**Fritzing.** Fritzing has a breadboard view and a PCB autorouter, but its official project documentation describes autoroute under PCB view ([Project View](https://fritzing.org/learning/get-started/project-view)). Its router announcement describes a Manhattan/tiled PCB router with DRC, bounded routing attempts, rudimentary rip-up-and-reroute, jumper placement, and no shortest-path guarantee ([Fritzing “A new autorouter”](https://blog.fritzing.org/2011/02/11/a-new-autorouter)). This is useful router prior art, but it is not a breadboard placement algorithm and the Fritzing forum documents that breadboard view requires manual wiring ([forum discussion](https://forum.fritzing.org/t/routing-in-breadboard/495)). Do not make Fritzing's GPL application or CC-BY-SA part artwork a ViBread runtime dependency for the core path.

**Trigger-Action-Circuits (TAC).** TAC generates multiple Arduino-compatible candidate circuits, firmware, diagrams, and assembly instructions from high-level trigger/action behavior. It keeps terminal-to-terminal connections and uses a lookup table to generate connection text; its component database stores terminal locations, types, sharing, and assembly hints ([TAC UIST 2017 paper](https://www.research.autodesk.com/app/uploads/2023/03/trigger-action-circuits-leveraging.pdf_recJhQeai7lWIR6C9.pdf), especially pp. 4–8). TAC's user study showed a large novice benefit over an Arduino baseline, but the paper also states that generated diagrams/code were not optimized for learnability and that debugging attribution remained difficult. The relevant lesson is the end-to-end linkage of behavior → circuit → firmware → instructions, not copying TAC's implementation.

**Automatic Protoboard Layout from Circuit Schematics (Mekonnen, MIT 2014).** The MIT repository abstract explicitly describes automatic schematic-to-protoboard generation solved using A* search ([MIT DSpace record](https://hdl.handle.net/1721.1/91847)). This is the closest direct algorithmic precedent. The exact thesis implementation details should not be treated as a drop-in library; the report below uses the high-level idea—discrete placement plus a costed grid search—and specifies a smaller deterministic kernel suitable for a 36-hour build.

**SchemaBoard.** SchemaBoard maintains a schematic-to-breadboard mapping, lights rows under a physical breadboard, and has a solver that allocates power/ground rows, places components such as DIPs, assigns rows for nets, and minimizes jumper count ([SchemaBoard UIST 2020 paper](https://make.kaist.ac.kr/files/2020/Kim_SchemaBoard_UIST20.pdf), pp. 5–7). Its formative study found that pictorial diagrams were direct for placement while schematics were better for reasoning and inspection; its evaluation found faster assembly and much easier inspection with linked in-situ guidance. ViBread should expose both views and link them, rather than forcing users to choose one.

**VirtualWire.** VirtualWire translates a Fritzing/Eagle design into a physical switching-matrix breadboard. Its solver assigns DIP packages first, then assigns remaining nets to rows using a simple random heuristic and emits JSON descriptors ([VirtualWire TEI 2021 paper](https://make.kaist.ac.kr/files/2021/Lee_VirtualWire_TEI21.pdf), pp. 4–6). It reports 37% less assembly time and 53% fewer errors in its specific instrumented-hardware study. The net-to-row abstraction is useful; randomness is not acceptable for ViBread because a regenerated guide must not move the user's target holes.

**AutoFritz.** AutoFritz is autocomplete rather than a global placer: it uses datasheet schematics and thousands of Fritzing projects to suggest supporting components, modules, and wire connections ([AutoFritz CHI 2019 paper](http://www.sfu.ca/~xingdong/papers/AutoFritz.pdf)). It reports fewer errors and lower mental effort in a 16-person study. It supports a future “suggest a missing resistor/driver” layer, but it cannot replace deterministic footprint placement and LVS.

**Circuito.io.** Circuito.io's own design guide describes generated schematics, code, parts lists, and step-by-step wiring; it explicitly says that no circuit-design tool can wire a physical breadboard for the user ([Circuito.io design guide](https://www.circuito.io/blog/circuit-design/)). Treat it as commercial prior art for generated instructions, not as a dependency or a claim that auto-layout is solved.

**Wokwi and Tinkercad.** Wokwi's editor is manual: a new part is placed at `(0,0)` and dragged, parts rotate with a key, and wires are created by selecting pins; its default grid is 2.54 mm with an optional 1.27-mm fine grid ([Wokwi editor](https://docs.wokwi.com/guides/diagram-editor)). Its wire data supports horizontal/vertical placement instructions and semantic default colors ([Wokwi diagram format](https://docs.wokwi.com/diagram-format)). Tinkercad's official wire-options announcement describes manual hookup/alligator-wire options, not an end-to-end breadboard autorouter ([Tinkercad wire options](https://www.tinkercad.com/blog/new-wire-options-in-tinkercad-circuits)). Both are useful UX references for direct manipulation and grid snapping, not automatic-layout engines.

### 2.4 Proposed deterministic placement + routing algorithm

This is the proposed ViBread kernel. It is deliberately bounded, explainable, and deterministic rather than an ML or general PCB optimizer.

#### Data structures

```ts
type BoardProfile = {
  id: string; pitchMm: 2.54; holes: Hole[];
  internalGroups: { id: string; holes: HoleId[]; role?: "terminal" | "rail" }[];
  channel: { left: ColRange; right: ColRange; keepout: Rect };
  railSegments: { id: string; holes: HoleId[]; labels: string[] }[];
  externalPins: ExternalPin[]; // Uno/Nano headers, etc.
};

type Footprint = {
  id: string; rotations: Rotation[]; pins: PinOffset[];
  bodyKeepout: Rect; leadKeepout?: Rect[]; pin1?: PinId;
  polarity?: { positive: PinId; negative: PinId; cue: string };
  rules?: { mustStraddleChannel?: boolean; preferredRail?: string; maxLeadSpan?: number };
};

type Net = { id: string; pins: PinRef[]; role: "power" | "ground" | "signal" | "analog" | "nc"; aliases?: string[] };
type Placement = { componentId: string; footprintId: string; rotation: Rotation; pinHoles: Record<PinId, HoleId>; bodyKeepout: Rect };
type Jumper = { id: string; netId: string; holes: HoleId[]; points: Point[]; colorRole: string; lane: number };
type Layout = {
  boardId: string; placements: Placement[]; jumpers: Jumper[];
  railBridges: Jumper[]; derivedNets: DerivedNet[]; score: Score; diagnostics: Diagnostic[];
};
```

The important design choice is that `Hole` has both geometric coordinates and an electrical-group identity. Never re-derive electrical continuity from screen proximity.

#### Step-by-step algorithm

1. **Normalize and validate.** Canonicalize component/net/pin IDs; expand aliases; reject duplicate pins, missing footprints, unknown board IDs, illegal NC connections, impossible voltage roles, and a footprint whose pin offsets cannot land on the board grid. Sort all IDs lexicographically. Emit a useful failure instead of inventing a part or silently dropping a pin.
2. **Build the board graph.** Create a graph node for every hole and a zero-cost internal edge for each board contact group. Create separate rail-segment nodes; do not join split rails unless the profile says so. Add external MCU pin nodes and their declared header/adapter geometry.
3. **Derive placement domains.** For each component and each permitted rotation, enumerate all translations whose pin offsets land on valid holes, whose body/lead keep-outs stay in bounds, and whose pin-1/polarity rule is satisfiable. Pre-filter domains by channel/rail rules. A 4-pin tact switch, DIP, or module may have a much smaller domain than a resistor.
4. **Reserve rails and anchors.** Assign `GND`, `5V`, and `3V3` to explicit rail segments by board-profile preference. If the logical net needs both sides, add a required rail bridge as a normal jumper candidate. Place external board connectors and DIP/large-module anchors first. For Nano, use its actual two-header footprint; for Uno R3, model the Uno as an external board and route from its header pins. For R4/ESP32/Pico, select a different board profile and voltage map.
5. **Place high-constraint parts first.** Order components by descending `(domain size penalty, pin count, body area, net degree, polarity/straddle constraints)`, then by canonical component ID. For each component, score every candidate by: (a) new same-net adjacency, (b) distance to its connected anchors/rail, (c) body/lead clearance, (d) distance to the board centre, (e) future route congestion, and (f) style penalties for crossing the channel incorrectly, hiding a DIP, or cramming a region. Use fixed integer weights and lexicographic tie-breaking `(score, row, col, rotation, componentId)`.
6. **Bounded backtracking.** Keep the best `K` partial assignments (for a hackathon implementation, `K=8` is enough to avoid a single greedy dead end). Reject any partial assignment that already puts pins from different logical nets in the same board contact group, violates a keep-out, or makes a constrained component's remaining domain empty. If no complete assignment exists, report the first blocking components/nets and suggest a larger board or alternate footprint; do not output an apparently valid but electrically wrong picture.
7. **Connect within terminal strips.** After placement, union same-net pins that share a board contact group. For a multi-pin net, prefer one shared strip plus short jumpers over many parallel long wires. Never use a board strip as a “free wire” between two target nets; the strip's group identity is authoritative.
8. **Route remaining net terminals.** For each net, build a deterministic terminal tree starting with its lexicographically smallest terminal and repeatedly attach the nearest unconnected terminal. Route each attachment with A* over hole/waypoint cells. Moves are cardinal only. Obstacles are component bodies, lead keep-outs, existing jumpers of another net, and forbidden channel/rail cells. Cost is `wireLength + 4*bends + 20*crossings + 10*overComponent + 5*extraLane`; a crossing with another net is initially infinite. Allow an existing same-net path as a zero/low-cost node so branches share cleanly.
9. **Route order and rip-up.** Route power/ground trunk/bridges first, then high-degree nets, then ordinary signals, sorting ties by net ID. If a net cannot route, rip up the route with the largest detour/crossing penalty among already-routed signals, route the blocked net, then retry the ripped net. Limit retries and keep the best complete layout. This borrows the useful bounded rip-up idea from Fritzing's PCB router ([Fritzing router notes](https://blog.fritzing.org/2011/02/11/a-new-autorouter)) without copying its code or assuming PCB layers.
10. **Renderable wire normalization.** Collapse collinear segments, add a small fixed lane offset for parallel signal jumpers, and emit 90-degree bends only. Keep power/ground rails visually distinct; route signal wires around rather than across DIP bodies. Every jumper endpoint must be a hole or external pin, and every screen endpoint must resolve back to a `HoleId`.
11. **Score and explain.** Record total wire length, bends, crossings, occupied rows, rail bridges, body overlaps, unused capacity, and style violations. Include per-net route diagnostics and the exact tie-break path so an agent can explain why a component moved.
12. **Plan instructions.** Generate steps from the final layout: inventory/preflight → power-off warning → external board/large anchors → DIPs/modules → passive/polarized parts → short signal jumpers → rail bridges → power last → test checkpoints. Group functionally coupled items only when the group remains one obvious action. Each step references concrete component IDs and hole labels.
13. **Determinism check.** Serialize a canonical layout, hash it, and rerun the kernel with the same inputs. A different hash is a bug. If the user locks a placement, retain it as a hard constraint and re-run only the affected neighborhood; never silently move locked parts.

This is intentionally less general than an industrial PCB router. It targets the small Arduino/breadboard circuits expected in the demo and exposes a controlled “no solution” result rather than an opaque optimizer.

#### LVS: re-derive the netlist from hole occupancy

LVS is a graph computation over the proposed physical layout:

1. Start a union-find over every board contact group and every external pin node.
2. Union all holes that the `BoardProfile` says are internally connected (A–E strips, F–J strips, and each *individual* rail segment).
3. For each placement, union `component.pin` with its mapped hole. If two component pins land in one contact group, that is legal only when both pins belong to the same target net; otherwise emit a hard short.
4. For every jumper, union adjacent holes along its path and union the endpoints. Validate that every path segment is cardinal, in-bounds, and not over a forbidden keep-out.
5. Collect connected components. Each component becomes a derived net signature: sorted `componentId.pinId` members plus external pins and rail aliases.
6. Canonicalize target and derived signatures by aliasing declared power names (`VCC`, `5V`, `+5V`) only when the board profile permits them. Compare as hypergraphs, not as ordered wire lists.
7. Report: **split net** (one target net became multiple derived components), **merged/shorted nets** (one derived component contains pins from multiple target nets), **floating pin**, **unmapped pin**, **duplicate occupancy**, **illegal rail bridge**, **unknown board/footprint**, and **NC violation**. Explicitly elevate a derived component containing `GND` and a positive supply to a critical short.
8. Return both target and derived sets in the MCP response so a user can inspect the mismatch. LVS proves topology only; it does not prove component value, contact pressure, signal integrity, current safety, or correct firmware. ERC/electrical simulation and MCU self-tests remain separate stages.

A minimal regression suite should include: a correct LED+resistor, a split net caused by one missing jumper, a merged net caused by placing a pin across the wrong 5-hole strip, a split power rail, a duplicate hole occupancy, and an intentional same-net branch. The tests should assert exact diagnostics, not just `not throw`.

### 2.5 Assembly-instruction design research and checklist

#### Agrawala et al. principles

Agrawala et al. derive instruction design from cognitive experiments and explicitly treat planning and presentation as a coupled problem ([SIGGRAPH 2003 paper](https://graphics.stanford.edu/papers/assembly_instructions/assembly.pdf)). Their principles are directly applicable to a breadboard:

- People represent assemblies hierarchically; group functionally or perceptually related parts.
- Use a sequence of diagrams rather than one overloaded picture.
- Show at most one significant part per step, while allowing several small fasteners/accessories when they are one action.
- Avoid repeating identical operations indefinitely; show a few examples, then summarize.
- Structural diagrams show final positions, but action diagrams separate new parts and use guides to show attachment; action diagrams were more effective for their furniture task.
- Keep new parts visible and preserve enough of the prior assembly for context.
- Use a natural, stable orientation; reorient when a later part would otherwise be hidden.

The paper's LEGO-car example also notes that LEGO-style structural diagrams work partly because many LEGO connections have a consistent fastening convention; breadboard pins and polarity are less forgiving, so ViBread should use action-like overlays for pins/wires even if the overall page feels LEGO-like.

#### Checklist for ViBread steps

**Before step 1**

- [ ] Identify user level (`novice`, `intermediate`, `expert`) and board model.
- [ ] Show a component inventory with quantity, reference designator, value, and an icon/photo; include a “check these exact parts” step.
- [ ] State board orientation and the coordinate legend (`row 1`, `a–e`, `f–j`, rail names).
- [ ] Warn: unplug USB/battery while placing; connect power only in the final power step. CircuitStyle's instructors ranked polarity, unpowered changes, IC part number, subsections, and power-last behavior highly ([CircuitStyle](http://www.sfu.ca/~xingdong/papers/CircuitStyle.pdf)).

**Every placement step**

- [ ] One logical action or one tightly coupled functional group.
- [ ] List *new* parts and quantities beside the step number, LEGO-style; the official LEGO instruction corpus visibly calls out per-step quantities/parts ([example LEGO PDF](https://www.lego.com/cdn/product-assets/product.bi.additional.main.pdf/71380_01_Build_Main.pdf)).
- [ ] Highlight new parts with a shape/outline and a text label; dim completed parts without removing enough context to orient the user.
- [ ] Show exact hole endpoints (`R1 pin 1 → row 12, column e`) and part reference IDs in text as well as on the image.
- [ ] Show pin 1, cathode/anode, diode stripe, capacitor negative, transistor flat-side/pin order, and module pin names redundantly. Never rely on a fill color or a tiny silhouette.
- [ ] Keep the camera/board viewpoint stable. Reorient only when it materially improves visibility; announce the flip/rotation and preserve the coordinate legend.
- [ ] Show a ghost/exploded lead overlay where a new part enters the holes. Use an attachment guide from the lead to the hole pair, borrowing Agrawala's action-diagram idea.
- [ ] For symmetric/repeated parts, explain the pattern once and show the first two concrete placements; summarize subsequent identical placements rather than silently skipping them.

**Every wiring step**

- [ ] One wire/net branch per step unless several short branches are one unmistakable operation.
- [ ] State both endpoints with ref/pin and board coordinate; include net name (`GND`, `D7_LED1`, etc.).
- [ ] Animate/highlight only the current path; show the final path as a static line so phone users can still follow it.
- [ ] Render role color *plus* net label, endpoint names, dash/shape pattern, or a numbered wire badge. WCAG 1.4.1 forbids color as the sole information channel ([W3C Use of Color](https://www.w3.org/WAI/WCAG21/Understanding/use-of-color)); for controls and state markers target 3:1 non-text contrast ([W3C Non-text Contrast](https://www.w3.org/WAI/WCAG21/Understanding/non-text-contrast.html)).
- [ ] Keep wires short and flat, route around ICs rather than over them, avoid crossings, and show any required rail bridge explicitly. These are instructor-derived readability/error-reduction conventions, not electrical laws ([CircuitStyle](http://www.sfu.ca/~xingdong/papers/CircuitStyle.pdf)).

**After each functional subsection**

- [ ] Run a checkpoint: LVS/occupancy check, then the board's MCU self-test or a simple continuity/expected-signal test.
- [ ] Tell the user what a pass looks like and what a failure means; offer “design vs code vs wiring” next actions.
- [ ] Do not let the guide make the user continue past a known failed checkpoint without an explicit override.
- [ ] Keep a “why this matters” disclosure optional. Novices get the explanation; experts can collapse it.

ElectroTutor provides direct precedent for this checkpoint model: its test-driven tutorials attach physical/software/knowledge tests to individual steps and found substantially less backtracking in the test-driven condition ([ElectroTutor UIST 2018](https://www.benlafreniere.ca/assets/papers/Warner_-_UIST2018_-_ElectroTutor.pdf), pp. 3–8). SchemaBoard also supports a guide mode that places components first, then wires, and can finish by highlighting all derived nets ([SchemaBoard](https://make.kaist.ac.kr/files/2020/Kim_SchemaBoard_UIST20.pdf), pp. 5–7).

**Skill-level personalization**

- **Novice:** use one action per card, inventory photos, glossary tooltips, animated placement, explicit polarity/rail explanations, and an automatic test after each subsection.
- **Intermediate:** group obvious passives, show net names and route rationale, make the schematic/breadboard toggle prominent, and make tests runnable on demand.
- **Expert:** default to schematic + compact coordinates, expose the canonical JSON/netlist, allow locked placements/route preferences, and show raw LVS diffs.
- **All levels:** keep the same canonical layout and electrical truth; personalize exposition, grouping, animation speed, and optional explanations, not the physical connectivity. This is a ViBread design rule [INFERENCE] grounded by TAC's warning that automation can isolate users from how a circuit works ([TAC](https://www.research.autodesk.com/app/uploads/2023/03/trigger-action-circuits-leveraging.pdf_recJhQeai7lWIR6C9.pdf)) and ElectroTutor's explicit discussion of adaptive tests ([ElectroTutor](https://www.benlafreniere.ca/assets/papers/Warner_-_UIST2018_-_ElectroTutor.pdf)).

### 2.6 Rendering stack decision

#### Browser visuals

**BUILD:** a pure TypeScript data-to-SVG renderer owned by ViBread. Each board hole, internal contact group, footprint, jumper segment, highlight, and label is emitted from the canonical `Layout`; React owns interaction/state around the SVG. SVG is appropriate for a small grid because it preserves crisp geometry at phone zoom, exposes hit regions and labels, and can be serialized for server-side export. Use CSS for styling, `prefers-reduced-motion`, and simple opacity/stroke animations. Add Motion (`motion`, formerly Framer Motion) only if React layout/gesture transitions become tedious; its repository is MIT ([Motion docs](https://motion.dev/docs/react), [Motion license](https://github.com/motiondivision/motion/blob/main/LICENSE.md)).

**USE selectively:** `@wokwi/elements` is an MIT TypeScript Web Components package that provides presentation-only electronics glyphs, not simulation ([Wokwi Elements README](https://github.com/wokwi/wokwi-elements/blob/main/README.md)). Its current source exports Uno, Nano, ESP32, LEDs, resistors, buttons, potentiometers, sensors, displays, motors, and other peripherals ([source exports](https://raw.githubusercontent.com/wokwi/wokwi-elements/main/src/index.ts)). It does **not** export a breadboard element; the open issue specifically reports that the simulator's breadboard is absent from the public source/catalog ([issue #172](https://github.com/wokwi/wokwi-elements/issues/172)). Wrap supported elements behind a ViBread `PartGlyph` adapter, and draw the board, holes, wires, and unsupported modules ourselves.

**DO NOT use Fritzing artwork in the core renderer.** Fritzing source code is GPLv3 and its part graphics/documentation are CC-BY-SA 3.0 ([Fritzing README/licensing](https://github.com/fritzing/fritzing-app), [parts license](https://raw.githubusercontent.com/fritzing/fritzing-parts/develop/LICENSE.txt)). CC-BY-SA output/assets would create attribution/share-alike obligations, and GPL runtime coupling is unnecessary. ViBread may optionally accept a user-provided Fritzing file through an isolated importer or invoke an installed Fritzing process, but should not vendor/copy Fritzing parts or reproduce its visuals.

#### 3-D trade-off

Three.js and React Three Fiber are MIT ([Three.js license](https://raw.githubusercontent.com/mrdoob/three.js/dev/LICENSE), [R3F license](https://raw.githubusercontent.com/pmndrs/react-three-fiber/master/LICENSE)). A 3-D scene could make a rotated board or module easier to understand and would support an attractive future “turn the board over” interaction. It is the wrong default for the 36-hour path: every supported module needs a model, camera/lighting work complicates mobile and PNG output, WebGL screenshots are less deterministic, and screen-reader/text alternatives still have to be authored. **Recommendation: BUILD 2-D SVG first; defer 3-D to a separate optional viewer whose canonical data is still the same `Layout`.**

#### Component-specific rendering

- **Resistor:** parse 4/5/6-band values according to the selected value/tolerance and IEC/SparkFun conventions; draw bands as separated rounded rectangles, orient the tolerance band with a larger gap, and print `R1 220 Ω ±5%` next to it. The text/value is mandatory because colors alone are inaccessible and photographs/PNG compression can distort bands.
- **LED/diodes:** render anode/cathode labels, `+`/`−`, a flat-edge/cathode silhouette cue, and a pulsing current-direction overlay only when animation is enabled. Use a clear `A`/`K` pin label and an orientation arrow; cite the physical cue in the instruction tooltip ([Arduino LED guidance](https://support.arduino.cc/hc/en-us/articles/360021532580-How-are-the-LEDs-represented-in-the-Starter-Kit-projects-book)).
- **DIP/IC:** render pin numbers, pin-1 notch/dot, channel span, and a highlighted “straddle centre channel” placement outline.
- **Power rails:** render segment IDs and a visible break marker for split rails, even when the board's plastic printing is ambiguous.

Add `<title>`, `<desc>`, `aria-label`, and keyboard-focusable hit regions to interactive SVG parts. W3C's SVG accessibility guidance recommends textual equivalents for SVG graphics ([SVG accessibility](https://www.w3.org/TR/SVG-access/); [SVG-AAM](https://www.w3.org/TR/svg-aam/)). Use WCAG contrast checks and an additional shape/label/pattern channel; ColorBrewer is a useful source of color-vision-safe palettes ([ColorBrewer](https://colorbrewer2.org/)).

#### PNG export

| Backend | Use | Fidelity/speed trade-off | License/notes |
|---|---|---|---|
| `@resvg/resvg-js` | **Default** for `export_png` | Native Rust renderer, custom/system fonts, crop/scale/background, and a deterministic static-SVG path; README includes a Node example and a sample benchmark. It does not execute browser animation/DOM/CSS behavior, so inline all styles/assets and export a frozen frame ([README](https://raw.githubusercontent.com/yisibl/resvg-js/main/README.md)). | MPL-2.0 ([license](https://raw.githubusercontent.com/yisibl/resvg-js/main/LICENSE)); compatible with a larger proprietary/permissive application when notices/source obligations are respected. README explicitly lists Node 22/Linux x64 support and Bun compatibility. |
| `sharp` | **USE** for resize/composite/optimization after SVG render, or a fallback | High-performance libvips pipeline with SVG input and PNG output ([output API](https://sharp.pixelplumbing.com/api-output/)). Its SVG/font behavior follows librsvg, which can differ from browser rendering; keep SVG simple and test fonts. | Apache-2.0 ([license](https://raw.githubusercontent.com/lovell/sharp/main/LICENSE)). |
| Playwright | **Fallback only** for browser/CSS/Web Component parity and visual smoke checks | Highest browser fidelity, but starts/uses Chromium and is much heavier per card. The API can capture a whole page, element, clip, or buffer ([screenshots docs](https://playwright.dev/docs/screenshots)). | Apache-2.0 ([license](https://github.com/microsoft/playwright/blob/main/LICENSE)); do not make it the iMessage hot path. |

The server should expose `backend: "resvg" | "playwright"` but default to `resvg`, cache the static board SVG by `(layoutHash, step, theme, viewport)`, and add an `assetManifest` so fonts/images are embedded or explicitly rejected. Use `sharp` only after rasterization for size/format transformations. This avoids silently returning a browser-looking image that cannot be regenerated headlessly.

## 3) Existing MCP servers and tools

Maintenance signals below are repository observations in the late-September 2026 snapshot; stars are a rough signal, not a quality guarantee. A verdict follows the repository rubric: maintained within roughly six months, real capability, Linux/headless operation, permissive/public-hackathon-compatible licensing, and stdio or Streamable HTTP where applicable.

| name | URL | license | last activity | transport | capabilities | verdict |
|---|---|---|---|---|---|---|
| Wokwi CLI MCP | [wokwi/wokwi-cli](https://github.com/wokwi/wokwi-cli), [official MCP docs](https://docs.wokwi.com/wokwi-ci/mcp-support) | MIT ([license](https://raw.githubusercontent.com/wokwi/wokwi-cli/main/LICENSE)) | 2026-09-16 release/commit; 66 stars ([history](https://github.com/wokwi/wokwi-cli/commits/main/)) | stdio, `wokwi-cli mcp` | Simulate embedded projects, run tests, monitor serial output, and interact with virtual hardware. Requires a Wokwi CLI token; experimental MCP. Does not place breadboard parts or render assembly steps. | **good** (simulation only) |
| `fritzing-mcp` | [fedoragobrowse-design/fritzing-mcp](https://github.com/fedoragobrowse-design/fritzing-mcp), [catalog/readme](https://glama.ai/mcp/servers/fedoragobrowse-design/fritzing-mcp/tree) | MIT ([license](https://raw.githubusercontent.com/fedoragobrowse-design/fritzing-mcp/main/LICENSE)); invokes/uses Fritzing data with GPL/CC-BY-SA implications | 2026-09-13; 0 stars, 1 fork ([history](https://github.com/fedoragobrowse-design/fritzing-mcp/commits/main/)) | stdio | Search parts/connectors, create/place/move/wire Fritzing sketches, validate, and headless-render SVG/PNG. Needs a local Fritzing app/parts database and Qt/ImageMagick for full rendering; no breadboard autorouter. | **usable** |
| boardwright | [Naam/boardwright](https://github.com/Naam/boardwright) | MIT ([license](https://raw.githubusercontent.com/Naam/boardwright/main/LICENSE)) | 2026-06-01; 2 stars, 2 commits ([history](https://github.com/Naam/boardwright/commits/main/)) | CLI/library, **not MCP** | JSON-first headless perfboard/stripboard-style layout, maze routing, mini-ERC, HTML/SVG and PNG snapshots. Its own roadmap says solderless-breadboard power/tie-point support and an MCP wrapper are future work ([README roadmap](https://github.com/Naam/boardwright)). Useful algorithm/CLI prior art, not a drop-in breadboard engine. | **usable** (CLI backing) |
| draw.io MCP | [jgraph/drawio-mcp](https://github.com/jgraph/drawio-mcp) | Apache-2.0 ([license](https://raw.githubusercontent.com/jgraph/drawio-mcp/main/LICENSE)) | 2026-09-24; 5.5k stars, 257 commits ([history](https://github.com/jgraph/drawio-mcp/commits/main/)) | hosted MCP Apps and local stdio/tool server | Generic XML/CSV/Mermaid diagram creation, browser/editor opening, ELK/libavoid layout, SVG/PNG/PDF export. No electronics footprint or LVS semantics. | **usable** (generic renderer) |
| mcp-diagram-server | [walterfan/mcp-diagram-server](https://github.com/walterfan/mcp-diagram-server) | Apache-2.0 ([license](https://raw.githubusercontent.com/walterfan/mcp-diagram-server/master/LICENSE)) | 2025-10-27; 0 stars, 2 commits ([history](https://github.com/walterfan/mcp-diagram-server/commits/master/)) | stdio, SSE, REST | PlantUML, Graphviz, and Mermaid to SVG/PNG. Requires Python/Poetry and external Graphviz/Mermaid tooling; unrelated to breadboard geometry. | **dead** |
| SVG MCP Server | [P47Phoenix/Svg-Mcp-Server](https://github.com/P47Phoenix/Svg-Mcp-Server) | README badge says MIT, but the linked `LICENSE` was not retrievable: **[UNVERIFIED]** | 2026-09-18; 0 stars, 14 commits ([history](https://github.com/P47Phoenix/Svg-Mcp-Server/commits/main/)) | README advertises Node/Docker MCP; exact exposed transport/tool schema **[UNVERIFIED]** | Template/dynamic RFC-7996 SVG diagrams, generic flow/network/architecture examples; no electronics model/LVS and sparse published tool detail. | **toy** |
| schematic-mcp-bridge | [10on/schematic-mcp-bridge](https://github.com/10on/schematic-mcp-bridge) | **[UNVERIFIED]** (no license shown in repository listing) | 0 stars; repository page shows 12 commits but branch history currently reports no commit history ([repo](https://github.com/10on/schematic-mcp-bridge), [history](https://github.com/10on/schematic-mcp-bridge/commits/main/)) | stdio | Semantic components/pins/nets, basic ERC, one-row SVG layout, limited neighbor routing, and KiCad export. It is schematic-oriented and explicitly defers general 2-D routing. | **toy** |

No existing candidate provides all of: solderless board-specific placement, deterministic jumper routing, step snapshots, LVS from hole occupancy, accessible SVG, and PNG export under one maintained MCP surface. That gap is the reason to BUILD rather than clone or glue several generic diagram servers.

## 4) Recommendation per sub-area

| sub-area | recommendation | rationale |
|---|---|---|
| Board geometry/rail model | **BUILD** | Board variants, split rails, internal five-hole groups, and exact footprints are core correctness data; no generic renderer can infer them safely. |
| Netlist-to-placement | **BUILD** | Use the deterministic constrained placer above; MIT A* and SchemaBoard validate the problem framing, but a weekend-sized kernel is simpler and reproducible. |
| Jumper routing | **BUILD** | Use board-aware A* with bounded rip-up/reroute and style costs; Fritzing's PCB router is not a breadboard placer. |
| LVS/occupancy check | **BUILD** | Union-find over profile-defined contact groups plus explicit jumpers is small, transparent, and essential for physical verification. |
| Fritzing import/export | **WRAP** (optional) | Invoke an installed Fritzing/Fritzing MCP boundary only for user-provided legacy files. Do not vendor GPL app code or CC-BY-SA art; do not make it the ViBread truth. |
| Wokwi simulation | **USE** | Use official Wokwi CLI MCP for simulation/test/serial checks if a token is available. It complements, but does not replace, assembly layout/LVS. |
| Part glyphs | **USE + WRAP** | Use Wokwi Elements' MIT glyphs through a `PartGlyph` adapter where coverage helps; custom SVG remains the fallback because no public breadboard element exists. |
| Browser assembly view | **BUILD** | Custom SVG/React gives exact hit regions, labels, accessibility, responsive/mobile layouts, and deterministic export. |
| 3-D board view | **BUILD later** | Three.js/R3F are MIT, but asset/camera/rendering work is not on the critical path. Keep the same `Layout` IR if added. |
| Animation | **USE** | CSS transitions/keyframes + `prefers-reduced-motion`; Motion is optional MIT for complex React layout/gesture transitions. Avoid making GSAP's non-OSI standard license a requirement. |
| SVG→PNG | **USE** | `@resvg/resvg-js` default; `sharp` for post-processing; Playwright only as a browser-fidelity fallback. |
| MCP assembly server | **BUILD** | No existing server meets the whole contract without inheriting incompatible data/artwork or incomplete breadboard semantics. |

## 5) BUILD: proposed MCP server and tool surface

### Server identity and transport

Proposed name: **`vibread-assembly`**. Provide a stdio server for Claude Code/local agent use first; add Streamable HTTP only when the ViBread main agent needs a remote MCP endpoint. The server must not expose arbitrary shell/file tools. It accepts bounded JSON and returns structured JSON plus MCP image/resource content.

Backing implementation: ViBread TypeScript layout/LVS kernel; custom SVG generator; `@resvg/resvg-js` for PNG; optional `sharp` for resize/composite; optional `@wokwi/elements` glyph adapters. No Fritzing source/assets in the core package. The server can import a board profile and footprint bundle from the ViBread project.

### Tools

#### `layout_board`

**Inputs**

```ts
{
  netlist: {
    components: Array<{
      id: string; partType: string; footprintId?: string;
      pins: Array<{ id: string; net: string; role?: string }>;
      value?: string; lockedPlacement?: PlacementHint;
    }>;
    nets: Array<{ id: string; pins: string[]; role: string; aliases?: string[] }>;
  };
  board: { profileId: string; width?: number; height?: number };
  options?: {
    skillLevel?: "novice" | "intermediate" | "expert";
    style?: "compact" | "readable";
    lockedPlacements?: PlacementHint[];
    preferRail?: { power?: string; ground?: string };
  };
}
```

**Outputs**

```ts
{
  layoutId: string; layoutHash: string; layout: Layout;
  steps: InstructionStepSummary[];
  score: { wireLength: number; bends: number; crossings: number; styleViolations: number };
  lvs: LVSResult; warnings: Diagnostic[]; errors: Diagnostic[];
}
```

The call must either return a complete LVS-clean layout or a bounded, actionable failure. It must not return a partial picture presented as valid.

#### `render_step`

**Inputs**

```ts
{
  layoutId?: string; layout?: Layout;
  step: number;
  viewport?: { width: number; height: number; dpr?: number };
  theme?: "light" | "dark" | "high-contrast";
  show?: { schematicInset?: boolean; netLabels?: boolean; coordinates?: boolean };
  reducedMotion?: boolean;
}
```

**Outputs**

```ts
{
  step: number; svg: string; altText: string;
  labels: Array<{ id: string; text: string; bbox: Rect }>;
  warnings: Diagnostic[];
}
```

SVG output should be self-contained (inline CSS, no network-loaded images), include `<title>/<desc>`, and contain stable IDs for hit-testing.

#### `export_png`

**Inputs**

```ts
{
  layoutId?: string; layout?: Layout; step: number;
  width?: number; height?: number; dpr?: number;
  background?: string; backend?: "resvg" | "playwright";
  format?: "png";
}
```

**Outputs**

```ts
{
  mimeType: "image/png"; dataBase64?: string; resourceUri?: string;
  width: number; height: number; backend: string; layoutHash: string;
}
```

Bound dimensions (for example, reject images above a configured pixel budget), reject external URLs, and make the renderer report missing fonts/assets rather than substitute silently.

#### `lvs_check`

**Inputs**

```ts
{
  layout: Layout;
  targetNetlist: Netlist;
  boardProfileId: string;
  occupancyOverride?: Array<{ hole: HoleId; observedPin?: string; confidence?: number }>;
}
```

**Outputs**

```ts
{
  pass: boolean;
  targetNets: CanonicalNet[]; derivedNets: CanonicalNet[];
  merged: Diagnostic[]; split: Diagnostic[]; floating: Diagnostic[];
  shorts: Diagnostic[]; footprintErrors: Diagnostic[];
}
```

`occupancyOverride` is for later photo/physical inspection; it must remain separate from the design-time layout and carry confidence so a vision guess cannot overwrite the canonical design.

## 6) Integration notes and gotchas for the ViBread stack

1. **Board selection must be explicit.** Arduino's official pages distinguish Uno R3 from Nano; Uno R3 is a larger external board while Nano is explicitly breadboard-friendly ([Uno R3](https://docs.arduino.cc/hardware/uno-rev3), [Nano](https://docs.arduino.cc/hardware/nano)). Uno R4 Minima uses a 32-bit Renesas RA4M1 and is 5 V only ([Uno R4 Minima](https://docs.arduino.cc/hardware/uno-r4-minima)); do not silently use Uno R3 pin/footprint assumptions for R4. ESP32/Pico profiles must carry 3.3-V logic and their own module footprints.
2. **Net role is not pin number.** `D7`, `A0`, `SDA`, `SCL`, `VIN`, `5V`, and `GND` are board-profile aliases. Firmware pin mapping and layout pin mapping should be cross-checked, but an SVG label must show both the component pin and logical net.
3. **Use Node 22 for the export worker if Bun native-addon behavior regresses.** `resvg-js` documents Node 22/Linux x64 support and Bun compatibility ([support matrix/README](https://raw.githubusercontent.com/yisibl/resvg-js/main/README.md)); still run the actual chosen runtime smoke path. A small Node worker process is a boring fallback that isolates native rendering from the main Bun server.
4. **Never use `foreignObject` or runtime-only CSS in the exported SVG.** Browser display can use React/CSS, but `resvg`/librsvg needs inline geometry, styles, fonts, and images. The SVG export should be generated directly from the layout, not serialized from an arbitrary browser DOM.
5. **Stable IDs matter.** Prefix IDs with `layoutHash`/`step` and component IDs to avoid collisions if multiple SVGs are mounted. Hit testing should resolve to a `PinRef`/`HoleId`, not infer from screen coordinates.
6. **Mobile is not a scaled desktop.** Give the phone card one step, a large current-action label, a static endpoint list, and a button to view the schematic/net. Do not hide essential meaning in hover, animation, or a wide desktop legend.
7. **Permission and safety.** `layout_board` and `render_step` are read-only computations; `export_png` writes only to a server-managed resource; `lvs_check` must not execute firmware. Physical flashing/self-test remains a separate permissioned tool in the main agent.
8. **Fritzing license boundary.** Fritzing's GPL app and CC-BY-SA graphics are acceptable only if the team intentionally carries those notices/obligations. The clean hackathon path is to use its file format as an optional import reference and write new ViBread SVGs. Do not copy Fritzing SVGs into the repository.
9. **No arbitrary image/network fetches.** External SVG images, fonts, and user-provided URLs create SSRF and non-determinism. Allow an explicit, hashed local asset manifest only.
10. **Version the renderer.** Include `rendererVersion`, `boardProfileVersion`, `footprintVersion`, and `layoutHash` in each step/PNG metadata. A changed footprint or renderer should invalidate cached images.
11. **Keep electrical validation separate.** LVS detects topology; ERC/electrical simulation detects illegal source combinations/current assumptions; firmware tests and MCU simulation detect behavior; physical self-test detects what the hardware can observe. A green SVG/LVS badge must not imply all four are green.

## 7) Risks and unknowns

- **Board variation:** “Half” and “full” boards do not guarantee rail continuity, row count, or exact hole positions. A wrong board profile can make a correct-looking layout physically wrong.
- **Footprint uncertainty:** User-supplied LEDs, tact switches, TO-92s, pots, and modules may have different lead bends/header populations. Require an exact footprint or ask a clarification; do not hallucinate geometry.
- **Search-space failure:** Dense multi-module designs may have no route under the one-layer style constraints. Return diagnostics and suggest a larger board/alternate footprint; do not use an unbounded solver during the demo.
- **Topology limit:** LVS cannot detect a loose wire, damaged part, incorrect resistance, wrong transistor pin order when the wrong footprint was selected, intermittent contact, or a physically crossed wire that is not represented in the layout.
- **Instruction drift:** If a user manually moves a component after generation, the step image and physical board can diverge. Re-run LVS on the edited layout and make the edit visible in the history.
- **Accessibility:** Color-only wire encoding, tiny labels, low contrast, animation, and phone cropping can make a technically correct guide unusable. WCAG and SVG text alternatives are requirements, not polish.
- **PNG renderer drift:** Browser SVG, resvg, and librsvg may differ on fonts/CSS. Keep the core SVG primitive-only and compare a small set of fixtures through every backend.
- **Native dependencies:** `resvg-js` and `sharp` ship native components; package/runtime/architecture mismatches can break deployment. Keep Playwright as a slow fallback rather than the primary service.
- **Wokwi scope/licensing:** Wokwi CLI MCP is valuable but experimental and token-gated; Wokwi Elements are presentation-only and omit a public breadboard element. Do not make the assembly demo depend on Wokwi cloud availability.
- **Competitor/copying rule:** TAC, Fritzing, Circuito.io, Wokwi, and Tinkercad are references. ViBread must implement its own data structures, solver, visuals, and instruction content; dependencies must remain unmodified and credited according to their licenses.
- **Maintenance snapshot uncertainty:** Repository stars and latest commit dates change after this research. Pin dependency versions/commit hashes in the build and re-check licenses before publishing.

## 8) Sources

Primary sources used above:

1. [SparkFun — How to Use a Breadboard](https://learn.sparkfun.com/tutorials/how-to-use-a-breadboard/all)
2. [BusBoard BB400 datasheet](https://www.busboard.com/documents/datasheets/BPS-DAT-(BB400)-Datasheet.pdf)
3. [BusBoard BB830 datasheet](https://www.busboard.com/documents/datasheets/BPS-DAT-(BB830)-Datasheet.pdf)
4. [Arduino Uno R3](https://docs.arduino.cc/hardware/uno-rev3), [Arduino Nano](https://docs.arduino.cc/hardware/nano), [Arduino Uno R4 Minima](https://docs.arduino.cc/hardware/uno-r4-minima)
5. [Fritzing Project View](https://fritzing.org/learning/get-started/project-view)
6. [Fritzing autorouter announcement](https://blog.fritzing.org/2011/02/11/a-new-autorouter)
7. [Fritzing app README/licensing](https://github.com/fritzing/fritzing-app), [parts format](https://github.com/fritzing/fritzing-app/wiki/2.1-Part-file-format), [parts license](https://raw.githubusercontent.com/fritzing/fritzing-parts/develop/LICENSE.txt)
8. [Trigger-Action-Circuits (UIST 2017)](https://www.research.autodesk.com/app/uploads/2023/03/trigger-action-circuits-leveraging.pdf_recJhQeai7lWIR6C9.pdf)
9. [Automatic protoboard layout from circuit schematics (MIT DSpace)](https://hdl.handle.net/1721.1/91847)
10. [SchemaBoard (UIST 2020)](https://make.kaist.ac.kr/files/2020/Kim_SchemaBoard_UIST20.pdf), [DOI](https://doi.org/10.1145/3379337.3415887)
11. [VirtualWire (TEI 2021)](https://make.kaist.ac.kr/files/2021/Lee_VirtualWire_TEI21.pdf)
12. [AutoFritz (CHI 2019)](http://www.sfu.ca/~xingdong/papers/AutoFritz.pdf)
13. [Circuito.io design guide](https://www.circuito.io/blog/circuit-design/)
14. [Wokwi diagram editor](https://docs.wokwi.com/guides/diagram-editor), [diagram format](https://docs.wokwi.com/diagram-format), [MCP support](https://docs.wokwi.com/wokwi-ci/mcp-support)
15. [Wokwi Elements README](https://github.com/wokwi/wokwi-elements/blob/main/README.md), [exports](https://raw.githubusercontent.com/wokwi/wokwi-elements/main/src/index.ts), [breadboard issue](https://github.com/wokwi/wokwi-elements/issues/172)
16. [Agrawala et al., Designing Effective Step-By-Step Assembly Instructions](https://graphics.stanford.edu/papers/assembly_instructions/assembly.pdf)
17. [LEGO building instructions service](https://www.lego.com/en-us/service/building-instructions), [official instruction example](https://www.lego.com/cdn/product-assets/product.bi.additional.main.pdf/71380_01_Build_Main.pdf)
18. [ElectroTutor (UIST 2018)](https://www.benlafreniere.ca/assets/papers/Warner_-_UIST2018_-_ElectroTutor.pdf)
19. [CircuitStyle (UIST 2019)](http://www.sfu.ca/~xingdong/papers/CircuitStyle.pdf), [DOI](https://doi.org/10.1145/3332165.3347920)
20. [Arduino LED polarity](https://support.arduino.cc/hc/en-us/articles/360021532580-How-are-the-LEDs-represented-in-the-Starter-Kit-projects-book), [SparkFun LEDs](https://learn.sparkfun.com/tutorials/light-emitting-diodes-leds/all), [SparkFun resistor markings](https://learn.sparkfun.com/tutorials/resistors/decoding-resistor-markings), [IEC 60062](https://webstore.iec.ch/en/publication/25395)
21. [Kingbright 5-mm LED datasheet](https://www.kingbrightusa.com/images/catalog/SPEC/WP7113SYTKTNR254.pdf), [Schurter 6×6-mm switch datasheet](https://www.schurter.com/en/datasheet/typ_6x6_mm_tact_switches.pdf), [NXP TO-92/SOT54](https://www.nxp.com/packages/SOT54), [3M DIP data sheet](https://media.digikey.com/pdf/Data%20Sheets/3M%20PDFs/3000_Series_100_Dip.pdf), [Farnell 356 trimmer](https://www.farnell.com/datasheets/1734496.pdf)
22. [W3C WCAG Use of Color](https://www.w3.org/WAI/WCAG21/Understanding/use-of-color), [W3C Non-text Contrast](https://www.w3.org/WAI/WCAG21/Understanding/non-text-contrast.html), [ColorBrewer](https://colorbrewer2.org/), [W3C SVG accessibility](https://www.w3.org/TR/SVG-access/), [SVG-AAM](https://www.w3.org/TR/svg-aam/)
23. [resvg-js README](https://raw.githubusercontent.com/yisibl/resvg-js/main/README.md), [MPL-2.0 license](https://raw.githubusercontent.com/yisibl/resvg-js/main/LICENSE)
24. [sharp output API](https://sharp.pixelplumbing.com/api-output/), [Apache-2.0 license](https://raw.githubusercontent.com/lovell/sharp/main/LICENSE)
25. [Playwright screenshots](https://playwright.dev/docs/screenshots), [Playwright license](https://github.com/microsoft/playwright/blob/main/LICENSE)
26. [Motion React docs](https://motion.dev/docs/react), [Motion MIT license](https://github.com/motiondivision/motion/blob/main/LICENSE.md)
27. [Three.js MIT license](https://raw.githubusercontent.com/mrdoob/three.js/dev/LICENSE), [React Three Fiber MIT license](https://raw.githubusercontent.com/pmndrs/react-three-fiber/master/LICENSE)
28. [GSAP standard license](https://gsap.com/community/standard-license/), [GSAP pricing](https://gsap.com/pricing/)
29. [Wokwi CLI license](https://raw.githubusercontent.com/wokwi/wokwi-cli/main/LICENSE), [Wokwi CLI activity](https://github.com/wokwi/wokwi-cli/commits/main/)
30. [fritzing-mcp README/activity](https://github.com/fedoragobrowse-design/fritzing-mcp), [license](https://raw.githubusercontent.com/fedoragobrowse-design/fritzing-mcp/main/LICENSE)
31. [boardwright README/activity](https://github.com/Naam/boardwright), [license](https://raw.githubusercontent.com/Naam/boardwright/main/LICENSE)
32. [drawio MCP README/activity](https://github.com/jgraph/drawio-mcp), [Apache-2.0 license](https://raw.githubusercontent.com/jgraph/drawio-mcp/main/LICENSE)
33. [mcp-diagram-server README/activity](https://github.com/walterfan/mcp-diagram-server), [license](https://raw.githubusercontent.com/walterfan/mcp-diagram-server/master/LICENSE)
34. [SVG MCP Server README/activity](https://github.com/P47Phoenix/Svg-Mcp-Server), [README's license claim](https://raw.githubusercontent.com/P47Phoenix/Svg-Mcp-Server/main/README.md)
35. [schematic-mcp-bridge README](https://github.com/10on/schematic-mcp-bridge)
