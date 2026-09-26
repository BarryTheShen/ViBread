import { randomUUID } from "node:crypto";
import express, { type Express, type Request } from "express";
import { z } from "zod";
import { A2A_PROTOCOL_VERSION, Role, TaskState, type AgentCard, type Artifact, type Message, type Task } from "@a2a-js/sdk";
import { AgentEvent, DefaultRequestHandler, InMemoryTaskStore, type AgentExecutor, type ExecutionEventBus, RequestContext } from "@a2a-js/sdk/server";
import { agentCardHandler, jsonRpcHandler, type UserBuilder } from "@a2a-js/sdk/server/express";
import { InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { AgentTurnResult, Actor, ApprovalRequest, InventoryItem, MissionDetail, ToolDef } from "@vibread/core";
import { invokeTool } from "@vibread/tools";
import type { AppContext } from "../context.js";

const MCP_VERSION = "1.0.0";
const MCP_PATH = "/mcp";
const A2A_PATH = "/a2a";

interface AuthInfoLike {
  token: string;
  clientId: string;
  scopes: string[];
  expiresAt?: number;
  extra?: Record<string, unknown>;
}

interface McpSession {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
}

interface UserLike {
  readonly isAuthenticated: boolean;
  readonly userName: string;
}

const actorFor = (id: string, channel: Actor["channel"]): Actor => ({
  kind: "agent",
  id,
  channel,
});

function tokenVerifier(ctx: AppContext) {
  return {
    async verifyAccessToken(token: string): Promise<AuthInfoLike> {
      const record = await ctx.tokens.verify(token);
      if (!record) throw new InvalidTokenError("Invalid or expired access token");
      const expiresAt = Date.parse(record.expiresAt);
      if (!Number.isFinite(expiresAt)) throw new InvalidTokenError("Access token has an invalid expiration");
      return {
        token,
        clientId: record.id,
        scopes: record.scopes,
        expiresAt: expiresAt / 1000,
        extra: { userId: record.userId },
      };
    },
  };
}

function authUserId(request: Request): string {
  const extra = request.auth?.extra?.userId;
  return typeof extra === "string" && extra.length > 0 ? extra : request.auth?.clientId ?? "remote-agent";
}

function requestedScopes(request: Request): string[] {
  return request.auth?.scopes ?? [];
}

function requiredScope(actionClass: ToolDef["actionClass"]): string {
  switch (actionClass) {
    case "read-only":
      return "circuits:read";
    case "physical":
      return "bench:request";
    case "state-changing":
    case "release":
    case "bom-change":
      return "circuits:write";
  }
}

function hasScope(scopes: readonly string[], scope: string): boolean {
  return scopes.includes(scope);
}

function approvalView(request: ApprovalRequest): Record<string, unknown> {
  return {
    id: request.id,
    missionId: request.missionId,
    actionClass: request.actionClass,
    action: request.action,
    summary: request.summary,
    consequence: request.consequence,
    revisionHash: request.revisionHash,
    status: request.status,
    requestedBy: request.requestedBy,
    expiresAt: request.expiresAt,
  };
}

function resultText(value: unknown): string {
  if (typeof value === "string") return value;
  const encoded = JSON.stringify(value);
  return encoded === undefined ? String(value) : encoded;
}

function toolCallResult(value: unknown, isError = false): { content: [{ type: "text"; text: string }]; isError?: boolean } {
  return {
    content: [{ type: "text", text: resultText(value) }],
    ...(isError ? { isError: true } : {}),
  };
}
function extractObjectShape(schema: z.ZodType<unknown>): Record<string, z.ZodType<unknown>> | undefined {
  const candidate = schema as unknown as { shape?: unknown; _zod?: { def?: { shape?: unknown } } };
  const shape = candidate.shape ?? candidate._zod?.def?.shape;
  if (!shape || typeof shape !== "object") return undefined;
  const entries = Object.entries(shape);
  if (!entries.every(([, value]) => value && typeof value === "object")) return undefined;
  return Object.fromEntries(entries) as Record<string, z.ZodType<unknown>>;
}

function mcpToolShape(def: ToolDef): Record<string, z.ZodType<unknown>> {
  const existing = extractObjectShape(def.input);
  if (existing) return { ...existing, missionId: z.string().describe("ViBread mission ID") };
  return {
    missionId: z.string().describe("ViBread mission ID"),
    input: def.input,
  };
}

async function ownedMission(ctx: AppContext, missionId: string, request: Request): Promise<MissionDetail> {
  const detail = await ctx.missions.detail(missionId);
  if (detail.mission.ownerId !== authUserId(request)) throw new Error("Mission not found");
  return detail;
}

async function callTool(def: ToolDef, args: Record<string, unknown>, request: Request, ctx: AppContext) {
  const missionId = args.missionId;
  if (typeof missionId !== "string" || missionId.length === 0) throw new Error("missionId is required");
  const detail = await ownedMission(ctx, missionId, request);
  const actor = actorFor(authUserId(request), "mcp");
  const scopes = requestedScopes(request);
  const needed = requiredScope(def.actionClass);
  if (!hasScope(scopes, needed)) throw new Error(`Missing scope: ${needed}`);

  const { missionId: _ignored, input: nestedInput, ...objectInput } = args;
  const input = extractObjectShape(def.input) ? objectInput : nestedInput;
  const parsed = await def.input.parseAsync(input);
  const gated = await invokeTool({
    registry: ctx.tools,
    broker: ctx.broker,
    store: ctx.store,
    ctx: { missionId, actor },
    name: def.name,
    args: parsed,
  });
  switch (gated.status) {
    case "executed":
      return gated.output;
    case "denied":
      return { executed: false, denied: true, reason: gated.reason };
    case "approval-required":
      return { executed: false, pending: true, approval: approvalView(gated.approval), message: "This action is waiting for a human approval." };
    case "bench-click":
      return {
        requested: true,
        executed: false,
        pending: true,
        approval: gated.approval ? approvalView(gated.approval) : undefined,
        output: gated.output,
        message: "Physical action requested. It remains pending until a human clicks the bench control.",
      };
  }
}

function registerMissionTools(server: McpServer, ctx: AppContext, request: Request, scopes: string[]): void {
  if (hasScope(scopes, "circuits:read")) {
    server.registerTool(
      "vibread_list_missions",
      {
        title: "List ViBread missions",
        description: "List missions owned by the authenticated caller.",
        inputSchema: {},
      },
      async () => {
        const missions = await ctx.missions.list(authUserId(request));
        return toolCallResult(missions);
      },
    );
    server.registerTool(
      "vibread_status",
      {
        title: "Mission status",
        description: "Read the current mission phase, revision, consoles, and pending approvals.",
        inputSchema: { missionId: z.string() },
      },
      async ({ missionId }) => toolCallResult(await ownedMission(ctx, missionId, request)),
    );
  }

  if (hasScope(scopes, "circuits:write")) {
    server.registerTool(
      "vibread_create_mission",
      {
        title: "Create a ViBread mission",
        description: "Create a mission from a natural-language circuit brief.",
        inputSchema: {
          brief: z.string().min(1),
          title: z.string().optional(),
          mode: z.enum(["plan", "ask", "review", "autopilot"]).optional(),
          inventory: z.array(
            z.object({
              module: z.string(),
              count: z.number().int().nonnegative(),
              params: z.record(z.string(), z.unknown()).optional(),
              note: z.string().optional(),
            }),
          ).optional(),
        },
      },
      async ({ brief, title, mode, inventory }) => {
        const actor = actorFor(authUserId(request), "mcp");
        const mission = await ctx.missions.create({
          brief,
          title,
          mode,
          owner: actor,
          inventory: (inventory ?? []) as InventoryItem[],
        });
        return toolCallResult(mission);
      },
    );
    server.registerTool(
      "vibread_say",
      {
        title: "Talk to the ViBread agent",
        description: "Send a natural-language turn to a mission agent.",
        inputSchema: { missionId: z.string(), text: z.string().min(1) },
      },
      async ({ missionId, text }) => {
        await ownedMission(ctx, missionId, request);
        const result = await ctx.missions.say(missionId, text, actorFor(authUserId(request), "mcp"));
        return toolCallResult(result);
      },
    );
    server.registerTool(
      "vibread_continue_task",
      {
        title: "Continue an ask-back task",
        description: "Answer the last question from ViBread and continue the mission turn.",
        inputSchema: { missionId: z.string(), answer: z.string().min(1) },
      },
      async ({ missionId, answer }) => {
        await ownedMission(ctx, missionId, request);
        const result = await ctx.missions.say(missionId, answer, actorFor(authUserId(request), "mcp"));
        return toolCallResult(result);
      },
    );
  }
}

function registerToolDefs(server: McpServer, ctx: AppContext, request: Request, scopes: string[]): void {
  for (const def of ctx.tools.list()) {
    if (!hasScope(scopes, requiredScope(def.actionClass))) continue;
    const shape = mcpToolShape(def);
    
    server.registerTool(
      def.name,
      {
        title: def.title,
        description: def.description,
        inputSchema: shape,
      },
      async (args) => {
        try {
          const value = await callTool(def, args as Record<string, unknown>, request, ctx);
          return toolCallResult(value);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return toolCallResult(message, true);
        }
      },
    );
  }
}

function createMcpServer(ctx: AppContext, request: Request): McpServer {
  const server = new McpServer(
    { name: "vibread", version: MCP_VERSION },
    { instructions: "Mission Control for your breadboard. Physical actions always require a bench click." },
  );
  const scopes = requestedScopes(request);
  registerToolDefs(server, ctx, request, scopes);
  registerMissionTools(server, ctx, request, scopes);
  return server;
}

/** Mount the scoped Streamable HTTP MCP server at `/mcp`. */
export function mountMcp(app: Express, ctx: AppContext): void {
  const verifier = tokenVerifier(ctx);
  const sessions = new Map<string, McpSession>();
  const bearer = requireBearerAuth({ verifier });

  app.use(MCP_PATH, express.json(), bearer, async (request, response) => {
    const sessionIdHeader = request.header("Mcp-Session-Id");
    const existing = sessionIdHeader ? sessions.get(sessionIdHeader) : undefined;
    if (sessionIdHeader && !existing) {
      response.status(404).json({ error: "Unknown MCP session" });
      return;
    }

    const session = existing ?? {
      server: createMcpServer(ctx, request),
      transport: new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() }),
    };
    if (!existing) {
      session.transport.onclose = () => {
        const id = session.transport.sessionId;
        if (id) sessions.delete(id);
      };
      await session.server.connect(session.transport);
    }

    await session.transport.handleRequest(request, response, request.body);
    if (!existing && session.transport.sessionId) sessions.set(session.transport.sessionId, session);
  });
}

