# A7 agent UI — MUI verification record

## Scope

This audit covers the React/Vite UI stack for ViBread's conversational agent surface: streamed assistant text, tool-call cards, human approvals, permission modes, a live task list, artifact tabs, bench/verification status, and a phone Build Mode. It evaluates Material UI (MUI) Core, MUI X Community components, MUI X Chat, assistant-ui as a headless alternative, CopilotKit, Chatscope Chat UI Kit, Markdown/code rendering, React 19/Vite compatibility, responsive theming, and accessibility.

Verification was run only in `/tmp/audit/a7`; no product code was built or copied into the repository. The package snapshot was obtained from npm on the audit date. No `ANTHROPIC_API_KEY` is present, so Claude Agent SDK behavior was checked from official documentation and package/type surfaces only; no model request was attempted.

**Recommendation in one sentence:** use **MUI Core + MUI X Community + `@mui/x-chat` (pinned alpha) as the primary chat surface**, with one ViBread `ChatAdapter` that translates the existing Claude Agent SDK SSE events into MUI X Chat chunks; use MUI slots/part renderers for tool cards and a custom three-option approval card, and keep assistant-ui as the fallback if the MUI X Chat alpha proves too unstable.

## Verification table

| Claim | Verdict | Evidence | Correct choice |
|---|---|---|---|
| Current MUI Core is MIT and supports React 19 | **correct** | Installed `@mui/material@9.4.0` and read `/tmp/audit/a7/node_modules/@mui/material/package.json`: version `9.4.0`, license `MIT`, peer range `react`/`react-dom` `^17 || ^18 || ^19`. Its `LICENSE` is MIT. Official installation docs show `npm install @mui/material @emotion/react @emotion/styled` and the same React peer range ([installation](https://mui.com/material-ui/getting-started/installation/)). | Pin `@mui/material@9.4.0`, `@emotion/react@11.14.0`, and `@emotion/styled@11.14.1` together. MUI's default Emotion engine is the least-friction Vite choice. |
| MUI Material Icons are MIT and React 19 compatible | **correct** | Installed `@mui/icons-material@9.4.0`; package metadata and `/tmp/audit/a7/node_modules/@mui/icons-material/LICENSE` both say MIT. Its peer range includes React 19 and `@mui/material^9.4.0`. | Use `@mui/icons-material` with deep imports for frequently used icons (`@mui/icons-material/Stop`, etc.) rather than importing the entire icon barrel in a route that already uses X components. |
| MUI X Community Data Grid, Tree View, and Charts are MIT | **correct** | Installed `@mui/x-data-grid@9.14.0`, `@mui/x-tree-view@9.14.0`, and `@mui/x-charts@9.14.0`; each package declares MIT and React 19 peers. Data Grid's package description says “Community plan edition”; Tree View and Charts say “community edition.” MUI's licensing page lists all three under the free Community plan and says Community is MIT ([licensing](https://mui.com/x/introduction/licensing/)). The component API smoke file `/tmp/audit/a7/mui-smoke.tsx` imports `DataGrid`, `SimpleTreeView`/`TreeItem`, and `BarChart`; strict TypeScript passed. | Use Community Data Grid only for desktop telemetry tables, Tree View only if the checklist needs hierarchy, and Charts only for the artifact/telemetry view. A plain MUI `List` is better for the phone and the main todo list. Lazy-load X Grid/Charts because they are not needed on every screen. |
| MUI X Pro/Premium can be used without a commercial decision | **incorrect** | `npm view @mui/x-data-grid-pro @mui/x-data-grid-premium @mui/x-tree-view-pro @mui/x-charts-pro version license ...` reports `9.14.0` with `license: SEE LICENSE IN LICENSE`; official licensing docs explicitly say Pro and Premium are commercial, require a license key for production, and list Pro-only Data Grid features and Premium-only grouping/Excel export. | Do not add Pro/Premium. The MVP does not need grouping, Excel export, pinning, or Pro Tree View drag/drop. Record the Community-only decision in the dependency notice. |
| MUI X Chat is available and is a direct fit for a custom backend | **correct** | Installed `@mui/x-chat@9.0.0-alpha.18` and its `@mui/x-chat-headless@9.0.0-alpha.18` dependency. `/tmp/audit/a7/node_modules/@mui/x-chat/package.json` declares MIT, React 19 peers, and no AI SDK peer. The official overview says it is a drop-in React component that “connects to any backend”; its adapter docs require only `sendMessage`, which returns `ReadableStream<ChatMessageChunk | ChatStreamEnvelope>` ([overview](https://mui.com/x/react-chat/), [adapters](https://mui.com/x/react-chat/backend/adapters/)). | Prefer `ChatBox` + one ViBread adapter. The adapter parses the authenticated SSE response and emits MUI chunks; no Vercel AI SDK or `ai` package is required. |
| MUI X Chat is a stable, low-risk dependency | **partial** | npm reports `9.0.0-alpha.18`, last modified 2026-09-04; the official overview visibly labels MUI X Chat “in early development.” The stable neighboring X packages are `9.14.0`, but Chat is still alpha and pins `@mui/x-internals@9.13.0` while the other installed X packages use `9.14.0` (`npm ls @mui/x-chat-headless @mui/x-internals --depth=2`). | Pin the exact alpha, run the smoke/typecheck in CI, and keep the assistant-ui adapter fallback. Do not claim Chat is stable in product docs. Recheck the package before the demo and avoid using unpublished APIs. |
| MUI X Chat streams incrementally and supports stop/disconnect | **correct** | Official streaming docs define the lifecycle `start` → content chunks → `finish`/`abort`, accept `ReadableStream` chunks, show converting an SSE stream, and document `AbortSignal` plus optional `adapter.stop()` ([streaming](https://mui.com/x/react-chat/behavior/streaming/)). The installed adapter type at `/tmp/audit/a7/node_modules/@mui/x-chat-headless/adapters/chatAdapter.d.ts` has `sendMessage`, `reconnectToStream`, and `stop`. `/tmp/audit/a7/mui-chat-smoke.tsx` typechecks an adapter returning a `ReadableStream<ChatMessageChunk>`. | Pass the adapter's `signal` to `fetch`; implement `stop()` to call ViBread's cancel endpoint if cancelling the HTTP stream alone is not enough. Implement `reconnectToStream` later if long runs need resumability. |
| MUI X Chat can represent tool calls and inline human approval | **correct** | The installed `chat-stream.d.ts` exposes `tool-input-start`, `tool-input-delta`, `tool-input-available`, `tool-approval-request`, `tool-output-available`, `tool-output-error`, and `tool-output-denied`; `chatAdapter.d.ts` exposes `addToolApprovalResponse({ id, approved, reason? })`. Official tool-calling docs define states from `input-streaming` through `approval-requested`, `approval-responded`, `output-available`, and `output-denied` ([tool calling](https://mui.com/x/react-chat/ai-and-agents/tool-calling/), [tool approval](https://mui.com/x/react-chat/ai-and-agents/tool-approval/)). The official agentic-code example demonstrates streamed reasoning, tool calls, step boundaries, and approval ([agentic example](https://mui.com/x/react-chat/material/examples/agentic-code/)). | Emit ViBread tool events as MUI tool chunks. Use a custom `partRenderers.tool`/`toolSlots` card for “Checking the circuit… ✓”. For the required Allow once / Always for this mission / Deny controls, make a custom approval renderer: “Allow once” calls `addToolApprovalResponse`; “Always for this mission” first persists a ViBread broker grant, then calls the same approval method; “Deny” calls it with `approved:false` and a reason. MUI's built-in approval is boolean, so “Always” is application policy, not a hidden MUI mode. |
| MUI X Chat is accessible and responsive enough for the desktop and phone surfaces | **correct** | Official accessibility docs specify a single message-list Tab stop with roving focus, Arrow/Home/End navigation, Enter drill-in, Escape out, labeled landmarks, polite live regions, `aria-busy` during streaming, and one “response started/completed” announcement rather than per-token announcements ([accessibility](https://mui.com/x/react-chat/accessibility/)). ChatBox has `layoutMode` (`standard`, `overlay`, `split`) and container-width breakpoints; its docs say narrow layouts use an overlay/drawer and the quickstart says styles derive from the active MUI theme. | Use the built-in ChatBox focus/live-region behavior. Use `layoutMode`/breakpoints for laptop versus phone; put Build Mode's one-step view outside ChatBox for a simpler touch flow. Test custom tool/approval controls with keyboard drill-in. |
| MUI Core supports a dark “mission control” theme and responsive layout | **correct** | Official dark-mode docs show `createTheme({ palette: { mode: 'dark' } })`, `ThemeProvider`, and `CssBaseline`; theming docs cover palette, typography, spacing, breakpoints, transitions, and component overrides ([dark mode](https://mui.com/material-ui/customization/dark-mode/), [theming](https://mui.com/material-ui/customization/theming/)). Responsive docs list Grid, Container, breakpoints, and `useMediaQuery`; Drawer docs document responsive temporary/permanent drawers ([responsive UI](https://mui.com/material-ui/guides/responsive-ui/), [Drawer](https://mui.com/material-ui/react-drawer/)). The MUI smoke file compiles `ThemeProvider`, dark palette, responsive `Drawer`, `useMediaQuery`, and `sx`. | Create one `missionTheme` with dark palette, blue-white primary, explicit success/warning/error colors, `CssBaseline`, and component overrides. Use `Box`/`Stack`/`Drawer`/`useMediaQuery` rather than another styling system. |
| MUI v9 system shorthand can be used as old direct props everywhere | **incorrect** | The first strict compile of `/tmp/audit/a7/mui-smoke.tsx` failed on `<Stack p={2} gap={1}>`, `<Box p={2}>`, and `<Stack gap={2}>`; v9 types require `sx` for those style values. Replacing them with `sx={{ p: 2, gap: 1 }}` passed. | Use `sx` consistently (`sx={{ p: 2, gap: 1 }}`), and do not mix old direct system props into new v9 code. |
| MUI X Chat can connect directly to the Claude Agent SDK event stream | **partial** | MUI X accepts a generic `ReadableStream` and documents an SSE-to-chunk adapter, but its chunk protocol (`text-delta`, `tool-input-delta`, etc.) is not the Claude Agent SDK raw event protocol (`content_block_delta`, `input_json_delta`, and SDK messages). No Anthropic request was possible because the API key is absent. | Write a small deterministic converter: Claude text deltas → `text-start`/`text-delta`/`text-end`; tool start/input deltas → tool chunks; approval broker event → `tool-approval-request`; tool result → output chunk; run end → `finish`. Do not make the browser speak the Agent SDK directly or expose API keys. |
| `@assistant-ui/react` is a viable MUI-compatible headless alternative | **correct** | Installed `@assistant-ui/react@0.15.22` (MIT; React 18/19 peers). Its official ExternalStoreRuntime docs say the adapter owns messages and callbacks, and explicitly list `onNew`, `onCancel`, `onResumeToolCall`, `onRespondToToolApproval`, and streaming by mutating an assistant message ([ExternalStoreRuntime](https://www.assistant-ui.com/docs/runtimes/custom/external-store)). `/tmp/audit/a7/api-smoke.ts` typechecks `useExternalStoreRuntime`, custom messages, cancellation, and approval callbacks; `/tmp/audit/a7/assistant-mui-smoke.tsx` typechecks MUI `styled`, `sx`, `ThreadPrimitive`, `MessagePrimitive`, and tool render props. | Keep as the fallback if MUI X Chat's alpha API blocks integration. It gives more backend-neutral headless primitives but needs more message rendering/layout glue than ChatBox. |
| CopilotKit is a drop-in MUI chat replacement | **partial** | Installed `@copilotkit/react-core@1.74.0` (MIT; package has v2 entry). Official v2 docs provide `<CopilotKitProvider runtimeUrl=...>`, headless `useAgent`, `useFrontendTool`, `useHumanInTheLoop`, and `useRenderTool`; the backend docs say the frontend speaks AG-UI over SSE and discovers agents through `/info` ([v2 reference](https://docs.copilotkit.ai/reference/v2), [AG-UI backend](https://docs.copilotkit.ai/backend/ag-ui)). | Use only if ViBread adopts AG-UI as its public stream contract. It adds AG-UI/runtime-agent conversion and its prebuilt UI is not MUI-native. For the current custom Claude Agent SDK SSE, MUI X Chat's adapter is smaller glue. |
| Chatscope is the smallest way to add this MUI agent UI | **partial** | Installed `@chatscope/chat-ui-kit-react@2.1.1` (MIT) and `@chatscope/chat-ui-kit-styles@1.4.0`; README requires a separate global styles package and exposes generic `MainContainer`, `ChatContainer`, `MessageList`, `Message`, and `MessageInput`. `/tmp/audit/a7/chatscope-smoke.tsx` typechecks those APIs, including `MessageInput.onSend`. npm last modified Chat UI Kit on 2025-05-15, much less recent than MUI and assistant-ui. Its types have no agent event, tool invocation, or approval model. | Do not combine it with MUI. It brings its own CSS and layout conventions; custom cards can be children, but streaming/tool/approval state and MUI theming remain application glue. |
| `react-markdown` plus `react-syntax-highlighter` covers streamed Markdown and Arduino code | **correct** | Installed `react-markdown@10.1.0` (MIT; ESM-only) and `react-syntax-highlighter@16.1.1` (MIT), with `@types/react-syntax-highlighter@15.5.13`. The official react-markdown README says it renders a virtual DOM safely by default and accepts custom components; highlighter README documents language, `PreTag`, line numbers, light builds, and MIT ([react-markdown README](https://github.com/remarkjs/react-markdown#readme), local `/tmp/audit/a7/node_modules/react-syntax-highlighter/README.md`). `/tmp/audit/a7/markdown-smoke.tsx` typechecks a `code` renderer. | Render agent text with `react-markdown` inside MUI `Box`/`Typography`; use an explicit code renderer and highlighter. Do not enable `rehype-raw` for untrusted agent output without sanitization. Install the types package and do not spread react-markdown's `ref` into the class-based highlighter (React 19 typecheck rejects that); pass explicit props. |
| MUI Core/X + Chat is compatible with Vite | **correct** | Vite `8.3.1` (MIT) was installed. MUI's official example projects include JavaScript and TypeScript Vite integrations ([example projects](https://mui.com/material-ui/getting-started/example-projects/)). `vite build --outDir vite-chat-dist` completed successfully for `/tmp/audit/a7/index.html`, importing MUI Core, X Grid/Tree/Charts, X Chat, Markdown, and the Chat adapter; output included the generated JS bundle. | Keep Vite + React 19. Treat the many `use client` directive warnings from X packages as bundler warnings for this SPA, not a runtime blocker; watch them when SSR is introduced. |
| Lucide should be added alongside MUI icons | **unverified for this MUI-only decision** | The prior stack audit found `lucide-react` 1.48.0, ISC, but no MUI-specific need was exercised here. MUI Icons already supply the tested controls. | Use one icon family, MUI Icons, to avoid visual and bundle duplication. Revisit Lucide only if a required symbol is missing; if added, preserve its ISC notice. |

### Library choice and effort estimate

**Primary choice:** `@mui/material` + `@mui/icons-material` + `@mui/x-chat` (pinned `9.0.0-alpha.18`) + the Community X packages needed by artifact views. Add `react-markdown` and `react-syntax-highlighter` for assistant text/code. The only bespoke UI state is ViBread's mission/workspace shell, mode selector, permission broker, task list, artifact canvas, and the adapter/event converter; the chat rendering, composer, streaming state, tool disclosure, approval state, stop behavior, responsive drawer, and accessibility behavior come from MUI X Chat.

**Fallback:** `@assistant-ui/react` `0.15.22` ExternalStoreRuntime + MUI wrappers if MUI X Chat alpha changes or cannot represent a needed nested/sub-agent state. This is a more mature backend-neutral seam but means implementing the chat message/tool markup with MUI primitives.

**[ESTIMATE]** With the API surfaces verified above, the primary path is roughly **8–12 engineering hours** for one frontend engineer: 2–3 hours for the SSE-to-Chat chunk adapter and approval broker bridge; 2–3 hours for the workspace shell, mode selector, task list, and artifact tabs; 2–3 hours for Bench/Build Mode responsive states; and 2–3 hours for copy, accessibility, and smoke coverage. This is an estimate, not a measured product implementation. The fallback assistant-ui path adds approximately 4–8 hours of message/tool composition because it does not provide a MUI-themed drop-in ChatBox.

## Integration gotchas discovered

1. **MUI X Chat is alpha.** Pin `@mui/x-chat@9.0.0-alpha.18` and do not float `latest`. The official page labels Chat early development. Add a compile smoke for `ChatAdapter`, `ChatBox`, `partRenderers`, approval response, and the chunk converter.
2. **X internals are not aligned in the alpha.** `npm ls --depth=2` shows X Chat alpha using `@mui/x-internals@9.13.0` while X Data Grid/Tree/Charts `9.14.0` use `@mui/x-internals@9.14.0`. It installed without a peer error in the isolated workspace, but it is a reason to pin and retest the exact set together.
3. **The Claude Agent SDK stream is not the MUI chunk protocol.** ViBread must own a parser and converter. Preserve `eventId`/monotonic sequence in `ChatStreamEnvelope` so a reconnect does not duplicate chunks. The browser adapter should use `fetch` with the bearer token and pass `AbortSignal`, not expose the Anthropic key.
4. **Approval identity matters.** MUI's approval response `id` is `approvalId` when the stream provided one, otherwise `toolCallId`. The ViBread broker should bind the approval to mission, revision, action hash, expiry, and decider; the “Always for this mission” button must not be implemented as an unconditional boolean approval.
5. **MUI Chat's default approval is two-way.** Built-in buttons cover Allow/Deny. The requested Allow once / Always / Deny requires a custom tool renderer or a wrapper around the approval slot. “Always” should persist a mission-scoped rule, then call `addToolApprovalResponse` once.
6. **Use `sx` rather than v7-era direct system props.** Strict v9 typechecking caught `Box p={2}` and `Stack gap={1}`; `sx={{ p: 2, gap: 1 }}` passed.
7. **Tree-shake and split the heavy views.** A deliberately broad Vite smoke that imports MUI icons, Data Grid, Tree View, Charts, Chat, Markdown, and the highlighter produced a 2.5 MB JS asset (the smoke is not a product-size measurement). Deep-import icons and lazy-load Grid/Charts only on the artifact/telemetry tab. Avoid importing the entire icon barrel in the workspace route.
8. **Markdown/highlighter typing needs care.** `react-syntax-highlighter` does not ship declarations; install `@types/react-syntax-highlighter`. Under React 19 types, passing all `react-markdown` code props (especially `ref`) into the class-based highlighter fails; pass `language`, `PreTag`, and text explicitly. Treat agent Markdown as untrusted and keep raw HTML disabled unless a sanitizer is added.
9. **ChatBox fills its parent.** Give the ChatBox an explicit height/flex growth contract (`sx={{ height: ... }}` or a parent with `minHeight: 0` and `flex: 1`). Otherwise the chat can collapse inside the two-column workspace.
10. **Mobile and bench are different surfaces.** MUI X Chat's responsive overlay/drawer is suitable for phone chat, but Web Serial belongs on the laptop/bench browser. Build Mode should poll mission state and never promise that a phone can flash the board.
11. **No end-to-end Agent SDK proof was possible.** There is no Anthropic API key. The adapter/API evidence is static and type-level; a real stream, approval pause, and resume still require a keyed integration smoke in the ViBread environment.

## Claude Code interaction patterns to mirror

These are interaction patterns, not copied code or assets.

- **Mode is visible and changeable.** Official docs currently list `default` (labeled Manual), `acceptEdits`, `plan`, `auto`, `dontAsk`, and `bypassPermissions`. `Shift+Tab` cycles the modes in the CLI; the desktop/web surfaces use a mode selector. ViBread's labels can remain beginner-friendly: Plan, Ask every time, Review, Autopilot. Map them deliberately: Plan → SDK `plan`; Ask every time → `default` plus broker/callback; Review → a ViBread policy layered over default/allow rules (there is no native Claude mode literally named Review); Autopilot → preferably `auto`/classifier semantics, not an unconditional `bypassPermissions`. The official docs warn that bypass permissions is for isolated containers/VMs.
- **Permission prompts explain the action and offer memory.** The permissions docs distinguish one-time approval from “Yes, and don't ask again,” and the Agent SDK `canUseTool` docs say the callback can stay pending while an application presents a decision. ViBread should show “I want to change the circuit revision” or “I want to flash the board,” the exact consequence, and revision/action identity. The three buttons are Allow once, Always for this mission, and Deny; physical/BOM actions remain human-only regardless of mode.
- **Streaming makes work visible.** The Agent SDK streaming docs specify partial messages, `content_block_start`, `content_block_delta`, and `content_block_stop`; tool calls stream their JSON input incrementally. MUI X Chat's tool chunk protocol gives the same visible phases. Render a compact card such as “Checking the circuit…”, show a spinner only while active, collapse details when complete, and show a text/icon result (`Passed`, `Needs your decision`, `Failed`) rather than exposing raw JSON by default.
- **Todo work is a first-class progress surface.** Current Agent SDK docs describe `TaskCreate`, `TaskUpdate`, `TaskGet`, and `TaskList` with `pending`, `in_progress`, `completed`, and `deleted` lifecycle states; todo activity is visible as structured tool calls. ViBread should maintain its own mission task list from deterministic mission events as well as agent task events, so hardware gates cannot be lost during a context compaction or reconnect. Show one active step and a short remaining list; allow “Show details” for the full checklist.
- **Stop is immediate and safe.** Official interactive-mode docs say `Esc` interrupts the current response/tool call and keeps work done so far; `Ctrl+C` interrupts or clears input. Give the web UI an always-visible Stop button in the composer/app bar, wire it to AbortSignal plus the server cancel endpoint, and label a hardware stop distinctly from a chat stop (“Stop agent” versus “Unplug board”).
- **Transcript detail is available without overwhelming the default view.** Claude Code's transcript viewer expands collapsed tool/MCP lines with a keyboard toggle. ViBread should default to plain-language cards and let advanced users expand tool name, arguments, timings, revision hash, and raw event details.

Primary documentation evidence: [permission modes](https://code.claude.com/docs/en/permission-modes), [permissions](https://code.claude.com/docs/en/permissions), [Agent SDK permissions](https://code.claude.com/docs/en/agent-sdk/permissions), [interactive mode](https://code.claude.com/docs/en/interactive-mode), [streaming output](https://code.claude.com/docs/en/agent-sdk/streaming-output), [todo tracking](https://code.claude.com/docs/en/agent-sdk/todo-tracking), and [approvals/user input](https://code.claude.com/docs/en/agent-sdk/user-input).

## Screen set and ASCII wireframes

The names below describe composition from MUI/MUI X/library components; they are not a request to hand-build a second design system.

### 1. Home / New mission

**Composition:** `AppBar` + `Toolbar` + `IconButton`/MUI Icons; `Container`; `Card`; `Typography`; multiline `TextField`; `Button`; `Chip`; `List`/`ListItemButton` for recent missions; `LinearProgress` for resumable runs.

```text
+--------------------------------------------------------------------------------+
| ViBread   Mission Control                                  [Connections] [⚙]  |
+--------------------------------------------------------------------------------+
|                                                                            |
|  [Card] What should your circuit do?                                       |
|  +------------------------------------------------------------------------+ |
|  | "A lamp that turns on when it is dark. I have four LEDs and a button." | |
|  +------------------------------------------------------------------------+ |
|  Parts I have: [Uno] [breadboard] [LEDs] [resistors] [photo sensor]          |
|  [Add a photo]       [Start a new mission]                                  |
|                                                                            |
|  Recent missions                                                           |
|  [Moon lamp]   Ready to continue                         [Open]             |
|  [Button light] Checks complete                         [Open]             |
+--------------------------------------------------------------------------------+
```

Copy: say “Tell me what you want to make” and “I’ll check your parts first.” Avoid “submit prompt,” “invoke agent,” or “IR.” `TextField` helper text should state that the user can change the design before anything is flashed.

### 2. Mission workspace (desktop)

**Composition:** `AppBar`; mode `Select` + `MenuItem` (or `ToggleButtonGroup`); `Drawer` for mission stages; CSS grid using MUI `Box sx`; `ChatBox`; `Card`/`Paper`; `Tabs`/`TabPanel`; `Stack`; `Chip`/`Badge`; `LinearProgress`; MUI X `DataGrid`/`BarChart` only in the relevant artifact tab; `List` for tasks.

```text
+--------------------------------------------------------------------------------+
| ← Moon lamp   [Review ▾]   ● Board disconnected     [Stop agent] [⋯]          |
+----------------------+-----------------------------------+---------------------+
| Mission steps        | Conversation (MUI X ChatBox)      | Artifact canvas      |
| ✓ Describe           | You: Make a lamp when it is dark | [Schematic][Steps]  |
| ✓ Parts              | Assistant: I will check...       | [Code][Replay][Tests]|
| ● Check design       | [Checking the circuit…  ⌄]       |                     |
| ○ Review              |   Electrical limits  ✓           |  [SVG / image / code]|
| ○ Build               |   Pin roles            ✓           |  [zoom] [download]   |
| ○ Verify              | [Approval card]                  |                     |
|                      | [Type what you want changed…]    |                     |
+----------------------+-----------------------------------+---------------------+
| Console lights: [EECOM GO] [GUIDO —] [FIDO —] [FAO —] [RETRO waiting]          |
| Tasks: ✓ parts   ● checking wiring   ○ simulation   ○ build                   |
+--------------------------------------------------------------------------------+
```

Tool cards use MUI X Chat's `partRenderers`/`toolSlots`; each card shows a short plain label, state icon/text, `Collapse` details, and an `Alert` on failure. The canvas is not chat markdown: use real artifact renderers and revision/hash labels. Keep the task list outside ChatBox so it remains visible while chat scrolls.

### 3. Approval prompt

**Composition:** MUI X Chat built-in tool part as the anchor; custom `Card`/`Alert`; `DialogTitle`/`DialogContent`/`DialogActions` for high-risk physical actions; three `Button`s; `TextField` for an optional denial reason; `Chip` for mode and revision.

```text
+---------------------------------------------------------------+
| Permission needed                                             |
| ViBread wants to release revision r12                         |
|                                                               |
| This changes the design used for the next checks.             |
| It will not flash the board.                                  |
|                                                               |
| [Review changes]  [Why?]                                      |
| [Allow once]  [Always for this mission]  [Deny]               |
|                                                               |
| Mode: Review   Revision: r12   Expires in 10 min              |
+---------------------------------------------------------------+
```

For flashing, rewire, or new parts, replace “Always” with an explicit explanation that a person must approve each physical action; do not let Autopilot hide this.

### 4. Bench / Verify panel

**Composition:** `Stepper` (desktop) or `MobileStepper`; `Card`; `Alert`; `Button`; `LinearProgress`; `List`/`ListItem`; `Dialog` for unplug/rail-short prompts; optional MUI X `DataGrid` for dense telemetry on desktop.

```text
+----------------------------------------------------------------------------+
| Bench verification                                                        |
| [1 Connect board] → [2 Safe firmware] → [3 Self-test] → [4 Diagnose]     |
+----------------------------------------------------------------------------+
| Board: ● Not connected       Cable: —       [Connect board]               |
|                                                                            |
| Before wiring: connect the bare board and flash the safe firmware.        |
| [Flash safe firmware]                                                       |
|                                                                            |
| Checkpoint 1: rails only                                                   |
| [Alert] If the board resets or USB disappears: unplug now.                 |
|                                                                            |
| Telemetry                                                                  |
| [✓] VCC normal   [✓] USB stable   [—] Button   [—] Light sensor           |
|                                                                            |
|                         [Stop] [I am ready for the next step]              |
+----------------------------------------------------------------------------+
```

The web app must make a physical wait state explicit: “Waiting for you at the bench,” not a spinner that appears broken. Keep flash/self-test controls disabled until the authenticated bench session and correct revision are present.

### 5. Build Mode (phone)

**Composition:** MUI `AppBar`; `MobileStepper`; one `Card`; `CardMedia` or SVG; `Typography`; `Chip`; `IconButton` with accessible labels; full-width `Button`; `SwipeableDrawer` for the full checklist; `Snackbar`/`Alert` for a short status.

```text
+---------------------------+
| ← Moon lamp       3 / 8   |
+---------------------------+
|                           |
|       [step image]        |
|    highlighted R1 lead    |
|                           |
|  Step 3: Place the        |
|  220-ohm resistor        |
|                           |
|  R1: E12 → E16            |
|  USB unplugged             |
|                           |
|  [I did this]              |
|  [< Previous] [Next >]    |
|                           |
|  ● Waiting for laptop     |
+---------------------------+
```

Poll mission state every 1–2 seconds as planned. Do not stream a large desktop transcript to the phone; show the current step, one check, and the next action. Preserve the last step offline and explain when the connection is stale.

### 6. Settings / Connections

**Composition:** MUI `Tabs`; `List`; `ListItem`; `ListItemSecondaryAction`; `Switch`; `Select`; `FormControl`/`FormLabel`; `Button`; `Dialog`; `Alert`; MUI Icons.

```text
+--------------------------------------------------------------------+
| Settings                                                           |
| [Connections] [Permissions] [Accessibility]                       |
+--------------------------------------------------------------------+
| Connections                                                        |
| Claude Code      Not connected       [Connect]                     |
| iMessage CAPCOM  Not linked          [Link phone]                  |
| Bench session    This laptop         [Manage]                       |
|                                                                    |
| Default mission mode: [Review ▾]                                   |
| Always ask before flashing: [On]                                  |
| Reduced motion:              [Use device setting]                  |
|                                                                    |
| [Save]  [Cancel]                                                   |
+--------------------------------------------------------------------+
```

Use explicit connection states (“Connected to this laptop,” “Needs sign-in,” “Waiting for first message”) and explain what a connection can do. Never display a bearer token or API key in a text field.

## Accessibility and mobile basics

- **Color is supplementary.** WCAG 2.2 SC 1.4.1 says color must not be the only visual means of conveying information ([W3C](https://www.w3.org/WAI/WCAG22/Understanding/use-of-color.html)). Every console light has text (`GO`, `NO-GO`, `Waiting`), an icon/shape, and an accessible name. Never use red/green alone for electrical status.
- **Contrast.** WCAG 2.2 SC 1.4.3 requires 4.5:1 for normal text and 3:1 for large text ([W3C](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html)). Audit the dark Mission Control palette, disabled text, code blocks, chart labels, and focus outlines; do not copy MUI's default dark gray blindly for critical status text.
- **Focus and keyboard.** WCAG requires a visible keyboard focus indicator ([W3C](https://www.w3.org/WAI/WCAG22/Understanding/focus-visible.html)). Do not remove MUI focus rings. Keep the mode selector, approval buttons, stop button, artifact tabs, and tool-card disclosures keyboard reachable. MUI X Chat's roving message list gives one Tab stop; custom controls inside a message must follow its drill-in model.
- **Touch.** WCAG 2.2 SC 2.5.8 sets a 24×24 CSS-pixel minimum target or sufficient spacing ([W3C](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html)). Use at least 44px visual/action rows for phone navigation and approval actions as a usability target, with gaps between Allow/Deny/Always. Do not place three icon-only buttons edge-to-edge.
- **Reduced motion.** WCAG's animation criterion says interaction-triggered motion must be disableable and recommends `prefers-reduced-motion` ([W3C](https://www.w3.org/WAI/WCAG22/Understanding/animation-from-interactions.html)). MUI X Chat's accessibility page says its skeleton shimmer pauses automatically for reduced motion. ViBread must additionally disable tool-card expand animation, typing cursor effects, simulation replay motion, ghost-lead animations, and celebration effects when `useMediaQuery('(prefers-reduced-motion: reduce)')` is true.
- **Streaming announcements.** MUI X Chat's built-in `role="log"`, `aria-live="polite"`, `aria-busy`, and one start/complete status announcement are preferable to announcing every token. Keep tool status updates short and debounced; use `aria-live="polite"` for “Checking the circuit” and “Check complete,” not raw JSON deltas.
- **Mobile layout.** Use ChatBox's `overlay`/`split` behavior for the conversation sidebar, and MUI `SwipeableDrawer` for the mission/task drawer. Keep one primary action visible above the safe-area inset. Replace desktop Data Grid with a stacked `List`/`Card` on phone; charts need an accessible text summary. Preserve 16px or larger readable body text and avoid horizontal scrolling for approval cards.
- **Hardware safety copy.** The phone never claims to flash or connect to Web Serial. It says “Follow this step on the laptop” and shows a stale/offline badge if polling stops. The laptop Bench panel owns the USB permission and physical action.

## Styling and library composition

### Recommended dependency set

| Purpose | Package | Snapshot/license | Use |
|---|---|---|---|
| Theme/layout/forms/overlays | `@mui/material` + Emotion | 9.4.0 / MIT; Emotion 11.14.x | All screens, dark theme, responsive drawers, dialogs, buttons, text, lists, tabs |
| Icons | `@mui/icons-material` | 9.4.0 / MIT | Stop, check, warning, cable, phone, settings, navigation |
| Agent chat | `@mui/x-chat` | 9.0.0-alpha.18 / MIT; Community only | ChatBox, stream state, tool parts, approvals, attachments, responsive layout, accessible message list |
| Artifact table/tree/chart | `@mui/x-data-grid`, `@mui/x-tree-view`, `@mui/x-charts` | 9.14.0 / MIT Community | Desktop telemetry, optional hierarchy, simulation/telemetry summaries; load lazily |
| Stream Markdown | `react-markdown` | 10.1.0 / MIT | Safe virtual-DOM rendering; custom MUI component map |
| Code | `react-syntax-highlighter` + `@types/react-syntax-highlighter` | 16.1.1 / MIT + 15.5.13 types | Arduino/C++/JSON blocks; explicit props, no raw HTML |
| Build tool | Vite | 8.3.1 / MIT | React SPA dev/build |

Do not add Tailwind, shadcn/ui, AI Elements, or Prompt Kit to this MUI plan. They would introduce a second styling/component distribution convention. The native MUI X Chat package is the MUI-compatible AI chat component that the previous generic-library search lacked.

### MUI theme direction

Use `ThemeProvider` + `CssBaseline`, `palette.mode: 'dark'`, and theme component overrides. Add a restrained mission palette: near-black blue-gray canvas; light-blue primary action; white/near-white body text; green/amber/red status colors each paired with labels/icons; thin divider borders; restrained shadows. Set code and schematic surfaces explicitly rather than relying on inherited body colors. Use `sx` for local layout and `styleOverrides` for reusable component states. Keep all buttons and status colors in the theme so the phone and desktop surfaces share semantics.

### Backend adapter shape

The preferred adapter contract is the installed MUI X `ChatAdapter`:

- `sendMessage({ conversationId, message, messages, attachments, metadata, signal })` → `ReadableStream<ChatMessageChunk | ChatStreamEnvelope>`.
- optional `listConversations`/`listMessages` for mission history;
- optional `reconnectToStream` for an interrupted design run;
- optional `addToolApprovalResponse({ id, approved, reason })` for the ViBread approval broker;
- optional `stop()` for explicit server cancellation.

Map Claude Agent SDK stream events to this contract in one file. Use `ChatStreamEnvelope.eventId` and `sequence` from the event broker for deduplication/order. Register typed `ChatToolDefinitionMap` entries for the six ViBread tool groups where the input/output schema is known; use dynamic tool chunks for generic/unverified tools. Register custom `partRenderers` for tool cards, telemetry widgets, and artifact links.

## Recommended changes

1. Replace the web-stack line in `PLAN.md` with MUI Core/Icons, MUI X Community, and pinned `@mui/x-chat@9.0.0-alpha.18`; record that Chat is alpha and Community MIT.
2. Implement and smoke-test `packages/web/chat-adapter.ts` against a fixture SSE stream: text, reasoning, tool input, approval request, output, finish, abort, reconnect ordering, and duplicate `eventId`.
3. Use `ChatBox` for the chat column, `partRenderers`/`toolSlots` for “Checking…” cards, and a custom approval renderer for Allow once / Always for this mission / Deny. Keep the broker authoritative; UI decisions are not authorization.
4. Use MUI `Select` for the Plan/Ask every time/Review/Autopilot selector and `List` for tasks; do not put mission state only in chat messages.
5. Use MUI `Tabs` and lazy-loaded X Community components for the artifact canvas. Use a phone-specific `Card`/`MobileStepper` Build Mode instead of trying to squeeze the desktop canvas into a phone.
6. Add a strict CI smoke with the exact dependency versions and no paid MUI X packages. Keep the assistant-ui MUI smoke as a fallback check until the MUI X Chat alpha exits early development.
7. Deep-import icons, code-split Data Grid/Charts, and verify the production bundle after wiring the real screen. The broad isolated smoke built successfully but was 2.5 MB because it intentionally imported every candidate surface.
8. Add the copy/accessibility rules above to the UI acceptance checklist: no color-only status, visible focus, 24px minimum (44px preferred touch targets), reduced motion, polite streaming announcements, and laptop-only Web Serial copy.
9. Document MIT notices and the commercial exclusion for MUI X Pro/Premium. Do not install a paid package for artifact-table features that Community can provide.
10. Re-audit `@mui/x-chat` immediately before feature freeze. If alpha API churn blocks the demo, switch the chat column to `@assistant-ui/react` ExternalStoreRuntime and retain MUI for every visible component.

## Sources

### MUI and package evidence

- npm commands run from `/tmp/audit/a7`: `npm install --ignore-scripts --no-audit --no-fund @mui/material@latest @mui/icons-material@latest @mui/x-data-grid@latest @mui/x-tree-view@latest @mui/x-charts@latest @mui/x-chat@latest @emotion/react@latest @emotion/styled@latest @chatscope/chat-ui-kit-react@latest @chatscope/chat-ui-kit-styles@latest react-markdown@latest react-syntax-highlighter@latest vite@latest`; `npm ls --depth=0`; `npm view <package> version license time.modified repository.url ...`.
- Local package excerpts: `/tmp/audit/a7/node_modules/@mui/material/package.json` (9.4.0, MIT, React 19 peers); `/tmp/audit/a7/node_modules/@mui/icons-material/package.json` (9.4.0, MIT); `/tmp/audit/a7/node_modules/@mui/x-data-grid/package.json`, `@mui/x-tree-view/package.json`, and `@mui/x-charts/package.json` (9.14.0, MIT Community); `/tmp/audit/a7/node_modules/@mui/x-chat/package.json` (9.0.0-alpha.18, MIT, React 19 peers); `/tmp/audit/a7/node_modules/@mui/material/LICENSE`, `@mui/icons-material/LICENSE`, and `@mui/x-data-grid/LICENSE`.
- [MUI installation](https://mui.com/material-ui/getting-started/installation/)
- [MUI official Vite examples](https://mui.com/material-ui/getting-started/example-projects/)
- [MUI dark mode](https://mui.com/material-ui/customization/dark-mode/)
- [MUI theming](https://mui.com/material-ui/customization/theming/)
- [MUI responsive UI](https://mui.com/material-ui/guides/responsive-ui/)
- [MUI Drawer](https://mui.com/material-ui/react-drawer/)
- [MUI X licensing](https://mui.com/x/introduction/licensing/)
- [MUI X Chat overview](https://mui.com/x/react-chat/)
- [MUI X Chat quickstart](https://mui.com/x/react-chat/quickstart/)
- [MUI X Chat adapters](https://mui.com/x/react-chat/backend/adapters/)
- [MUI X Chat streaming](https://mui.com/x/react-chat/behavior/streaming/)
- [MUI X Chat tool calling](https://mui.com/x/react-chat/ai-and-agents/tool-calling/)
- [MUI X Chat tool approval](https://mui.com/x/react-chat/ai-and-agents/tool-approval/)
- [MUI X Chat tool renderer/part registry](https://mui.com/x/react-chat/core/examples/tool-approval-and-renderers/)
- [MUI X Chat agentic example](https://mui.com/x/react-chat/material/examples/agentic-code/)
- [MUI X Chat accessibility](https://mui.com/x/react-chat/accessibility/)
- [MUI X Chat structure and slots](https://mui.com/x/react-chat/customization/structure/)

### Alternative library evidence

- [assistant-ui ExternalStoreRuntime](https://www.assistant-ui.com/docs/runtimes/custom/external-store) and local `/tmp/audit/a7/node_modules/@assistant-ui/react/package.json`, `/tmp/audit/a7/node_modules/@assistant-ui/core/dist/runtimes/external-store/external-store-adapter.d.ts`.
- [assistant-ui Tool UI](https://www.assistant-ui.com/docs/tools/tool-ui)
- [CopilotKit v2 reference](https://docs.copilotkit.ai/reference/v2) and [AG-UI backend](https://docs.copilotkit.ai/backend/ag-ui)
- Local `/tmp/audit/a7/node_modules/@chatscope/chat-ui-kit-react/README.md` and package metadata; [Chatscope repository](https://github.com/chatscope/chat-ui-kit-react)
- [react-markdown README](https://github.com/remarkjs/react-markdown#readme)
- Local `/tmp/audit/a7/node_modules/react-syntax-highlighter/README.md`
- [Lucide license](https://lucide.dev/license) (not selected for this MUI-only stack)

### Claude Code and accessibility evidence

- [Claude Code permission modes](https://code.claude.com/docs/en/permission-modes)
- [Claude Code permissions](https://code.claude.com/docs/en/permissions)
- [Agent SDK permissions](https://code.claude.com/docs/en/agent-sdk/permissions)
- [Interactive mode](https://code.claude.com/docs/en/interactive-mode)
- [Agent SDK streaming output](https://code.claude.com/docs/en/agent-sdk/streaming-output)
- [Agent SDK todo tracking](https://code.claude.com/docs/en/agent-sdk/todo-tracking)
- [Agent SDK approvals and user input](https://code.claude.com/docs/en/agent-sdk/user-input)
- [WCAG 2.2 Use of Color](https://www.w3.org/WAI/WCAG22/Understanding/use-of-color.html)
- [WCAG 2.2 Contrast Minimum](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html)
- [WCAG 2.2 Target Size Minimum](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html)
- [WCAG 2.2 Focus Visible](https://www.w3.org/WAI/WCAG22/Understanding/focus-visible.html)
- [WCAG 2.2 Animation from Interactions](https://www.w3.org/WAI/WCAG22/Understanding/animation-from-interactions.html)
