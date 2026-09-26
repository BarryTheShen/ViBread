# A9 — Agent-harness replacement audit

## Scope

This slice evaluates replacing the Claude Agent SDK with a library-first loop over the plain Claude Messages API for ViBread. The target runtime is Node 22, with a server-held Anthropic API key and a React/MUI operator UI. No product code was changed.

All package installation and executable checks were performed in `/tmp/audit/a9`. There was no `ANTHROPIC_API_KEY`; all model-facing checks are offline: a Vercel AI SDK mock language model, a custom Anthropic `fetch`, and local MCP fixtures. Consequently, this report verifies request construction, stream/protocol behavior, and tool approval semantics, not live Claude quality, latency, quota, or billing.

The package snapshot was obtained from npm on the audit run:

```text
$ node --version && npm --version
v22.22.1
9.2.0
$ node -e "...package metadata..."
ai 7.0.116 Apache-2.0
@ai-sdk/anthropic 4.0.65 Apache-2.0
@ai-sdk/react 4.0.119 Apache-2.0
@ai-sdk/mcp 2.0.60 Apache-2.0
@modelcontextprotocol/sdk 1.30.1 MIT
@mui/x-chat 9.0.0-alpha.18 MIT
@mui/x-chat-headless 9.0.0-alpha.18 MIT
@mastra/core 1.71.0 Apache-2.0
@langchain/langgraph 1.4.18 MIT
@openai/agents 0.18.0 MIT
@anthropic-ai/sdk 0.128.0 MIT
```

## Terms conclusion (plain answer)

**Allowed choice:** ViBread may operate a hosted product for its own customers/end users using the company's own Claude API key, with usage billed to the company, when using the direct Claude Messages API under Anthropic's Commercial Terms and complying with the Usage Policy, DPA, supported-region rules, and other incorporated terms. Keep the key server-side. This is the recommended legal/product path, subject to ViBread obtaining/accepting the applicable commercial agreement and legal review of its exact product model.

**Not allowed by the default Claude Code/Agent SDK condition:** ViBread must not preinstall/run Claude Code (the binary/Agent SDK path) while paying for or intermediating Claude usage for end users. Anthropic's Claude Code legal page says each end user must authenticate with their own API key, subscription credentials, or third-party inference credential, with that usage billed directly to the end user/provider, unless Anthropic and the customer mutually agree otherwise. Replacing the Agent SDK with the direct Messages API is therefore a substantive terms-path change, not merely an implementation detail.

