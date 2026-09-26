# ViBread research — agent interop (A2A, MCP, Claude Code, permissions)

**Research date:** 2026-09-25 (registry/repository snapshots taken on this date)  
**Slice:** 01-agent-interop  
**Timebox assumption:** approximately 36 hours to a working demo; application code is new ViBread code, not copied from an existing project.

## 1) Scope

This slice covers the server-side ViBread agent harness, A2A v1.0 server/client interoperability, MCP v1/v2 and Claude Code compatibility, Claude Code Channels, existing A2A↔MCP bridges, and human approval routing across the web, Claude Code, and Photon Spectrum/iMessage.

The target flow is:

> A Claude Code user delegates circuit design to ViBread; ViBread can ask for information or approval; the human answers on iMessage; ViBread resumes; Claude Code receives a checked design, sketch, and assembly artifacts.

The recommendation assumes a Node 22 backend, a browser frontend, an Uno R3/Nano default board, and an SSH tunnel from the user's laptop. The board and USB serial device remain on the laptop; the server must not assume that `/dev/tty*` in the Linux container is the board.

**Protocol distinction:** MCP is a host-to-tool/resource protocol; A2A is an agent-to-agent task/message protocol. ViBread should expose both rather than force one protocol to impersonate the other. MCP is the Claude Code entry point; A2A is the durable ViBread agent contract; a small ViBread adapter translates between them. The official A2A concepts are Agent Card, Message, Task, and Artifact ([A2A v1.0 concepts](https://a2a-protocol.org/v1.0.0/topics/key-concepts/)); the official MCP SDK provides tools/resources/prompts and transports ([MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)).

---

## 2) Industry standard

### 2.1 What is and is not a standard

There is no single 2026 "industry-standard agent framework". The stable interoperability standards are **MCP** for exposing tools/context to a host and **A2A** for agent-to-agent messages/tasks. Harness choice is an application concern:

* For a Claude-specific headless agent with Claude Code-compatible permissions, sessions, hooks, and built-in tools, Anthropic's **Claude Agent SDK** is the canonical fit. Anthropic documents it as a library that runs the Claude Code binary and exposes its agent loop, permissions, sessions, hooks, MCP, and streaming ([Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview)).
* For maximum control and minimum coupling, a direct **Anthropic Messages API** loop is the boring baseline. Anthropic's TypeScript SDK is MIT, supports Node 20+, Bun, Deno, and streaming ([SDK README](https://github.com/anthropics/anthropic-sdk-typescript)); its tool runner automates ordinary loops, but Anthropic explicitly recommends a manual loop when human approval or custom logging/conditional execution is required ([tool runner](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-runner)).
* **Vercel AI SDK** is a strong web-oriented abstraction: `ToolLoopAgent`, streaming, UI helpers, and tool approvals are first-class ([building agents](https://ai-sdk.dev/docs/agents/building-agents), [tool approvals](https://ai-sdk.dev/docs/agents/tool-approvals)). It is not needed if ViBread is committed to Claude Code's Agent SDK loop and would add a second approval/session convention.
* **Mastra** has pre-execution approvals, runtime suspension, snapshots, and resume APIs ([Mastra HITL](https://mastra.ai/docs/agents/human-in-the-loop)). **LangGraph.js** has durable graph interrupts and checkpoint-backed resume ([LangGraph HITL](https://docs.langchain.com/oss/javascript/langchain/human-in-the-loop)). Both are credible choices for a long-lived production workflow, but a 36-hour demo should not add a second workflow runtime when A2A Tasks plus a small SQLite task store already provide the required boundary.

**Bottom line:** use the Claude Agent SDK for the ViBread main agent; build a small domain permission broker and task store; expose an A2A v1 server and a compatibility MCP facade. Keep raw Messages API code as a fallback/escape hatch, not as a second live harness.

### 2.2 Recommended exact package set (snapshot 2026-09-25)

Pin these versions in the lockfile rather than using floating `latest`:

| Purpose | Package/version | License and maintenance signal | Decision |
|---|---|---|---|
| Main Claude Code-compatible agent | [`@anthropic-ai/claude-agent-sdk@0.3.283`](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) | Anthropic Commercial Terms, 10M weekly downloads; the SDK release tracks its bundled Claude Code version. | **USE** |
| Direct API fallback / side calls | [`@anthropic-ai/sdk@0.128.0`](https://www.npmjs.com/package/@anthropic-ai/sdk) | MIT, 36M weekly downloads. | **WRAP**, only where direct control is useful |
| A2A v1.0 server and client | [`@a2a-js/sdk@1.2.1`](https://www.npmjs.com/package/@a2a-js/sdk) | Apache-2.0, 2.8M weekly downloads, official A2A JavaScript SDK; GitHub snapshot 628 stars ([repo](https://github.com/a2aproject/a2a-js)). | **USE** |
| MCP v2 server | [`@modelcontextprotocol/server@2.1.0`](https://www.npmjs.com/package/@modelcontextprotocol/server) | MIT, 5.9M weekly downloads; implements the 2026-07-28 spec. | **USE** for public/remote MCP |
| MCP v2 client | [`@modelcontextprotocol/client@2.1.0`](https://github.com/modelcontextprotocol/typescript-sdk) | MIT, same official monorepo and release line as the v2 server. | **USE** for an MCP client if needed |
| MCP v2 Node adapter | [`@modelcontextprotocol/node@2.1.0`](https://github.com/modelcontextprotocol/typescript-sdk) | MIT, official thin Node HTTP adapter. | **USE** if hosting v2 HTTP with `node:http` |
| MCP v2 Express adapter (optional) | [`@modelcontextprotocol/express@2.0.1`](https://github.com/modelcontextprotocol/typescript-sdk) | MIT, official thin adapter. | **OPTIONAL** |
| Claude Code Channel compatibility | [`@modelcontextprotocol/sdk@1.30.1`](https://www.npmjs.com/package/@modelcontextprotocol/sdk) | MIT, 53M weekly downloads; required peer line for the Agent SDK and the documented Channel examples. | **USE only in the Channel process** |
| Shared schemas | [`zod@4.6.5`](https://www.npmjs.com/package/zod) | MIT. Satisfies Agent SDK and MCP v2 schema requirements. | **USE** |
| Photon bonus adapter | [`spectrum-ts@12.10.1`](https://www.npmjs.com/package/spectrum-ts) | MIT, active registry package; official repository [photon-hq/spectrum-ts](https://github.com/photon-hq/spectrum-ts). | **WRAP** behind a channel adapter |

The Agent SDK's package metadata declares peers on `@anthropic-ai/sdk>=0.93.0`, `@modelcontextprotocol/sdk^1.29.0`, and Zod 4 ([package metadata](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk)). This is why the main agent's in-process SDK MCP server and the public modern MCP v2 server should be treated as separate compatibility surfaces rather than forcing v1 and v2 server classes into one module.

### 2.3 Claude Agent SDK capability and operational fit

The TypeScript SDK satisfies the requested headless capabilities:

* **Headless Linux:** `query()` is an async generator that streams SDK messages; TypeScript is the intended API ([TypeScript reference](https://code.claude.com/docs/en/agent-sdk/typescript)). The package installs a platform-specific native Claude Code binary as an optional dependency, so a separate `claude` installation is normally not required ([quickstart](https://code.claude.com/docs/en/agent-sdk/quickstart)). It still **runs that bundled native Claude Code binary as a subprocess**; it is not a pure HTTP-only library.
* **Authentication:** set `ANTHROPIC_API_KEY`; the SDK reads it from the host process environment. The official quickstart says third-party products should use API-key authentication rather than offering Claude.ai login/rate limits ([authentication quickstart](https://code.claude.com/docs/en/agent-sdk/quickstart)). The same docs cover Bedrock, Vertex, Foundry, and Anthropic AWS alternatives, but the hackathon should use the API key path.
* **Only custom in-process MCP tools:** `tool()` defines a Zod-typed tool and `createSdkMcpServer()` registers it in-process; pass that server in `mcpServers` ([custom tools guide](https://code.claude.com/docs/en/agent-sdk/custom-tools)). No external MCP process is necessary. Use `strictMcpConfig: true` and `settingSources: []`/an explicit setting source policy so project/user MCP servers cannot unexpectedly enter the session ([MCP SDK options](https://code.claude.com/docs/en/agent-sdk/mcp)).
* **Permissions:** options include `permissionMode`, `allowedTools`, `disallowedTools`, `canUseTool`, `hooks`, and `permissionPrompts`. `canUseTool` receives the tool name, validated input, request ID, MCP provenance, and an abort signal ([TypeScript `CanUseTool`](https://code.claude.com/docs/en/agent-sdk/typescript#canusetool)).
* **Sessions/resume:** sessions persist transcript history by default; TypeScript can use `continue`, a captured `session_id` with `resume`, `forkSession`, or `persistSession:false` ([sessions guide](https://code.claude.com/docs/en/agent-sdk/sessions)). A session persists conversation, not a filesystem snapshot; ViBread must separately version artifacts and board state.
* **Hooks:** lifecycle hooks can deny/modify requests before ordinary permission evaluation. Use a `PreToolUse` hook for hardware/BOM tools because `canUseTool` is not called for auto-approved calls ([permission evaluation](https://code.claude.com/docs/en/agent-sdk/permissions)).
* **Streaming to the web:** forward the async generator to the ViBread backend's own SSE stream, tagging model text, tool calls, task status, and approval events. Do not expose the native SDK subprocess or API key to the browser.

The SDK's custom-tool docs also support image/resource/structured content returns ([return values](https://code.claude.com/docs/en/agent-sdk/custom-tools#return-images-and-resources)); use those for validation screenshots and assembly previews, while A2A Artifacts remain the agent-to-agent file contract.

#### Agent SDK caveats

* It is **not a Bun-first runtime**. The package declares Node `>=18`, the official API examples target Node/TypeScript, and the SDK launches a native executable. Bun may execute ordinary ESM, but compatibility with Bun's process/module resolution is not promised by the SDK docs: **[UNVERIFIED]**. Run the main Agent SDK process on Node 22.
* `bun build --compile` cannot resolve the bundled binary from Bun's virtual filesystem. The official workaround is embedding the platform binary, extracting it with `extractFromBunfs()`, and passing `pathToClaudeCodeExecutable` ([Bun compile workaround](https://code.claude.com/docs/en/agent-sdk/typescript#compile-to-a-single-executable)). Do not spend hackathon time on a single binary; use Node/npm deployment.
* The binary is large and each independent process has startup/memory cost. The SDK documents a `prewarm()` spare at roughly 230–260 MB while waiting and offers `startup()`/`prewarm()` to move spawn/initialization out of the first request ([startup/prewarm reference](https://code.claude.com/docs/en/agent-sdk/typescript#startup)). **[UNVERIFIED]** exact first-token latency on this hardware; benchmark only after the path works.
* Anthropic's Commercial Terms govern the Agent SDK ([terms note](https://code.claude.com/docs/en/agent-sdk/overview#license-and-terms)); include that dependency and terms in the public repo's notices. This is not a GPL/AGPL dependency, but it is also not an MIT library.

### 2.4 Harness comparison

| Harness | Streaming/UI | HITL / resume | Custom tools | Cost/latency | ViBread verdict |
|---|---|---|---|---|---|
| Agent SDK | Native async stream; forward to SSE. | Built-in permission modes, `canUseTool`, hooks, sessions/resume. | In-process SDK MCP tools. | Same underlying Claude API usage, plus native CLI spawn/context setup; `startup()`/`prewarm()` can amortize it. | **USE** for main agent. Best fit for requested Claude Code semantics. |
| Messages API + manual loop | Native API streaming; complete control over wire/UI events. | Must implement approval suspension, task/session persistence, retries, tool-result validation, and resume. | Straightforward JSON Schema tools. | Lowest host overhead; model/token costs are otherwise equivalent. | **WRAP** as fallback or for a small sidecar where Agent SDK is unavailable. |
| Messages API beta tool runner | Iterative tool calls and state handled for ordinary runs. | Anthropic says use manual loop for HITL/conditional approval. | Typed `betaZodTool`/`betaTool`. | Low host overhead. | **AVOID as the main approval loop**. |
| Vercel AI SDK 7.0.116 | Excellent `streamText`/UI message support and `useChat`. | `ToolLoopAgent.toolApproval` emits resumable approval parts; re-validates schemas. | Strong, provider-neutral tools. | One extra abstraction, little runtime cost. | **WRAP only if the frontend already uses its UI protocol**; do not combine with Agent SDK's loop. |
| Mastra 1.71.0 | Stream/generate with rich event model. | Approval/suspend + snapshots/storage. | Strong tool/workflow APIs; even ships A2A v1/v0.3 aliases as dependencies ([package metadata](https://www.npmjs.com/package/@mastra/core)). | More runtime/storage/convention to learn. | **AVOID for weekend scope**; reconsider for a durable product. |
| LangGraph 1.4.18 | Graph streaming. | Durable checkpoint-backed interrupts and explicit decisions. | Powerful graph/tool composition. | Highest orchestration setup. | **AVOID now**; A2A task state plus a tiny broker is enough. |

No framework should be treated as a safety boundary: tool annotations and model decisions are hints. ViBread's broker, exact action hash, server-side authorization, and physical-device checks are authoritative.

### 2.5 A2A v1.0 server/client shape

`@a2a-js/sdk@1.2.1` is the official JavaScript SDK and implements A2A Specification v1.0. It supplies JSON-RPC, HTTP+JSON/REST, and gRPC transports; gRPC is explicitly Node-only ([SDK README](https://github.com/a2aproject/a2a-js#readme)).

**Server:**

1. Define an `AgentCard`.
2. Implement `AgentExecutor.execute(requestContext, eventBus)` and `cancelTask(taskId, eventBus)`.
3. Give `DefaultRequestHandler` the card, a `TaskStore`, and the executor.
4. Mount `agentCardHandler` and `jsonRpcHandler` from `@a2a-js/sdk/server/express`; mount REST too only if a consumer needs it. The official sample demonstrates this exact shape ([sample server](https://raw.githubusercontent.com/a2aproject/a2a-js/main/src/samples/agents/sample-agent/index.ts)).
5. Publish `AgentEvent.task`, `statusUpdate`, and `artifactUpdate` to the `ExecutionEventBus`; clients consume an `AsyncGenerator` from `sendMessageStream()` ([streaming README section](https://github.com/a2aproject/a2a-js#streaming)).

**Client:** `new ClientFactory().createFromUrl(baseUrl, path?)` fetches the well-known Agent Card and chooses a compatible interface; `createFromAgentCard(card)` avoids a network fetch. Client methods include `sendMessage`, `sendMessageStream`, `getTask`, `cancelTask`, and push-notification operations ([client factory source](https://raw.githubusercontent.com/a2aproject/a2a-js/main/src/client/factory.ts), [SDK README](https://github.com/a2aproject/a2a-js#clients)).

**Node/Bun:** the SDK package declares Node `>=20`; the official server adapter is Express, not a first-party Bun adapter ([package manifest](https://raw.githubusercontent.com/a2aproject/a2a-js/main/package.json)). A2A core/client code is fetch-oriented and may work under Bun, but running the official Express server under Bun is **[UNVERIFIED]**. Use Node 22 for ViBread's A2A server. If a future Bun-only deployment is required, write a small Web-standard adapter around the exported request handler; do not copy an external gateway.

**Agent Card:** publish v1 at `GET /.well-known/agent-card.json`. In v1 the endpoint URL is in `supportedInterfaces[0].url`, not the old v0.3 top-level `url`. Required/high-value fields are:

```json
{
  "name": "ViBread Circuit Agent",
  "description": "Designs, validates, and verifies Arduino circuits.",
  "supportedInterfaces": [{
    "url": "https://vibread.example/a2a",
    "protocolBinding": "JSONRPC",
    "protocolVersion": "1.0"
  }],
  "version": "0.1.0",
  "capabilities": { "streaming": true, "pushNotifications": true },
  "defaultInputModes": ["text", "application/json", "image/*"],
  "defaultOutputModes": ["text", "application/json", "image/svg+xml", "image/png"],
  "skills": [],
  "securitySchemes": {},
  "securityRequirements": []
}
```

The normative v1 schema defines `name`, `description`, `supportedInterfaces`, `version`, `capabilities`, input/output modes, and `skills`; skill fields include `id`, `name`, `description`, tags, examples, and per-skill modes ([AgentCard definitions](https://a2a-protocol.org/v1.0.0/definitions/)). Add bearer/OAuth security schemes before exposing a public deployment.

**Multi-turn input/auth:** an A2A task can be interrupted in `TASK_STATE_INPUT_REQUIRED` or `TASK_STATE_AUTH_REQUIRED`. The client sends a new Message with the same `taskId` and `contextId` to continue. A terminal task is immutable; refinements create a new task in the same `contextId` ([task lifecycle](https://a2a-protocol.org/v1.0.0/topics/life-of-a-task/)). ViBread must persist both IDs and its internal Agent SDK session ID in task metadata.

**Artifacts:** an Artifact contains Parts. A file Part can use `filename`, `mediaType`, and `raw` (base64 in JSON), `url`, or structured `data`; `TaskArtifactUpdateEvent` supports `append` and `lastChunk` for large files ([v1 definitions](https://a2a-protocol.org/v1.0.0/definitions/)). Return `.ino` as `text/plain` plus filename, netlist/validation as `application/json`, and SVG/PNG with correct media types. Prefer authenticated short-lived URLs for large PNGs rather than huge inline base64.

**Push notifications:** advertise `capabilities.pushNotifications:true`; wire a `PushNotificationStore` and `PushNotificationSender`; clients supply an HTTPS webhook URL, optional token, and authentication. The SDK's official sample uses `InMemoryPushNotificationStore` and `DefaultPushNotificationSender` ([push sample](https://raw.githubusercontent.com/a2aproject/a2a-js/main/src/samples/agents/push-notification-agent/index.ts)). For a restart-safe ViBread demo, implement a SQLite-backed task/push store or use polling from the laptop channel. Validate/allowlist webhook URLs and authenticate callbacks; A2A's own specification calls out SSRF and webhook-authentication requirements ([push security](https://a2a-protocol.org/v1.0.0/topics/streaming-and-async/#security-considerations-for-push-notifications)).

### 2.6 MCP v2 versus v1 and what Claude Code actually uses

**MCP v2 (`@modelcontextprotocol/server`/`client` 2.1.0):**

* The official v2 line implements spec revision `2026-07-28`, runs on Node, Bun, and Deno, and splits server/client packages ([SDK README](https://github.com/modelcontextprotocol/typescript-sdk)).
* The modern era replaces the stateful `initialize` handshake with `server/discover`, per-request `_meta`, and stateless request handling. The SDK can serve both modern and legacy eras from one HTTP/stdio entry point; its protocol-version guide documents `legacy`, `auto`, and pinned `2026-07-28` negotiation ([protocol versions](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/protocol-versions.md)).
* Streamable HTTP is the recommended remote transport in Claude Code; SSE is deprecated where HTTP is available ([Claude Code MCP servers](https://code.claude.com/docs/en/mcp-servers)). Use `type:"http"` or the spec alias `type:"streamable-http"` in config.
* Elicitation in the modern spec is a nested `InputRequiredResult`: form mode requests a restricted primitive JSON Schema; URL mode is required for secrets/credentials and keeps sensitive data out of the MCP client ([MCP 2026-07-28 elicitation](https://modelcontextprotocol.io/specification/2026-07-28/client/elicitation)).
* MCP Tasks are a separate opt-in extension for durable long operations, with `working`, `input_required`, `completed`, `failed`, and `cancelled`, plus `tasks/get`, `tasks/update`, and `tasks/cancel` ([MCP Tasks overview](https://modelcontextprotocol.io/extensions/tasks/overview)). Host support varies, so ViBread must not assume every Claude Code/IDE client implements Tasks.

**MCP v1 (`@modelcontextprotocol/sdk@1.30.1`):** the maintained legacy package uses the 2025-era `initialize` handshake and the push-style server→client elicitation APIs. The Agent SDK declares a v1 peer, and Claude Code Channel documentation imports the v1 `Server`/`StdioServerTransport` directly ([Channel reference](https://code.claude.com/docs/en/channels-reference)). Keep it for the local Channel process.

**Observed Claude Code negotiation:** with `@anthropic-ai/claude-code@2.1.283` (the current npm package snapshot), a temporary stdio server probe on 2026-09-25 received:

```json
{"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{"roots":{"listChanged":true},"elicitation":{}},"clientInfo":{"name":"claude-code","version":"2.1.283"}},"id":0}
```

It then sent `notifications/initialized` and `tools/list`. The probe was run without an API key, so the model turn ended at authentication, but MCP initialization completed. This is a reproducible local observation, not a claim that every future transport/version behaves identically. It means ViBread's Claude Code-facing stdio/channel endpoint must remain legacy-compatible; do not ship a v2-only stdio server and assume the current CLI will negotiate it. Claude Code does have modern-protocol support: its changelog documents URL-mode elicitation specifically on `2026-07-28` connections ([2.1.281 changelog](https://code.claude.com/docs/en/changelog#2.1.281)), but **[UNVERIFIED]** whether the current release chooses modern for every remote HTTP/server configuration. Keep a dual-era v2 HTTP endpoint and a v1 stdio Channel.

**MCP Apps:** MCP Apps can render sandboxed `ui://` HTML in hosts that implement the extension ([MCP Apps overview](https://modelcontextprotocol.io/extensions/apps/overview)); client support varies. They are attractive for an inline breadboard widget, but Claude Code Channel and current stdio compatibility are the critical path. Return normal authenticated web URLs plus A2A PNG/SVG artifacts first; add an MCP App only after the end-to-end path works.

### 2.7 Claude Code Channels

Channels are research-preview MCP servers that push events into a running Claude Code session. They run locally as a subprocess over stdio; a server may poll an external platform or listen on localhost. Two-way channels expose an ordinary MCP `reply` tool ([Channels overview](https://code.claude.com/docs/en/channels)); the tool is not a special wire method.

Required/optional contract:

```ts
new Server(
  { name: 'vibread-channel', version: '0.1.0' },
  {
    capabilities: {
      experimental: {
        'claude/channel': {},
        'claude/channel/permission': {}, // only with authenticated sender gating
      },
      tools: {}, // required for two-way reply tool
    },
    instructions: 'Events arrive as <channel source="vibread-channel" ...>. Use reply with chat_id.',
  },
)
```

* Push `notifications/claude/channel` with `{content:string, meta:Record<string,string>}`. Metadata keys become `<channel>` attributes; the Channel reference says only identifier-like keys survive ([notification format](https://code.claude.com/docs/en/channels-reference#notification-format)).
* Expose `reply({chat_id,text})`; Claude calls it to send a response back to Spectrum/web/iMessage ([reply tool](https://code.claude.com/docs/en/channels-reference#expose-a-reply-tool)).
* Protect inbound events with a sender allowlist. Gate on sender identity, not merely room ID, because a group room can contain an untrusted sender ([Channel security](https://code.claude.com/docs/en/channels-reference#gate-inbound-messages)).
* Permission relay is opt-in via `claude/channel/permission:{}`. Claude Code sends `notifications/claude/channel/permission_request` containing `request_id`, `tool_name`, `description`, and `input_preview`; the server relays it; a human reply is converted to `notifications/claude/channel/permission` with the same request ID and `behavior:"allow"|"deny"` ([permission relay](https://code.claude.com/docs/en/channels-reference#relay-permission-prompts)). The first local/remote answer wins and the ID is one-shot; project trust and MCP server-consent dialogs do not relay.
* Custom Channels are not on the research-preview allowlist. A bare `.mcp.json` server requires `claude --dangerously-load-development-channels server:vibread-channel`; a plugin uses `claude --dangerously-load-development-channels plugin:vibread@marketplace` while developing ([testing custom Channels](https://code.claude.com/docs/en/channels-reference#test-during-the-research-preview)). A user-facing plugin install is `/plugin install vibread@<marketplace>` followed by `claude --channels plugin:vibread@<marketplace>`; a community marketplace still needs the development flag until allowlisted ([package as a plugin](https://code.claude.com/docs/en/channels-reference#package-as-a-plugin)).
* The Channel reference explicitly supports Node, Bun, and Deno for the server, although official preview plugins use Bun ([requirements](https://code.claude.com/docs/en/channels-reference#what-you-need)). Therefore run this process on the laptop with Bun if Spectrum prefers Bun; keep the main ViBread Agent SDK/A2A service on Node 22.

Yes: a Channel server can be an A2A client. It can use `ClientFactory` to call ViBread's card/JSON-RPC endpoint, poll or stream a Task, forward `INPUT_REQUIRED` as a channel event, and route a verified iMessage answer back as an A2A continuation. This is a normal combination of the Channel stdio contract and A2A client API, not a special Claude Code bridge. Keep the Channel's A2A task IDs and approval IDs durable locally; do not rely on an open terminal connection alone.

---

## 3) Existing MCP servers & tools (A2A↔MCP bridges)

The rubric from `00-breakdown.md` requires recent maintenance, real capability, sane security, headless Linux operation, a compatible license, and stdio or Streamable HTTP. No discovered third-party bridge is a **good** drop-in for ViBread's TypeScript/A2A-v1/Claude-Code-HITL requirements. The table records repository/package snapshots; stars are GitHub UI snapshots on 2026-09-25 where available.

| Name | URL | License | Last activity | Transport | Capabilities | Verdict |
|---|---|---|---|---|---|---|
| `mcp-a2a-bridge` | [GitHub](https://github.com/naveenkumarbaskaran/mcp-a2a-bridge), [PyPI](https://pypi.org/project/mcp-a2a-bridge/) | MIT (declared in `pyproject.toml` and LICENSE) | 2026-05-05; 0 GitHub stars | Python/FastAPI; MCP stdio, SSE, Streamable HTTP; A2A JSON-RPC/REST/gRPC optional | Bidirectional MCP↔A2A, auto Agent Cards, YAML config, CLI, tests; uses `a2a-sdk>=1.0`, `mcp`, and LiteLLM. | **usable** — substantive and MIT, but Python sidecar, alpha status, LLM routing dependency, and no reason to add it to a Node 22 weekend app. |
| `a2a-gateway-mcp` | [GitHub](https://github.com/nisimpson/a2a-gateway-mcp) | MIT | 2026-07-26; 1 star | Go MCP stdio + HTTP A2A gateway; agent directory | Real gateway with connect/disconnect, discovery, history, rate limits, caller cards, tests, and security controls; module uses `a2a-go/v2` and Go MCP SDK. | **usable** — better operational/security posture than most, but Go deployment, separate configuration, and different SDK/runtime make it a sidecar rather than a ViBread dependency. |
| `a2a-mcp-bridge` | [GitHub](https://github.com/aarushitandon0/a2a-mcp-bridge) | **No license file/declaration found** | 2026-08-11; 0 stars | Python Streamable HTTP MCP ↔ A2A v1 JSON-RPC | Native MCP 2026-07-28, A2A 1.0, sealed AES task handles, explicit state mapping, tests, artifact summarization, and auth/input distinction. | **toy** for a public hackathon dependency — technically interesting, but missing license makes reuse unsafe under the project rule and its 0-star/one-issue project is not a mature dependency. Read as design research, not code. |
| `memoh-a2a-gateway` | [GitHub](https://github.com/jinyitao123/a2a-gateway) | Apache-2.0 | 2026-04-13; 0 stars | Bun/Hono; MCP Streamable HTTP; hand-written A2A JSON-RPC and SSE | Registry, SSRF/HTTPS/response-size/concurrency controls, internal/external agent routing, MCP tools. | **toy** for ViBread — real security ideas, but six commits, old `@modelcontextprotocol/sdk` range, and hand-written mixed `SendMessage`/`tasks/send` compatibility rather than the official A2A v1 SDK. |
| `a2a-mcp-skillmap` | [GitHub](https://github.com/shashikanth-gs/a2a-mcp-skillmap) | MIT | 2026-05-13; 2 stars | Node/TypeScript stdio + HTTP MCP | Dynamic skill discovery, multimodal output, A2A→MCP projection, tests. | **toy** for this target — package uses `@a2a-js/sdk@0.3.13` and `@modelcontextprotocol/sdk@1.29.0`, so it is a v0.3-era bridge despite a clean TS shape. |
| `a2a-bridge` | [npm](https://www.npmjs.com/package/a2a-bridge), [GitHub](https://github.com/firstintent/a2a-bridge) | MIT | 2026-04-16; 9 stars; npm latest `0.2.0` | Bun daemon, A2A HTTP/SSE, ACP stdio JSON-RPC, Claude Code MCP Channels; SQLite task log | Star-topology coding-agent bridge, session isolation, bearer tokens, plugin packaging, remote routing. | **usable** for Claude Code↔coding-agent relay, not ViBread — npm dev dependencies pin A2A `0.3.13` and MCP `1.27.1`, and the project solves ACP/coding-agent routing rather than circuit artifacts/HITL. |
| Official `a2a_mcp` sample | [A2A samples](https://github.com/a2aproject/a2a-samples/tree/main/samples/python/agents/a2a_mcp) | Apache-2.0 (repository) | 2026-08-04 | Python MCP SSE registry + A2A HTTP agents | Stores/queries Agent Cards through MCP, then invokes agents directly through A2A; includes a runnable travel-agent example. | **toy/reference** — official architecture example, not a reusable production bridge and not TypeScript. |

**Recommendation:** build a thin ViBread-specific adapter. Reuse the official protocol SDKs and copy no bridge application code. The adapter needs policy-aware tool schemas, circuit-artifact URLs, board/serial identity, and durable HITL records that generic bridges do not have. A third-party sidecar would add protocol-version translation and a second deployment during the demo.

---

## 4) Recommendation per sub-area

| Sub-area | Verdict | Recommendation and rationale |
|---|---|---|
| Main server agent harness | **USE** | `@anthropic-ai/claude-agent-sdk@0.3.283` on Node 22. It directly supplies Claude Code's loop, streamed messages, sessions/resume, hooks, permission modes, and in-process MCP tools. |
| Raw model/tool loop | **WRAP** | Keep a small `@anthropic-ai/sdk@0.128.0` manual-loop module for fallback, smoke tests, or a non-Claude-Code background call. Do not run both loops for one conversation. |
| Web streaming | **BUILD** | Convert Agent SDK events and ViBread task events to one server SSE stream; browser never sees API keys or MCP stdio. Avoid adding Vercel AI SDK only for transport. |
| Durable task/approval state | **BUILD** | SQLite-backed `TaskStore`/`ApprovalBroker` keyed by tenant, A2A `taskId`, `contextId`, Agent SDK `session_id`, action hash, channel identity, expiry, and one-shot decision. A2A's in-memory store is suitable only for a demo that never restarts. |
| A2A v1 server/client | **USE + BUILD** | Use `@a2a-js/sdk@1.2.1` for wire types, card resolution, JSON-RPC, SSE, task events, and push helpers; build ViBread's `AgentExecutor`, card, persistent stores, and domain policy. Node 22/Express is the supported path. |
| Public modern MCP server | **USE + BUILD** | Use `@modelcontextprotocol/server@2.1.0` + optional `@modelcontextprotocol/node@2.1.0` for Streamable HTTP, with a dual-era endpoint where practical. Build ViBread tools and output schemas. |
| Claude Code-facing MCP/channel | **USE v1 + BUILD** | Use `@modelcontextprotocol/sdk@1.30.1` in a separate local stdio Channel process because current Claude Code stdio negotiated `2025-11-25` in the probe and Channel docs use the v1 API. Do not expose only a v2-only stdio server. |
| A2A↔MCP bridge | **BUILD** | Implement the small facade in TypeScript. Existing bridges are Python/Go, v0.3-era, unlicensed, or generic; none earns “good” under the rubric. |
| Claude Code permissions | **WRAP + BUILD** | Use Agent SDK `canUseTool`, `PreToolUse`, `permissionMode`, and Channel permission relay as integration points, but enforce physical/BOM policy in ViBread's broker and database. |
| iMessage/Photon | **WRAP** | Wrap `spectrum-ts@12.10.1` in the laptop Channel adapter. Keep Spectrum provider details out of core task logic so web and Claude Code use the same broker. Spectrum's docs distinguish cloud iMessage from local macOS iMessage ([provider docs](https://photon.codes/docs/spectrum-ts/providers/imessage)); local iMessage cannot be assumed inside the Linux container. |
| MCP Apps breadboard UI | **BUILD later** | First return authenticated SVG/PNG URLs and A2A file artifacts. A sandboxed `ui://` app is a nice bonus but host support varies and is not required for Claude Code/inter-agent acceptance. |
| Framework (Vercel AI/Mastra/LangGraph) | **AVOID now** | All are viable, but adding one beside Agent SDK duplicates loops, state, and approvals. Revisit LangGraph/Mastra after the hackathon if the workflow becomes a durable multi-day product. |

---

## 5) BUILD: proposed ViBread MCP server, Channel, and A2A card

### 5.1 Public MCP server: `vibread-mcp`

Host the v2 Streamable HTTP endpoint at `/mcp` and, for Claude Code compatibility, either configure it through the v1 stdio Channel facade or have the v2 server serve legacy traffic as the SDK permits. Tool results should include human-readable `content`, machine-readable `structuredContent`, and artifact `resource_link`s. Every mutating or physical tool must include a risk annotation and a server-side approval decision; MCP annotations are not enforcement.

Common types:

```ts
type ArtifactRef = {
  artifactId: string;
  filename: string;
  mediaType: string;
  uri?: string;             // authenticated short-lived URL
  sha256?: string;
  sizeBytes?: number;
};

type PendingInput = {
  requestId: string;
  question: string;
  schema?: object;           // flat form schema for MCP elicitation-compatible clients
  actionClass: 'clarification' | 'software-review' | 'physical' | 'bom';
  expiresAt: string;
};

type TaskResult = {
  taskId: string;
  contextId: string;
  status: 'submitted' | 'working' | 'input_required' | 'auth_required' | 'completed' | 'failed' | 'cancelled';
  pending?: PendingInput;
  artifacts?: ArtifactRef[];
  findings?: unknown[];
};
```

| Tool | Inputs | Outputs / side effects |
|---|---|---|
| `vibread_design_circuit` | `{ intent: string, board?: 'uno-r3'|'nano-atmega328p'|'uno-r4'|'esp32'|'pico', constraints?: object, channel?: {kind,id} }` | Starts/resumes a ViBread A2A Task; returns `TaskResult`. Produces provisional netlist, sketch, BOM, and design ID; does not flash or order. |
| `vibread_continue_task` | `{ taskId, contextId, requestId?, answer: object|string, approval?: {decision:'allow'|'deny', actionHash:string} }` | Sends the answer to the same A2A task; returns updated `TaskResult` and final artifacts when complete. Rejects stale/wrong action hashes. |
| `vibread_get_task` | `{ taskId, contextId, includeArtifacts?: boolean }` | Poll-safe current status, pending question, findings, and authenticated artifact references. |
| `vibread_cancel_task` | `{ taskId, contextId, reason?: string }` | Cooperative cancel; returns `{status:'cancelled'|'already_terminal'}`. |
| `vibread_validate_design` | `{ designId, checks?: ('erc'|'spice'|'compile'|'mcu-sim')[], board, scenarios?: object[] }` | Read-only validation result with severity-coded findings, compile/simulation logs, and JSON artifacts. Its declared annotation is read-only, but server still applies resource/time limits. |
| `vibread_build_instructions` | `{ designId, format:'svg'|'png'|'json', viewport?: {width,height}, step?: number }` | Returns `ArtifactRef[]` for LEGO-like assembly steps; PNG is suitable for iMessage. |
| `vibread_flash_firmware` | `{ designId, board, portHint?: string, firmwareArtifactId, verificationProfile?: string }` | **Always approval-gated.** On approval, creates a laptop Web Serial/bridge job; returns a hardware job ID and serial log artifact, never arbitrary server shell access. |
| `vibread_run_self_test` | `{ designId, hardwareJobId, durationMs?: number }` | **Physical-action gate.** Returns serial self-test observations (power, pin probes, expected/actual) and a wiring/design/code attribution candidate. |
| `vibread_submit_photo` | `{ designId, image: {uri?: string, base64?: string, mediaType:string}, notes?: string }` | Claude vision/vision pipeline result with confidence and suspected wiring mismatches; secondary evidence only. |
| `vibread_debug_build` | `{ designId, observations?: object, serialLogArtifactId?: string, photoArtifactId?: string }` | Correlates design/code/wiring evidence; may return a new `PendingInput` asking for a meter reading or rewire step. |

For Claude Code's current legacy MCP path, `vibread_design_circuit` must return a non-error structured pending result rather than assuming MCP Tasks support. The model can call `vibread_get_task` or `vibread_continue_task` on the next turn. Modern clients that declare `io.modelcontextprotocol/tasks` may additionally receive a durable MCP task handle, but the authoritative state remains the A2A task.

### 5.2 Channel server: `vibread-channel`

This is a local stdio MCP v1 server running on the user's laptop. It contains no circuit-design logic. It has:

* `reply({chat_id, text, attachments?: ArtifactRef[]}) -> {sent:boolean, messageId?:string}` for Claude-to-iMessage/Spectrum replies.
* A Spectrum inbound loop that authenticates the sender and emits `notifications/claude/channel` with `meta:{chat_id, task_id, context_id, sender_id, event_kind}`.
* An A2A `ClientFactory` connection to ViBread for task polling/streaming and continuation. It may send a direct A2A answer for an unambiguous `approve`/`deny`, or forward the answer to Claude Code for a model-mediated `vibread_continue_task` call; choose one path per request to avoid duplicate continuation.
* Optional permission relay with `notifications/claude/channel/permission_request` and exact-ID `notifications/claude/channel/permission` verdicts. Sender allowlist is mandatory before declaring the capability.

The Channel should treat inbound iMessage text and image metadata as untrusted prompt content. A strict `approve <request-id>` grammar is safer than allowing natural-language approval to hit the model. Every approval message carries the ViBread request ID and a short action hash; the broker rejects expired, already-used, wrong-user, or mismatched approvals.

### 5.3 A2A Agent Card skills

Publish `https://<host>/a2a` as the preferred `JSONRPC` interface and `/.well-known/agent-card.json` as the card. Suggested v1 skills:

| Skill ID | Purpose | Input modes | Output modes | Human gate |
|---|---|---|---|---|
| `design-circuit` | Natural-language intent → checked netlist/sketch/BOM | `text`, `application/json` | `text`, `application/json`, `text/plain` | Clarification/review if constraints or BOM uncertain |
| `validate-circuit` | ERC/electrical simulation/compile/MCU simulation | `application/json` | `application/json`, `text/plain` | None for local simulations; approval only for external resources |
| `assembly-instructions` | Netlist → step-by-step breadboard visuals | `application/json` | `application/json`, `image/svg+xml`, `image/png` | None |
| `flash-and-self-test` | Laptop-side flash and MCU-run wiring test | `application/json` | `application/json`, `text/plain` | Always physical-action approval |
| `verify-photo` | Photo evidence → vision findings | `image/*`, `application/json` | `application/json`, `text/plain` | None; label as secondary evidence |
| `debug-build` | Attribute failure to design/code/wiring and propose next action | `application/json`, `image/*` | `application/json`, `text/plain`, `image/*` | Rewire/flash/BOM action becomes `INPUT_REQUIRED` |

When ViBread asks back, publish a `TaskStatusUpdateEvent` with `TASK_STATE_INPUT_REQUIRED` and a status Message containing both a concise text question and an `application/json` DataPart:

```json
{
  "requestId": "apr-7k3m",
  "question": "The LED value is unspecified. Use 220 ohm or 1 kohm?",
  "schema": { "type": "object", "properties": { "resistorOhms": { "type": "integer", "enum": [220, 1000] } }, "required": ["resistorOhms"] },
  "actionClass": "clarification",
  "actionHash": "sha256:..."
}
```

The continuation Message uses the same `taskId` and `contextId`; a completed task is not restarted. A `.ino`, netlist JSON, SVG, and PNG are separate named Artifacts so Claude Code can consume only what it needs.

---

## 6) Integration notes & gotchas

### 6.1 End-to-end sequence: Claude Code → ViBread → iMessage approval → artifacts

1. **Install/connect:** the user registers the public MCP endpoint with `claude mcp add --transport http vibread https://host/mcp`, or installs the ViBread Channel plugin for local two-way messages. For a custom Channel during preview, start with `--dangerously-load-development-channels`; a `.mcp.json` entry alone is not enough ([Claude Code MCP install](https://code.claude.com/docs/en/mcp-servers), [Channel packaging](https://code.claude.com/docs/en/channels-reference#package-as-a-plugin)).
2. **Delegate:** Claude Code calls `vibread_design_circuit({intent,board,constraints})`. The MCP facade creates an A2A `Message` and ViBread creates `taskId` + `contextId`; the ViBread Agent SDK run ID is stored in task metadata.
3. **Work/stream:** the ViBread `AgentExecutor` publishes `submitted` → `working`, streams progress/artifact updates over A2A SSE, and stores provisional files. The facade returns progress or a durable pending result to Claude Code.
4. **Ask back:** ViBread publishes `TASK_STATE_INPUT_REQUIRED` with the question/DataPart and `requestId/actionHash`. The Channel's A2A client receives the event via SSE, A2A push, or polling and emits a `notifications/claude/channel` event. Claude Code sees the question; Spectrum also sends a concise approval card/text to the authenticated iMessage user.
5. **Approve on iMessage:** user replies `approve <requestId> <actionHash>` (or selects a Spectrum poll option). The Channel validates sender, ID, expiry, task/context, and action hash. It either (a) sends a direct A2A continuation for a strictly typed approval, or (b) emits a channel event and lets Claude Code call `vibread_continue_task`. Do not do both.
6. **Resume:** `AgentExecutor` receives a Message with the same `taskId/contextId`, restores the Agent SDK session with `resume`, records the one-shot decision, and continues validation. If a design is now complete, publish `TASK_STATE_COMPLETED`; if more information is needed, issue a new pending request rather than pretending approval is complete.
7. **Return artifacts:** MCP `vibread_get_task`/`vibread_continue_task` returns text plus `structuredContent` and links to `.ino`, netlist/validation JSON, and SVG/PNG. A2A returns the same files as named Artifact Parts. Claude Code can summarize or commit/download them; the browser and iMessage receive previews appropriate to their channel.
8. **Physical boundary:** only after a separate flash/self-test approval may the laptop Web Serial path execute. The container's A2A/MCP server must never infer or silently access the laptop's USB device.

### 6.2 Permission-mode mapping

Claude Agent SDK permission semantics are documented in the official mode table ([permissions](https://code.claude.com/docs/en/agent-sdk/permissions#permission-modes)):

| ViBread policy | SDK/Claude Code setting | What to auto-allow | What must still ask |
|---|---|---|---|
| `ask-every-time` | `permissionMode:'default'`, no sensitive `allowedTools`, `canUseTool` → ApprovalBroker | Pure reads and bounded local validation | Every flash, serial write, BOM/order, destructive file, or external side effect |
| `review` | `permissionMode:'plan'` for planning; switch to `default` only after acceptance | Read-only inspection and plan generation | File writes, generated-design acceptance, simulations with cost/side effects, all physical actions |
| `bypass` (demo-only) | `permissionMode:'bypassPermissions'` plus `allowDangerouslySkipPermissions:true` | Software-only isolated simulation fixtures | **Still never bypass ViBread's physical/BOM broker**; do not enable for a real board or untrusted prompt |
| `auto` (current Claude Code classifier) | `permissionMode:'auto'` when explicitly chosen | Classifier-approved routine operations | Hardware/BOM actions remain explicitly gated by ViBread; do not treat model classification as a safety control |
| locked headless | `permissionMode:'dontAsk'` + narrow `allowedTools` | Exact allowlist | All other prompts deny; useful for CI validation, not interactive design |

`acceptEdits` only auto-approves Claude Code file edits and filesystem commands; it does not mean MCP tools are approved ([MCP permission note](https://code.claude.com/docs/en/agent-sdk/mcp#allow-mcp-tools)). Also, an `allowedTools` entry or `bypassPermissions` can skip `canUseTool`; use a `PreToolUse` hook and ViBread's own broker for checks that must run on every call ([permission warning](https://code.claude.com/docs/en/agent-sdk/permissions#how-permissions-are-evaluated)). The current CLI help also lists `manual`; the typed Agent SDK `PermissionMode` reference lists `default`, `dontAsk`, `acceptEdits`, `bypassPermissions`, `plan`, and `auto`, so treat `manual` as a CLI/UI label rather than a portable SDK value (**[UNVERIFIED]** as an SDK option).

**Policy classes:**

* Design, ERC, compile, SPICE, and MCU simulation are software-only but still resource-bounded; allow automatically after validating design IDs and sandbox paths.
* Writing a generated `.ino`/JSON/SVG to a ViBread workspace is a software artifact operation; in `review`, show a diff or artifact hash before accepting.
* Flashing, opening a serial port, toggling live pins, or asking the user to rewire is a physical action. Use a separate approval request and/or A2A `INPUT_REQUIRED`, even in bypass software mode.
* Changing a BOM, ordering parts, or using a paid API is an external/cost action. Require approval and show exact part, quantity, price, and supplier URL.
* A user-provided credential must not enter form-mode elicitation or model context. MCP spec requires URL mode for sensitive credentials ([elicitation security](https://modelcontextprotocol.io/specification/2026-07-28/client/elicitation)); route auth through the browser/Spectrum out-of-band.

### 6.3 Three approval channels, one broker

Use one `ApprovalBroker` record and adapters:

```text
ApprovalBroker(actionHash, requestId, taskId, contextId, userId, state, expiresAt)
  ├─ Web adapter: SSE pending event + signed approve/deny POST
  ├─ Spectrum adapter: iMessage text/poll + sender identity
  └─ Claude adapter: Agent SDK canUseTool / Channel permission relay
```

All adapters call the same atomic `decide(requestId, actionHash, userId, verdict)`; the first valid decision wins. The broker records the canonical tool name/input, not just a prose description, and revalidates the hash immediately before execution. This prevents a stale iMessage approval from authorizing a changed firmware or port.

### 6.4 A2A and MCP transport gotchas

* A2A v1 card URLs should be absolute HTTPS in production; local `http://localhost` is fine only for a demo. The first `supportedInterfaces` entry is preferred ([A2A definitions](https://a2a-protocol.org/v1.0.0/definitions/)).
* A2A v1 is not the old v0.3 wire shape. Do not copy generic bridges that emit `message/send`/`tasks/send` unless the client explicitly opts into compatibility. Use `@a2a-js/sdk@1.2.1` and publish `protocolVersion:'1.0'`.
* A2A SSE closes when a task reaches terminal or interrupted state; reconnect with `SubscribeToTask`. Push webhook payloads are `StreamResponse`-like and should be authenticated ([streaming/async](https://a2a-protocol.org/v1.0.0/topics/streaming-and-async/)).
* MCP v2 Tasks are opt-in and not universally implemented. The MCP facade therefore has explicit `get/continue/cancel` tools that work over Claude Code's legacy v1 path.
* Current Claude Code remote MCP config requires a `type` next to a URL (`http`/`streamable-http`); a URL with no type is interpreted as a malformed stdio entry ([MCP server config](https://code.claude.com/docs/en/mcp-servers#option-1-add-a-remote-http-server)).
* SSE is still useful for A2A task streaming and Channel outbound events; it is deprecated specifically as the MCP remote server transport where Streamable HTTP is available.
* Use `AbortSignal`/timeouts on every A2A and MCP request. Cancelled browser tabs must not cancel a physical flash unless the hardware job explicitly supports cooperative cancellation.

### 6.5 Artifacts and media

Use A2A file Parts and MCP `resource_link`/URLs, not large inline transcripts. Recommended names/media:

* `design-v{n}.netlist.json` — `application/json`
* `firmware-v{n}.ino` — `text/plain` with filename `.ino`
* `validation-v{n}.json` — `application/json`
* `assembly-step-{n}.svg` — `image/svg+xml`
* `assembly-step-{n}.png` — `image/png`
* `serial-self-test-{job}.json` — `application/json`

Store immutable artifact hashes and parent design IDs. A refinement creates new artifact IDs; the client can retain the latest acceptable artifact per A2A's task-refinement guidance.

### 6.6 Board assumptions

The interop layer should carry `board` and `boardProfile` on every task. Uno R3/Nano ATmega328P supports AVR-specific compile/sim/self-test assumptions; Uno R4 uses the RA4M1 ARM MCU and changes firmware/toolchain/pin/serial behavior; ESP32 adds Wi-Fi/dual-core/3.3 V constraints; Pico is RP2040 and not an Arduino AVR target. The agent card should not claim one board profile is universal. Board-specific validation belongs in the firmware/circuit slices; this slice only requires the board ID to be part of the action hash and task context.

---

## 7) Risks & unknowns

1. **Agent SDK/Bun incompatibility — medium/high.** Official Agent SDK docs target Node and a native binary; Bun support is not promised. Keep Node 22 for the main agent and use Bun only for the Channel if desired.
2. **Claude Code MCP-era behavior — medium.** The local 2.1.283 probe negotiated legacy `2025-11-25` over stdio, while modern `2026-07-28` support exists for some connections. Maintain v1 Channel compatibility and test the exact `.mcp.json`/HTTP path used in the demo.
3. **MCP Tasks support — high.** The Tasks extension is explicitly opt-in and host support varies. Do not make task completion depend on Claude Code implementing `tasks/get`; expose ordinary status/continue tools and use A2A as authority.
4. **Claude Channels research-preview allowlist — high.** Custom channels require `--dangerously-load-development-channels` until accepted/allowlisted; a plugin marketplace install alone does not remove this requirement. This can affect judge setup and should have a no-Channel web fallback.
5. **Channel delivery is session-bound — medium.** Events arrive only while Claude Code is running. The A2A task and ViBread approval broker must survive disconnects; Spectrum should poll/resync rather than assume a live terminal.
6. **Double-resume race — high.** Direct Channel A2A continuation and a Claude Code `vibread_continue_task` call could both answer one task. Use an atomic one-shot request/decision record.
7. **Approval spoofing/prompt injection — high.** Channel payloads are untrusted model context. Require sender allowlists, action hashes, expiry, user binding, exact grammar, and server-side policy. Claude Code's Channel docs explicitly warn about sender gating ([security](https://code.claude.com/docs/en/channels-reference#gate-inbound-messages)).
8. **Physical safety — high.** Software permissions cannot prove a breadboard is safe. Never rely on `bypassPermissions`, model confidence, phone vision, or MCP annotations to authorize energizing/flashing. MCU self-tests are the primary path; add current limiting and a hard stop.
9. **A2A push SSRF — high if enabled.** Only send to HTTPS allowlisted endpoints or a ViBread-owned relay; authenticate callbacks and cap response/connection size ([A2A push security](https://a2a-protocol.org/v1.0.0/topics/streaming-and-async/#security-considerations-for-push-notifications)).
10. **Artifact leakage — medium.** `.ino`, serial logs, and photos can carry secrets or personal data. Use short-lived signed URLs, size caps, MIME allowlists, and redaction before channel delivery.
11. **Commercial Agent SDK terms — medium.** The Agent SDK is governed by Anthropic Commercial Terms, not MIT. Confirm hackathon/public-repo compliance and avoid representing ViBread as Claude Code.
12. **No benchmark evidence — medium.** Exact model cost, first-token latency, and process memory under ViBread's tool schemas are **[UNVERIFIED]**. The SDK's documented prewarm memory is a useful ceiling signal, not a ViBread benchmark.
13. **Generic bridge maturity — medium.** Existing bridges are mostly new, low-star, protocol-transition projects. Use them as architecture references only; do not import or copy application code.
14. **Board not confirmed — high.** Uno R3/Nano is an assumption. Require a board profile before compile, flash, pin checks, and self-test; reject ambiguous board requests with A2A `INPUT_REQUIRED`.

---

## 8) Sources

Primary sources used:

1. [Claude Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview)
2. [Claude Agent SDK TypeScript API reference](https://code.claude.com/docs/en/agent-sdk/typescript)
3. [Agent SDK quickstart/authentication](https://code.claude.com/docs/en/agent-sdk/quickstart)
4. [Agent SDK custom tools/in-process MCP](https://code.claude.com/docs/en/agent-sdk/custom-tools)
5. [Agent SDK MCP configuration](https://code.claude.com/docs/en/agent-sdk/mcp)
6. [Agent SDK permissions and modes](https://code.claude.com/docs/en/agent-sdk/permissions)
7. [Agent SDK sessions/resume](https://code.claude.com/docs/en/agent-sdk/sessions)
8. [Anthropic TypeScript SDK repository](https://github.com/anthropics/anthropic-sdk-typescript)
9. [Anthropic Messages tool runner](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-runner)
10. [Vercel AI SDK agent approvals](https://ai-sdk.dev/docs/agents/tool-approvals)
11. [Mastra HITL](https://mastra.ai/docs/agents/human-in-the-loop)
12. [LangGraph.js HITL](https://docs.langchain.com/oss/javascript/langchain/human-in-the-loop)
13. [A2A JavaScript SDK README](https://github.com/a2aproject/a2a-js)
14. [A2A JavaScript SDK package manifest](https://raw.githubusercontent.com/a2aproject/a2a-js/main/package.json)
15. [A2A JavaScript sample server](https://raw.githubusercontent.com/a2aproject/a2a-js/main/src/samples/agents/sample-agent/index.ts)
16. [A2A JavaScript push-notification sample](https://raw.githubusercontent.com/a2aproject/a2a-js/main/src/samples/agents/push-notification-agent/index.ts)
17. [A2A v1 AgentCard/task/artifact definitions](https://a2a-protocol.org/v1.0.0/definitions/)
18. [A2A v1 task lifecycle](https://a2a-protocol.org/v1.0.0/topics/life-of-a-task/)
19. [A2A v1 streaming, push, and security](https://a2a-protocol.org/v1.0.0/topics/streaming-and-async/)
20. [MCP TypeScript SDK v2 repository](https://github.com/modelcontextprotocol/typescript-sdk)
21. [MCP SDK protocol-era guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/protocol-versions.md)
22. [MCP 2026-07-28 elicitation](https://modelcontextprotocol.io/specification/2026-07-28/client/elicitation)
23. [MCP Tasks extension](https://modelcontextprotocol.io/extensions/tasks/overview)
24. [Claude Code MCP server/configuration](https://code.claude.com/docs/en/mcp-servers)
25. [Claude Code changelog](https://code.claude.com/docs/en/changelog)
26. [Claude Code Channels overview](https://code.claude.com/docs/en/channels)
27. [Claude Code Channels reference](https://code.claude.com/docs/en/channels-reference)
28. [MCP Apps extension](https://modelcontextprotocol.io/extensions/apps/overview)
29. [A2A↔MCP bridge candidates](https://github.com/naveenkumarbaskaran/mcp-a2a-bridge), [Go gateway](https://github.com/nisimpson/a2a-gateway-mcp), [stateless bridge](https://github.com/aarushitandon0/a2a-mcp-bridge), [Bun gateway](https://github.com/jinyitao123/a2a-gateway), [skillmap](https://github.com/shashikanth-gs/a2a-mcp-skillmap), [coding-agent bridge](https://github.com/firstintent/a2a-bridge), [official A2A MCP sample](https://github.com/a2aproject/a2a-samples/tree/main/samples/python/agents/a2a_mcp)
30. [Photon Spectrum TypeScript repository](https://github.com/photon-hq/spectrum-ts) and [iMessage provider docs](https://photon.codes/docs/spectrum-ts/providers/imessage)

Package versions and modified timestamps were read from the linked npm registries on 2026-09-25. The Claude Code stdio handshake statement is an explicitly labeled local smoke observation against `@anthropic-ai/claude-code@2.1.283`; future releases/transports may differ.