function textOf(message: Message): string {
  return message.parts
    .filter((part) => part.content?.$case === "text")
    .map((part) => (part.content?.$case === "text" ? part.content.value : ""))
    .join("\n");
}

function a2aAgentMessage(contextId: string, taskId: string, text: string): Message {
  return {
    messageId: randomUUID(),
    contextId,
    taskId,
    role: Role.ROLE_AGENT,
    parts: [{ content: { $case: "text", value: text }, metadata: undefined, filename: "", mediaType: "text/plain" }],
    metadata: undefined,
    extensions: [],
    referenceTaskIds: [],
  };
}

function a2aUserMessage(requestContext: RequestContext): Message {
  return requestContext.userMessage;
}

function taskStatus(state: TaskState, message: Message | undefined) {
  return { state, timestamp: new Date().toISOString(), message };
}

function missionIdFromTask(task: Task | undefined): string | undefined {
  const value = task?.metadata?.missionId;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function a2aActor(requestContext: RequestContext): Actor {
  return actorFor(requestContext.context.user?.userName ?? "a2a-agent", "a2a");
}

function artifactForResult(taskId: string, contextId: string, result: AgentTurnResult): Artifact {
  const revision = result.revision === undefined ? "not created" : String(result.revision);
  const approvals = result.pendingApprovals.length === 0 ? "none" : String(result.pendingApprovals.length);
  const answer = `${result.text}\n\nRevision summary: revision ${revision}; pending approvals ${approvals}.`;
  return {
    artifactId: `${taskId}-answer`,
    name: "vibread-answer",
    description: "ViBread agent answer and revision summary",
    parts: [{ content: { $case: "text", value: answer }, metadata: undefined, filename: "answer.txt", mediaType: "text/plain" }],
    metadata: { taskId, contextId, revision: result.revision },
    extensions: [],
  };
}

function createA2aExecutor(ctx: AppContext): AgentExecutor {
  return {
    async execute(requestContext: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
      const incoming = a2aUserMessage(requestContext);
      const actor = a2aActor(requestContext);
      const existingMissionId = missionIdFromTask(requestContext.task);
      let missionId = existingMissionId;
      let result: AgentTurnResult;

      if (!missionId) {
        const mission = await ctx.missions.create({ brief: textOf(incoming), inventory: [], owner: actor, mode: "review" });
        missionId = mission.id;
      }
      result = await ctx.missions.say(missionId, textOf(incoming), actor);

      const history = [...(requestContext.task?.history ?? []), incoming];
      const task: Task = {
        id: requestContext.task?.id ?? requestContext.taskId,
        contextId: requestContext.task?.contextId ?? requestContext.contextId,
        status: taskStatus(TaskState.TASK_STATE_SUBMITTED, undefined),
        artifacts: requestContext.task?.artifacts ?? [],
        history,
        metadata: { ...(requestContext.task?.metadata ?? {}), missionId },
      };
      // A2A requires a task/message event before any status or artifact event, including continuations.
      eventBus.publish(AgentEvent.task(task));

      const question = result.question ?? (result.pendingApprovals.length > 0
        ? result.pendingApprovals.map((approval) => approval.summary).join("\n")
        : undefined);
      if (question) {
        eventBus.publish(
          AgentEvent.statusUpdate({
            taskId: task.id,
            contextId: task.contextId,
            status: taskStatus(TaskState.TASK_STATE_INPUT_REQUIRED, a2aAgentMessage(task.contextId, task.id, question)),
            metadata: { missionId },
          }),
        );
        return;
      }

      const artifact = artifactForResult(task.id, task.contextId, result);
      eventBus.publish(
        AgentEvent.artifactUpdate({
          taskId: task.id,
          contextId: task.contextId,
          artifact,
          append: false,
          lastChunk: true,
          metadata: { missionId },
        }),
      );
      eventBus.publish(
        AgentEvent.statusUpdate({
          taskId: task.id,
          contextId: task.contextId,
          status: taskStatus(TaskState.TASK_STATE_COMPLETED, a2aAgentMessage(task.contextId, task.id, result.text)),
          metadata: { missionId },
        }),
      );
    },

    async cancelTask(taskId: string, eventBus: ExecutionEventBus): Promise<void> {
      eventBus.publish(
        AgentEvent.statusUpdate({
          taskId,
          contextId: taskId,
          status: taskStatus(TaskState.TASK_STATE_CANCELED, a2aAgentMessage(taskId, taskId, "Task canceled.")),
          metadata: undefined,
        }),
      );
    },
  };
}

function makeAgentCard(ctx: AppContext): AgentCard {
  const baseUrl = ctx.config.publicUrl.replace(/\/$/, "");
  return {
    name: "ViBread Mission Control",
    description: "AI-assisted Arduino prototyping with checked designs, physical verification, and permissioned actions.",
    supportedInterfaces: [{ url: `${baseUrl}${A2A_PATH}`, protocolBinding: "JSONRPC", tenant: "", protocolVersion: A2A_PROTOCOL_VERSION }],
    provider: { organization: "ViBread", url: baseUrl },
    version: MCP_VERSION,
    documentationUrl: baseUrl,
    capabilities: { streaming: true, pushNotifications: false, extensions: [], extendedAgentCard: false },
    securitySchemes: {
      Bearer: {
        scheme: {
          $case: "httpAuthSecurityScheme",
          value: { description: "ViBread bearer token", scheme: "bearer", bearerFormat: "JWT" },
        },
      },
    },
    securityRequirements: [{ schemes: { Bearer: { list: [] } } }],
    defaultInputModes: ["text"],
    defaultOutputModes: ["text"],
    skills: [
      {
        id: "mission-control",
        name: "Mission Control",
        description: "Design, check, and verify Arduino breadboard missions.",
        tags: ["arduino", "breadboard", "mission"],
        examples: ["Build a moon-phase lamp", "Check my wiring"],
        inputModes: ["text"],
        outputModes: ["text"],
        securityRequirements: [{ schemes: { Bearer: { list: [] } } }],
      },
    ],
    signatures: [],
  };
}

function a2aUserBuilder(): UserBuilder {
  return async (request) => {
    const userName = authUserId(request);
    const user: UserLike = {
      get isAuthenticated(): boolean {
        return Boolean(request.auth);
      },
      get userName(): string {
        return userName;
      },
    };
    return user;
  };
}

/** Mount the authenticated A2A JSON-RPC handler and public v1 agent card. */
export function mountA2a(app: Express, ctx: AppContext): void {
  const card = makeAgentCard(ctx);
  const requestHandler = new DefaultRequestHandler(card, new InMemoryTaskStore(), createA2aExecutor(ctx));
  app.use("/.well-known/agent-card.json", agentCardHandler({ agentCardProvider: requestHandler }));
  app.use(
    A2A_PATH,
    express.json(),
    requireBearerAuth({ verifier: tokenVerifier(ctx) }),
    jsonRpcHandler({ requestHandler, userBuilder: a2aUserBuilder() }),
  );
}