| Claim | Verdict | Evidence | Correct choice |
|---|---|---|---|
| Commercial Terms permit a customer to power a product for its own end users. | **Correct** | Current [Commercial Terms of Service](https://www.anthropic.com/legal/commercial-terms), effective June 17, 2025, §A.1: “Subject to these Terms, Anthropic gives Customer permission to use the Services, including to power products and services Customer makes available to its own customers and end users (‘Users’).” | Use direct Messages API from ViBread's server. |
| Company-key usage can be billed to the company. | **Correct, subject to the terms** | Same terms §H.1: “Customer is responsible for fees incurred by its account.” §D.5 also makes Customer responsible for activity under its account. The API overview at <https://platform.claude.com/docs/en/api/overview> states the prerequisite is “A Claude Console account” and “An API key”; its authentication table says `x-api-key` is “Your API key from Console.” | Keep the server key in a secret manager; meter/limit per tenant; do not expose it to browsers. |
| The commercial permission is unlimited resale. | **Incorrect** | Commercial Terms §D.4 prohibits access “to build a competing product or service ... or resell the Services except as expressly approved by Anthropic.” The A.1 permission is for powering the customer's product, not a blanket waiver of D.4. | Describe ViBread as a product powered by the API, not as an API-key resale; ask Anthropic/sales for written approval if the exact business model could be characterized as resale or intermediation. |
| Claude Code/Agent SDK may be run in a hosted product with the company paying for all end-user calls by default. | **Incorrect** | [Claude Code Legal and Compliance](https://code.claude.com/docs/en/legal-and-compliance), “Can customers offer Claude Code in their products?”: “Customers may not pay for, resell, or intermediate Claude usage on their end users' behalf. Each end user must authenticate with their own Anthropic API key, Claude subscription plan credentials, or 3P inference provider credential ... That usage is billed directly to the end user.” | Do not use Claude Agent SDK/Claude Code for this hosted flow without a separate written agreement. |
| The direct Messages API has the same end-user credential condition. | **Unverified as a negative claim; positive permission is documented** | The Commercial Terms' explicit A.1 customer/end-user permission and H.1 customer billing allocation apply to API-key Services. The Messages reference documents `POST /v1/messages` with text/image content and API-key authentication, but does not impose a bring-your-own-key requirement on each end user. | Treat Commercial Terms + exact contract as controlling; do not infer permission to violate D.4/Usage Policy. |

## Verification table

| Claim | Verdict | Evidence | Correct choice |
|---|---|---|---|
| `ai`, `@ai-sdk/anthropic`, `@ai-sdk/react`, and `@ai-sdk/mcp` are Apache-2.0 and support Node 22. | **Correct** | Local package excerpts: `node_modules/ai/package.json` lines 2–6, 74–75 (`version: 7.0.116`, `license: Apache-2.0`, `engines.node: >=22`); `@ai-sdk/anthropic/package.json` lines 2–5, 52–54; `@ai-sdk/react/package.json` lines 1–5, 57–59; `@ai-sdk/mcp/package.json` lines 1–5, 52–54. `node --version` was `v22.22.1`. `ai/LICENSE` lines 1–13 is Apache 2.0 text. | Pin the exact versions listed below; Node 22 is in the declared engine range. |
| AI SDK supplies an agent loop. | **Correct** | Installed docs `ai/docs/03-agents/02-building-agents.mdx` lines 6–8: “The ToolLoopAgent ... handles the agent loop for you”; lines 213–235 document `stopWhen`, the default 20-step bound, and stop behavior. `ai/docs/03-agents/04-loop-control.mdx` lines 15–23 and 25–45 document `stopWhen`, `isStepCount`, and loop continuation after tool calls. | Use `ToolLoopAgent` for a reusable mission agent or `streamText` with `stopWhen: isStepCount(...)` at the HTTP boundary. Set a finite bound. |
| Approval can be decided per tool call by ViBread code. | **Correct** | `ai/src/generate-text/tool-approval-configuration.ts` lines 14–36 defines `not-applicable`, `approved`, `denied`, and `user-approval`; lines 38–94 define per-tool and generic callbacks receiving parsed input, `toolCall`, messages, tool context, and runtime context; lines 97–131 define the per-tool map. Installed docs `ai/docs/03-agents/06-tool-approvals.mdx` lines 64–96 show input-dependent approval and lines 98–139 show one generic policy and runtime context. Lines 137–166 show `prepareCall` selecting approval per request. | Map the mission permission mode to `toolApproval` (preferred) and optionally `experimental_toolApprovalSecret` for server verification. The older tool-level `needsApproval` property exists but is marked deprecated in `@ai-sdk/provider-utils/src/types/tool.ts` lines 109–120 and AI docs lines 410–413. |
| Manual approval is represented as request/response parts. | **Correct** | `ai/docs/03-agents/06-tool-approvals.mdx` lines 168–207 describes `tool-approval-request`, adding a `tool-approval-response` to the tool message, then calling the agent again. `ai/docs/04-ai-sdk-ui/03-chatbot-tool-usage.mdx` lines 398–451 shows `streamText` + `toolApproval: { getWeather: 'user-approval' }`; lines 454–559 document `approval-requested`, `approval-responded`, `output-denied`, `approval.id`, `requestReason`, and `addToolApprovalResponse`. | Persist the approval ID and exact tool-call input in the mission store; only accept approval responses for a live, authenticated mission/revision. |
| `useChat` streams to a React client via an HTTP/SSE transport that can target Express. | **Correct** | `@ai-sdk/react/src/use-chat.ts` lines 20–48 expose `messages`, `sendMessage`, `stop`, `resumeStream`, and `addToolApprovalResponse`; lines 50–69 expose transport and `resume`. Installed docs `ai/docs/04-ai-sdk-ui/02-chatbot.mdx` lines 20–109 show `useChat` with `DefaultChatTransport({api:'/api/chat'})` and `createUIMessageStreamResponse({stream: toUIMessageStream(...)})`. `ai/docs/04-ai-sdk-ui/50-stream-protocol.mdx` lines 113–122 says data streams use SSE and need `x-vercel-ai-ui-message-stream: v1` for a custom backend. `ai/src/ui-message-stream/pipe-ui-message-stream-to-response.ts` lines 9–19, 21–49 provides the Node helper that transforms chunks to SSE and writes to a Node `ServerResponse`. | In Express use `pipeUIMessageStreamToResponse({ response: res, stream: result.toUIMessageStream() })`; use `DefaultChatTransport` (or a small custom transport) pointed at `/api/chat`. |
| UI message parts include tool-call states and approval state. | **Correct** | `ai/docs/04-ai-sdk-ui/03-chatbot-tool-usage.mdx` lines 126–134 lists `approval-requested`, `approval-responded`, and `output-denied`; lines 180–305 show exhaustive handling of `input-streaming`, `input-available`, approval, output, error, and denied states. | Render `message.parts`, not a string-only content field; render approval and denial states explicitly. |
| `useChat` has abort/stop and resume-after-reload. | **Correct with server obligations** | `@ai-sdk/react/src/use-chat.ts` lines 20–48 expose `stop` and `resumeStream`; lines 232–255 wire `resume` and return the methods. `ai/docs/04-ai-sdk-ui/03-chatbot-resume-streams.mdx` lines 21–45 says resumption requires application persistence, Redis/resumable-stream, a POST creator endpoint, and a GET resume endpoint; lines 48–91 show `resume: true` and `GET /api/chat/[id]/stream`; lines 260–263 warn that `stop()` on a resumable stream is a disconnect, not cancellation. | Implement durable stream storage and a separate authenticated stop endpoint. Do not claim that `stop()` cancels server work in resumable mode. |
| The React layer is UI-library agnostic and can be rendered with Material UI. | **Correct** | `@ai-sdk/react/src/use-chat.ts` imports React and AI types only; there is no shadcn or CSS dependency. `ai/docs/04-ai-sdk-ui/02-chatbot.mdx` lines 8–16 describes managed state/integration, and lines 39–66 render plain `<div>`/`<button>` elements rather than prescribing a component library. | Use MUI components for rendering `messages`/`parts`; AI SDK supplies state/transport, not a required design system. |
| MUI X Chat can consume the AI UI stream. | **Correct, with a thin compatibility layer** | Installed `@mui/x-chat-headless/adapters/createAiSdkAdapter.d.ts` lines 5–21: “The AI SDK protocol is a near-superset of `ChatMessageChunk`; the only shape exclusive to AI SDK that we handle specially is the `error` chunk.” Lines 39–51 accept an object `ReadableStream` from `toUIMessageStream()` or response bytes from `toUIMessageStreamResponse()` and decode NDJSON/SSE. `chat-stream.d.ts` lines 4–177 lists MUI's chunk union. MUI adapter runtime lines 51–105 injects synthetic message IDs when AI's bare `start`/`finish` omits one and lines 175–182 accepts object chunks. | Use `createAiSdkAdapter({stream})` for token streaming, or write a ViBread adapter around the same protocol if approval/reconnect endpoints are needed. |
| MUI and AI chunk names/shapes are identical. | **Partial / not identical** | Names are substantially the same: `start`, `text-start/delta/end`, `reasoning-start/delta/end`, `tool-input-start/delta/available`, `tool-approval-request`, `tool-output-available/error/denied`, `start-step`, `finish-step`, `finish`, and `abort` appear in MUI `chat-stream.d.ts` lines 4–177 and AI examples in `ai/docs/04-ai-sdk-ui/50-stream-protocol.mdx` lines 322–438. Shape differences: MUI's `start`/`finish` interfaces require `messageId` (MUI d.ts lines 4–16), while bare AI object streams may omit it; MUI's approval-request type statically includes `toolName` and `input` (lines 95–118), while AI's documented approval chunk is `{toolCallId, approvalId, approvalDescriptor?, reason?}` (AI docs lines 361–378), relying on the preceding `tool-input-available` chunk for name/input. | Treat the protocols as structurally compatible, not type-identical. Let the MUI adapter inject IDs; preserve prior tool-input parts; add a tested mapping/adapter rather than blindly asserting the unions are equal. |
| MUI's stock AI adapter completes the approval round trip. | **Incorrect** | `createAiSdkAdapter.d.ts` lines 106–120 advertises only `sendMessage`/`regenerate` for the `{stream}` adapter. Runtime `createAiSdkAdapter.mjs` lines 311–350 returns only `sendMessage` and `regenerate`. The MUI `ChatAdapter` type declares optional `addToolApprovalResponse` (`adapters/chatAdapter.d.ts` lines 65–109), and `useChatController.mjs` lines 95–142 optimistically updates the UI then calls `adapter.addToolApprovalResponse?.(...)`; the stock AI adapter does not implement it. | Add `addToolApprovalResponse({id, approved, reason})` to a ViBread adapter/wrapper that POSTs to the mission approval endpoint and causes the server to continue with an AI `tool-approval-response`. Also implement `reconnectToStream` if MUI-side resume is required. |
| Anthropic provider supports `claude-opus-5-5`, images, structured output, and prompt caching. | **Correct** | `@ai-sdk/anthropic/src/anthropic-language-model-options.ts` lines 4–27 includes `claude-opus-5-5` in `AnthropicModelId`. Provider docs `@ai-sdk/anthropic/docs/05-anthropic.mdx` lines 64–94 cover Messages API models and `Output`; lines 200–206 document native structured output for `claude-opus-5-5`; lines 2138–2144 show the model capability table with checks for Image Input and Object Generation. Lines 916–960 document `cacheControl: { type: 'ephemeral' }` and cache-read/write usage. Source `anthropic-provider.ts` lines 136–139 advertises `image/*` URL support and lines 150–168 show server-side API-key headers. | Use `anthropic('claude-opus-5-5')`, `Output.object(...)`, image `file`/base64 content, and provider-specific cache breakpoints. Validate prompt-cache minimum lengths and model limits before relying on cache savings. |
| The provider really serializes those features to the Messages API. | **Verified offline** | Command: `node /tmp/audit/a9/anthropic-serialization.mjs`. The custom `fetch` returned a synthetic response and printed the captured request; observed `url: https://api.anthropic.com/v1/messages`, `model: claude-opus-5-5`, `output_config.format.type: json_schema`, an image block with `source.type: base64`, `media_type: image/png`, and `cache_control.type: ephemeral`. Output was `{"ok":true}`. No Anthropic network request or key was used. | Keep this as a request-serialization regression smoke; live API compatibility still needs credentials and a separate integration run. |
| `@ai-sdk/mcp` connects to stdio and Streamable HTTP and converts tools for AI SDK calls. | **Correct** | `@ai-sdk/mcp/README.md` lines 24–60 shows `createMCPClient`, `await mcpClient.tools()`, passing the result to `generateText`, and `close()`. Lines 100–166 document HTTP (`type:'http'`), SSE, and `Experimental_StdioMCPTransport` from `@ai-sdk/mcp/mcp-stdio`. Source `mcp-client.ts` lines 237–295 defines config and `createMCPClient`; lines 320–347 define `tools()`, `callTool()`, and `toolsFromDefinitions`. Source `mcp-transport.ts` lines 109–195 defines `type:'sse' | 'http'`; stdio source lines 8–32 defines command/args and the child-process transport. | Fetch MCP tools once per agent/session, pass the returned tool set to `ToolLoopAgent`/`streamText`, and close the client when the run ends. |
| Streamable HTTP works with the installed AI SDK client. | **Verified offline against a local protocol fixture; version caveat recorded** | Command: `node /tmp/audit/a9/mcp-http-modern-smoke.mjs` returned `{ "tools": ["ping"], "result": {"content":[{"type":"text","text":"pong-http-modern"}],"isError":false} }`. The fixture accepted local HTTP POST JSON-RPC with protocol `2026-07-28`, and the AI SDK client used `type:'http'`. An attempted direct pairing with `@modelcontextprotocol/sdk@1.30.1`'s `StreamableHTTPServerTransport` exposed a compatibility issue: that server advertises/supports through `2025-11-25`, while `@ai-sdk/mcp@2.0.60` defaults to current `2026-07-28` discovery; the server returned an unsupported-protocol error (the first attempt also showed the legacy inbound-SSE behavior). | Pin/coordinate MCP protocol versions in deployment. For an external Claude Code endpoint, use the MCP SDK server transport with the protocol version Claude Code supports; do not assume `@modelcontextprotocol/sdk@1.30.1` and current `@ai-sdk/mcp@2.0.60` are wire-compatible without an explicit compatibility test. |
| In-process MCP works through MCP SDK `InMemoryTransport`. | **Verified** | `@modelcontextprotocol/sdk@1.30.1/dist/esm/inMemory.d.ts` lines 5–29 documents the class, linked-pair factory, `start`, `close`, `send`, and `onmessage`. Command: `node /tmp/audit/a9/mcp-inmemory-smoke.mjs` returned server `vibread-domain`, tool `validate_ir`, and text result `{"valid":true,"revision":"r7"}`. The fixture passed one linked transport directly to `createMCPClient` and the other to an MCP SDK `Server`. | Define ViBread domain handlers once, expose an in-process MCP server/client pair to the agent, and separately expose the same handler registry through a Streamable HTTP server for external clients. |
| The AI SDK MCP client works over local stdio. | **Verified** | Command: `node /tmp/audit/a9/mcp-stdio-smoke.mjs` spawned the local MCP fixture through `Experimental_StdioMCPTransport`; output was `tools:["ping"]` and `text:"pong"`. | Use stdio only for trusted local processes; validate command/args and environment, and prefer HTTP with authentication for external deployment. |
| The approval smoke is genuinely offline and emits the expected UI parts. | **Verified** | Command: `node /tmp/audit/a9/approval-smoke.mjs` used `MockLanguageModelV4` from `ai/test`, a streamed tool call, `stopWhen:isStepCount(3)`, and a per-call approval function. Output included `tool-input-start`, `tool-input-delta`, `tool-input-available` (parsed `{part:"LED",pin:13}`), `tool-approval-request` with reason `Review LED on pin 13`, `finish-step`, and `finish` with `finishReason:"tool-calls"`; `executions` was `0`. Thus approval prevented the tool handler from running. `ai/docs/03-ai-sdk-core/55-testing.mdx` lines 11–23 documents `MockLanguageModelV4` and no-provider-call testing. | Keep this as the approval/stream contract smoke. A second run with a persisted response must verify that approved calls execute exactly once. |
| MUI can parse the approval stream itself. | **Verified** | Command: `node /tmp/audit/a9/mui-approval-stream-smoke.mjs` piped `MockLanguageModelV4` → `streamText` → `toUIMessageStream()` → `@mui/x-chat-headless` `createAiSdkAdapter`. Output contained injected `start.messageId:"ai-sdk-msg-1"`, `tool-input-start`, `tool-input-delta`, `tool-input-available`, `tool-approval-request`, `finish-step`, and `finish.messageId`. A text-only variant `node /tmp/audit/a9/mui-ai-stream-smoke.mjs` also produced start/text/finish chunks. | Use the MUI adapter for parsing, but supply the missing approval/reconnect callbacks described above. |
| MCP SDK `InMemoryTransport` permits both agent-in-process use and an external Claude Code server. | **Partial / design supported, not one transport instance** | The local in-process smoke proves the first path. The SDK declaration says one linked transport is passed to a Client and one to a Server; a transport is a connection, not a broadcast bus. The same domain handler functions can be registered on (a) an in-memory server for ViBread's agent and (b) a separate Streamable HTTP server for Claude Code. | Share handler/schema code, not a single live transport or mutable server session. Authenticate and authorize external HTTP calls independently. |

## Recommended harness and exact pins

```text
ai@7.0.116
@ai-sdk/anthropic@4.0.65
@ai-sdk/react@4.0.119
@ai-sdk/mcp@2.0.60
@modelcontextprotocol/sdk@1.30.1
zod@4.6.5
express@5.1.0                 # route/HTTP integration, not required by AI SDK
```

All four `@ai-sdk/*` packages are Apache-2.0 and declare `node >=22`. The MCP TypeScript SDK is MIT and declares `node >=18`; it is used for ViBread's MCP server implementation and `InMemoryTransport`, not as the agent loop. MUI X Chat is an optional UI package, MIT, and was audited at `@mui/x-chat@9.0.0-alpha.18` (its headless dependency is the same version).

Suggested server shape:

```ts
import { anthropic } from '@ai-sdk/anthropic';
import {
  ToolLoopAgent, isStepCount, pipeUIMessageStreamToResponse,
} from 'ai';
import { createMCPClient } from '@ai-sdk/mcp';

const mcp = await createMCPClient({
  transport: { type: 'http', url: process.env.VIBREAD_MCP_URL! },
});
const domainTools = await mcp.tools();
const agent = new ToolLoopAgent({
  model: anthropic('claude-opus-5-5'),
  instructions: 'ViBread mission instructions...',
  tools: domainTools,
  stopWhen: isStepCount(20),
  // toolApproval is selected per request/mission; see mapping below.
});

app.post('/api/chat', async (req, res) => {
  const result = await agent.stream({
    messages: await convertToModelMessages(req.body.messages),
    // policy/runtime context supplied by the authenticated mission
  });
  await pipeUIMessageStreamToResponse({
    response: res,
    stream: result.toUIMessageStream(),
  });
});
```

The exact call-option names and message validation should be type-checked against the installed `ai` version; the code above is the integration shape, not product code. Use `streamText` directly if a route-specific agent object is simpler. Do not rely on browser-provided history alone for authorization: configure `experimental_toolApprovalSecret`, bind approval IDs to the mission/revision hash, and re-evaluate policy server-side.

## Integration notes

### Permission-mode mapping

The library has four relevant decisions: `not-applicable`/`approved` (execute), `user-approval` (pause and emit an approval request), and `denied` (never execute). ViBread's authenticated `ApprovalBroker` remains authoritative; AI SDK approval is the loop/UI primitive, not an identity or authorization system.

| ViBread mode | AI SDK primitive | Policy implementation |
|---|---|---|
| **Plan** — propose only | Automatic deny for every executable domain tool (`toolApproval: ({toolCall}) => ({type:'denied', reason:'Plan mode: proposal only'})`), or expose schema-only tools with no `execute` function so the loop stops after the proposal | Persist/render the tool input as the plan. Never call physical or software handlers. Automatic denial is safer than relying on model instructions. |
| **Ask every time** | Generic `toolApproval` callback returns `'user-approval'` for every call | Emit `tool-approval-request`; only the authenticated approval broker can answer. The browser/MUI response is an untrusted request until revalidated. |
| **Review (default)** — software auto, revision/release asks | Generic callback or per-tool map: read/compile/check/simulate/layout tools return `'approved'` (or `undefined` for ordinary execution); `propose_design`, revision commit, release/flash, and any irreversible mutation return `'user-approval'` | Include tool name, parsed args, mission phase, revision hash, and actor in policy. Physical operations remain human-only even if a software tool is auto-approved. |
| **Autopilot** — software auto; physical never automatic | Software tools return `'approved'`; physical/bench/flash/power actions return `'user-approval'` (never `'approved'`). If “never” is intended to mean forbidden even after a human decision, return `{type:'denied'}` instead. | Keep a hard server-side physical allowlist and authenticated human requirement. Autopilot must not bypass the broker. |

`prepareCall` can produce a different `toolApproval` configuration for each request; a generic callback can inspect the current tool call and runtime context. This directly supports mission modes without rebuilding tool definitions.

### Approval and MUI

AI SDK `useChat` handles approval round trips with `addToolApprovalResponse({id, approved, reason})` and `sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses`. MUI X Chat exposes the same-looking callback shape, but `createAiSdkAdapter({stream})` does **not** implement it. Therefore the production MUI adapter should wrap the stock adapter and add:

1. `addToolApprovalResponse` that sends `{missionId, approvalId, approved, reason, revisionHash}` to an authenticated ViBread endpoint;
2. a server handler that validates mission/revision/actor, reconstructs the AI tool approval response, and resumes the agent;
3. `reconnectToStream` plus durable cursor/storage if page-reload resume is required;
4. `stop` that reaches the server's cancellation endpoint for resumable work.

The MUI adapter's approval request does not need to duplicate tool name/input in every chunk at runtime: AI's preceding `tool-input-available` part carries them. Keep both parts in the message store for rendering/audit.

### Express/SSE, abort, and resume

Use `pipeUIMessageStreamToResponse` rather than manually writing `data:` lines. It sets the UI message stream headers and SSE framing. `DefaultChatTransport` can point to `/api/chat`, with bearer/cookie headers supplied by a function. For page reload recovery, persist the chat ID, message history, active stream ID, and SSE chunks (for example Redis + `resumable-stream`) and implement both POST and GET `/api/chat/:id/stream`. In resumable mode a browser `stop()` closes the current connection; a separate authenticated stop endpoint must cancel the server's generation if cancellation is desired.

### MCP topology

The domain-tool registry should be the common schema/handler layer. Register it into a ViBread MCP server for the agent's in-process `InMemoryTransport`, and register a separate server/transport instance for external Streamable HTTP. Claude Code can consume the external endpoint with its MCP configuration. Do not share a mutable live `Server`/transport across two clients; share handlers and schemas and enforce per-transport auth/policy.

The installed MCP SDK server (`1.30.1`) and current AI SDK MCP client (`2.0.60`) have a protocol-version compatibility edge: the client defaults to `2026-07-28`, while the installed server declaration supports through `2025-11-25`. The local modern HTTP fixture passed when both sides spoke `2026-07-28`; the direct SDK-server attempt exposed the mismatch. Pin an explicit protocol or upgrade the server package together with the deployment. This does not affect the `InMemoryTransport` proof, but it is a release gate for external HTTP/Claude Code interoperability.

### Anthropic request features

The custom-fetch serialization probe proves that ViBread can send an image, native JSON schema output, and an ephemeral cache breakpoint through the provider without giving the browser a key. Prompt caching remains subject to Anthropic's model-specific minimum cacheable length and TTL rules. `claude-opus-5-5` uses adaptive thinking; leave output-token headroom for thinking and set the provider `effort` deliberately after live latency/cost checks.

## Alternatives

| Alternative | Installed version / license | HITL primitive evidence | Why not the recommendation |
|---|---|---|---|
| Mastra | `@mastra/core@1.71.0`, Apache-2.0, Node `>=22.13.0` (`package.json` lines 1–5, 979–981) | `dist/tools/types.d.ts` lines 21–66 defines global `requireToolApproval` (boolean or per-call function) and per-tool `needsApprovalFn`; lines 143–177 expose `suspend`/`resumeData` execution context. | Viable and strong for durable workflows, but it is a broader framework/orchestrator. ViBread already has its own mission state machine, broker, and MCP registry; AI SDK gives the needed loop/UI/approval primitives with less framework coupling. |
| LangGraph.js | `@langchain/langgraph@1.4.18`, MIT, Node `>=18` (`package.json` lines 1–18) | `dist/constants.d.ts` lines 170–229 defines `Interrupt`, `interrupt` resume schema, `isInterrupted`, and `Command.resume`; installed declarations/source docs include `interrupt`/`Command` examples. | Excellent for graph-first durable workflows, but adds a graph/checkpointer and requires more custom adapter work for the AI UI stream, provider options, and MCP tool conversion. It is an alternative if ViBread abandons its own orchestrator, not the smallest replacement. |
| OpenAI Agents SDK JS | `@openai/agents@0.18.0`, MIT; README lines 25–37 says Node 22+; `@openai/agents-core/dist/tool.d.ts` lines 220–240 defines `needsApproval`; `agent.d.ts` lines 112–121 exposes interrupted runs/approval items. | `needsApproval` boolean/function and `RunToolApprovalItem` interruptions are first-class. `Model`/`ModelProvider` interfaces (`agents-core/dist/model.d.ts` lines 531–567) allow a custom Claude Messages adapter. | HITL is good, but the Claude path would be a custom `Model`/`ModelProvider` adapter and a second UI/tool protocol. The installed package is OpenAI-centric in built-in integrations; it does not provide the direct Anthropic provider/MCP/UI path used here. |
| Anthropic TypeScript SDK beta Tool Runner | `@anthropic-ai/sdk@0.128.0`, MIT; README lines 40–48 supports Node 20 LTS+ | `lib/tools/BetaToolRunner.d.ts` lines 8–18 describes the automatic assistant/tool loop; lines 189–204 define tools and max iterations. `BetaRunnableTool.d.ts` lines 23–34 only defines `run`, `parse`, and optional `close`; no approval callback/state/UI protocol is present. | Small and direct, and its MCP helpers are useful, but ViBread would need to build per-call approval, persistence/resume, SSE/UI chunks, MUI integration, and policy binding itself. Use it only if ViBread deliberately wants a bespoke harness. |

## Sources

Primary terms/API sources:

1. Anthropic, [Commercial Terms of Service](https://www.anthropic.com/legal/commercial-terms) (effective June 17, 2025), §§A.1, D.4–D.5, H.1.
2. Anthropic, [Claude Code Legal and Compliance](https://code.claude.com/docs/en/legal-and-compliance), “Can customers offer Claude Code in their products?” and “Authentication and credential use.”
3. Anthropic, [API overview](https://platform.claude.com/docs/en/api/overview), prerequisites, authentication, API key, Messages API, and billing/workspace sections.
4. Anthropic, [Messages API reference](https://platform.claude.com/docs/en/api/messages), `POST /v1/messages`, text/image content, cache-control, and message schema.

Installed package/type/doc evidence (all under `/tmp/audit/a9/node_modules`):

5. Vercel AI SDK `ai@7.0.116`: `package.json`; `docs/03-agents/02-building-agents.mdx`, `04-loop-control.mdx`, `06-tool-approvals.mdx`, `03-ai-sdk-core/55-testing.mdx`; `src/generate-text/tool-approval-configuration.ts`; `src/ui/chat.ts`; `src/ui-message-stream/pipe-ui-message-stream-to-response.ts`. `@ai-sdk/react@4.0.119`: `src/use-chat.ts`.
6. `@ai-sdk/anthropic@4.0.65`: `package.json`; `docs/05-anthropic.mdx`; `src/anthropic-provider.ts`; `src/anthropic-language-model-options.ts`.
7. `@ai-sdk/mcp@2.0.60`: `package.json`, `README.md`, `src/tool/mcp-client.ts`, `src/tool/mcp-transport.ts`, `src/tool/mcp-stdio/mcp-stdio-transport.ts`.
8. `@modelcontextprotocol/sdk@1.30.1`: `package.json`; `dist/esm/inMemory.d.ts`; `dist/esm/server/streamableHttp.d.ts`.
9. MUI X Chat `@mui/x-chat@9.0.0-alpha.18` / `@mui/x-chat-headless@9.0.0-alpha.18`: `package.json`; `adapters/createAiSdkAdapter.d.ts` and `.mjs`; `types/chat-stream.d.ts`; `types/chat-callbacks.d.ts`; `internals/useChatController/useChatController.mjs`.
10. Alternatives: `@mastra/core@1.71.0` `dist/tools/types.d.ts` and package metadata; `@langchain/langgraph@1.4.18` `dist/constants.d.ts` and package metadata; `@openai/agents@0.18.0` README and `@openai/agents-core/dist/{model,tool,agent}.d.ts`; `@anthropic-ai/sdk@0.128.0` README and `lib/tools/{BetaToolRunner,BetaRunnableTool}.d.ts`.

Offline commands and fixtures:

```text
node approval-smoke.mjs
node anthropic-serialization.mjs
node mcp-inmemory-smoke.mjs
node mcp-stdio-smoke.mjs
node mcp-http-modern-smoke.mjs
node mui-approval-stream-smoke.mjs
node mui-ai-stream-smoke.mjs
```

These commands are evidence for the observed outputs quoted above; none contacted Anthropic.

## Recommendation

Adopt the direct Messages API through the pinned Vercel AI SDK stack (`ai` + `@ai-sdk/anthropic` + `@ai-sdk/react` + `@ai-sdk/mcp`), with ViBread's existing mission orchestrator and approval broker remaining the policy authority. Do not carry over Claude Code/Agent SDK assumptions or permissions. Treat the MUI approval/reconnect adapter and MCP protocol-version coordination as required integration work, not optional polish.
