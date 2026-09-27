import { randomUUID } from "node:crypto";
import express, { type ErrorRequestHandler, type Express, type Request, type RequestHandler, type Response } from "express";
import { z } from "zod";
import { A2A_PROTOCOL_VERSION, Role, TaskState, type AgentCard, type Artifact, type Message, type Task } from "@a2a-js/sdk";
import { AgentEvent, DefaultRequestHandler, InMemoryTaskStore, type AgentExecutor, type ExecutionEventBus, RequestContext } from "@a2a-js/sdk/server";
import { agentCardHandler, jsonRpcHandler, type UserBuilder } from "@a2a-js/sdk/server/express";
import { requireMcpAuth } from "@better-auth/mcp";
import type { Auth, BetterAuthOptions } from "better-auth";
import { fromNodeHeaders } from "better-auth/node";
import { eq } from "drizzle-orm";
import { InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { MODULE_KEYS, type AgentTurnResult, type Actor, type ApprovalRequest, type InventoryItem, type MissionDetail, type ToolDef } from "@vibread/core";
import { createUserTools, invokeTool } from "@vibread/tools";
import type { AppContext } from "../context.js";
import { oauthClient } from "../db/schema.js";

declare global {
  // Express request augmentation, as the MCP SDK's bearer middleware declares it.
  namespace Express {
    interface Request {
      /** Set by the /mcp and /a2a auth middleware; the MCP transport hands it to tool handlers. */
      auth?: AuthInfo;
    }
  }
}

const MCP_VERSION = "1.0.0";
const MCP_PATH = "/mcp";
const A2A_PATH = "/a2a";
/** Chat messages and answers: the web chat box's limit (4000); mission name: the name field's (80). A brief has no limit. */
const MAX_TEXT = 4000;
const MAX_TITLE = 80;
/** Matches the server-wide express.json limit in main.ts. */
const BODY_LIMIT = "2mb";
const ALL_SCOPES = ["circuits:read", "circuits:write", "bench:request"] as const;
const TOKEN_HELP =
  'Mint a new token in ViBread Settings → Connect Claude Code and send it as "Authorization: Bearer vb_…", or connect without that header to sign in with OAuth.';

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
  userId: string;
  scopes: string[];
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

function sendJsonRpcError(response: Response, status: number, code: number, message: string, id: unknown = null): void {
  response.status(status).json({ jsonrpc: "2.0", error: { code, message }, id });
}

/** The JSON-RPC id of the request being rejected, so the client can match the error to its call. */
function requestId(request: Request): unknown {
  const body: unknown = request.body;
  return body && typeof body === "object" && "id" in body ? body.id ?? null : null;
}

/**
 * Bearer auth for ViBread `vb_` tokens (Settings → Connect Claude Code). Failures keep the RFC 6750 status and
 * WWW-Authenticate challenge but answer with a JSON-RPC error that tells the remote agent how to get a working token.
 */
function bearerAuth(ctx: AppContext, oauth: boolean): RequestHandler {
  const verifier = tokenVerifier(ctx);
  const metadata = oauth ? `, resource_metadata="${ctx.config.publicUrl.replace(/\/$/, "")}/.well-known/oauth-protected-resource${MCP_PATH}"` : "";
  return async (request, response, next) => {
    const match = /^Bearer\s+(\S+)\s*$/i.exec(request.header("authorization") ?? "");
    if (!match?.[1]) {
      response.setHeader("WWW-Authenticate", `Bearer error="invalid_request", error_description="Missing access token"${metadata}`);
      sendJsonRpcError(response, 401, -32000, `ViBread needs an access token. ${TOKEN_HELP}`, requestId(request));
      return;
    }
    try {
      request.auth = await verifier.verifyAccessToken(match[1]);
    } catch (error) {
      if (!(error instanceof InvalidTokenError)) {
        next(error);
        return;
      }
      response.setHeader("WWW-Authenticate", `Bearer error="invalid_token", error_description="${error.message}"${metadata}`);
      sendJsonRpcError(response, 401, -32000, `ViBread rejected the access token: ${error.message}. ${TOKEN_HELP}`, requestId(request));
      return;
    }
    next();
  };
}

/** Body-parser failures (bad JSON, too large) and unexpected errors on /mcp and /a2a as JSON-RPC errors, not REST JSON. */
function jsonRpcErrorHandler(ctx: AppContext): ErrorRequestHandler {
  return (error: unknown, request, response, next) => {
    if (response.headersSent) {
      next(error);
      return;
    }
    const fields: object = error && typeof error === "object" ? error : {};
    const type = "type" in fields ? fields.type : undefined;
    const status = "status" in fields ? fields.status : undefined;
    const detail = "message" in fields && typeof fields.message === "string" ? fields.message : String(error);
    if (type === "entity.parse.failed") {
      sendJsonRpcError(response, 400, -32700, `Parse error: the request body isn't valid JSON (${detail}).`);
      return;
    }
    if (type === "entity.too.large") {
      sendJsonRpcError(response, 413, -32600, `Request too large: ViBread accepts JSON-RPC bodies up to ${BODY_LIMIT}. Send smaller arguments.`, requestId(request));
      return;
    }
    if (typeof status === "number" && status >= 400 && status < 500 && "expose" in fields && fields.expose === true) {
      sendJsonRpcError(response, status, -32600, `Invalid request: ${detail}`, requestId(request));
      return;
    }
    ctx.log.error({ err: error, path: request.originalUrl }, "interop request failed");
    sendJsonRpcError(response, 500, -32603, "Internal error in ViBread. Retry the call; if it keeps failing, check the ViBread server log.", requestId(request));
  };
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

/** A missing and a foreign mission read the same, so mission IDs can't be probed across users. */
async function ownedMission(ctx: AppContext, missionId: string, request: Request): Promise<MissionDetail> {
  const notFound = `Mission ${missionId} not found. Call vibread_list_missions for the IDs of your missions.`;
  let detail: MissionDetail;
  try {
    detail = await ctx.missions.detail(missionId);
  } catch (error) {
    if (error instanceof Error && "status" in error && error.status === 404) throw new Error(notFound);
    throw error;
  }
  if (detail.mission.ownerId !== authUserId(request)) throw new Error(notFound);
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
    case "bench-click":
      return {
        requested: true,
        executed: false,
        pending: true,
        approval: approvalView(gated.approval),
        output: gated.output,
        message: "Physical action requested. It remains pending until a human clicks the bench control.",
      };
  }
}

const missionIdArg = z.string().min(1).describe("ViBread mission ID (from vibread_list_missions or vibread_create_mission)");

function registerMissionTools(server: McpServer, ctx: AppContext, request: Request, scopes: string[]): void {
  if (hasScope(scopes, "circuits:read")) {
    server.registerTool(
      "vibread_list_missions",
      {
        title: "List ViBread missions",
        description: "List the missions you own: id, title, brief, phase. Use an id as missionId in the other tools.",
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
        description:
          "Read a mission: phase, latest and released revision, every console's Go/No-Go verdict with its findings, and pending bench requests.",
        inputSchema: { missionId: missionIdArg },
      },
      async ({ missionId }) => toolCallResult(await ownedMission(ctx, missionId, request)),
    );
  }

  if (hasScope(scopes, "circuits:write")) {
    server.registerTool(
      "vibread_create_mission",
      {
        title: "Create a ViBread mission",
        description:
          "Create a mission from a plain-language brief of what the circuit should do. Returns the mission (use its id as missionId). Then call propose_design with a complete circuit; there is no separate clarify step for you.",
        inputSchema: {
          brief: z.string().min(1).describe("What the circuit should do, in plain words (any length)."),
          title: z.string().min(1).max(MAX_TITLE).optional().describe("Mission name; derived from the brief when omitted."),
          inventory: z
            .array(
              z.object({
                module: z.enum(MODULE_KEYS).describe("Module key, see list_modules."),
                count: z.number().int().nonnegative(),
                params: z.record(z.string(), z.unknown()).optional().describe('Narrows the module, e.g. { "color": "red" } or { "ohms": 220 }.'),
                note: z.string().max(200).optional(),
              }),
            )
            .max(50)
            .optional()
            .describe("Parts the design may use. Omit to copy the parts the user keeps in ViBread (vibread_get_inventory)."),
        },
      },
      async ({ brief, title, inventory }) => {
        const actor = actorFor(authUserId(request), "mcp");
        const mission = await ctx.missions.create({
          brief,
          title,
          owner: actor,
          // No parts given → MissionService copies the owner's inventory (plan §5.4).
          ...(inventory ? { inventory: inventory satisfies InventoryItem[] } : {}),
        });
        return toolCallResult(mission);
      },
    );
    server.registerTool(
      "vibread_say",
      {
        title: "Talk to ViBread's own agent",
        description:
          "Send a plain-language turn to ViBread's built-in design agent, which runs on the Claude account connected in ViBread. You don't need it to design: call propose_design and the check tools yourself.",
        inputSchema: { missionId: missionIdArg, text: z.string().min(1).max(MAX_TEXT) },
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
        description: "Answer the last question ViBread's built-in agent asked (see vibread_say) and continue its turn.",
        inputSchema: { missionId: missionIdArg, answer: z.string().min(1).max(MAX_TEXT) },
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

/** User-level read tools (no missionId): the authenticated user's own data only, e.g. vibread_get_inventory. */
function registerUserTools(server: McpServer, ctx: AppContext, request: Request, scopes: string[]): void {
  if (!hasScope(scopes, "circuits:read")) return;
  for (const def of createUserTools({ inventory: ctx.inventory })) {
    server.registerTool(def.name, { title: def.title, description: def.description, inputSchema: {} }, async () => {
      try {
        return toolCallResult(await def.handler({ ownerId: authUserId(request) }, {}));
      } catch (error) {
        return toolCallResult(error instanceof Error ? error.message : String(error), true);
      }
    });
  }
}

function createMcpServer(ctx: AppContext, request: Request): McpServer {
  const scopes = requestedScopes(request);
  const missing = ALL_SCOPES.filter((scope) => !scopes.includes(scope));
  const instructions = [
    "ViBread is Mission Control for an Arduino breadboard. Create a mission (vibread_create_mission), then propose_design with a complete circuit: it saves a revision and runs every Go/No-Go console. Fix the findings it returns and propose again.",
    "GO for build (releasing a revision to the bench) is human-only: when every console is GO, ask the person to press GO for build in ViBread (web) or reply GO in iMessage. request_bench_action only queues a physical action; it runs when the person clicks Start at the bench.",
    `This connection's scopes: ${scopes.join(", ") || "none"}.`,
    ...(missing.length > 0 ? [`Tools that need ${missing.join(", ")} are not listed; mint a token with those scopes in ViBread Settings → Connect Claude Code to use them.`] : []),
  ].join("\n");
  const server = new McpServer({ name: "vibread", version: MCP_VERSION }, { instructions });
  registerToolDefs(server, ctx, request, scopes);
  registerMissionTools(server, ctx, request, scopes);
  registerUserTools(server, ctx, request, scopes);
  return server;
}
function webRequestFor(request: Request): globalThis.Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (typeof value === "string") headers.set(name, value);
    else if (Array.isArray(value)) headers.set(name, value.join(", "));
  }
  const url = `${request.protocol}://${request.get("host")}${request.originalUrl}`;
  const init: RequestInit = { method: request.method, headers };
  if (request.method !== "GET" && request.method !== "HEAD" && request.body !== undefined) init.body = JSON.stringify(request.body);
  return new globalThis.Request(url, init);
}

function oauthMiddleware(auth: Auth<BetterAuthOptions>, ctx: AppContext, bearer: RequestHandler): RequestHandler {
  return async (request, response, next) => {
    const authorization = request.header("authorization") ?? "";
    if (authorization.toLowerCase().startsWith("bearer vb_")) {
      bearer(request, response, next);
      return;
    }
    let oauthClaims: Record<string, unknown> | undefined;
    const verify = requireMcpAuth(
      auth,
      async (_request, claims) => {
        oauthClaims = claims as Record<string, unknown>;
        return new globalThis.Response(null, { status: 204 });
      },
      { resource: `${ctx.config.publicUrl.replace(/\/$/, "")}${MCP_PATH}`, challengeScopes: ["circuits:read", "circuits:write", "bench:request"] },
    );
    const result = await verify(webRequestFor(request));
    if (result.status !== 204) {
      // Keep Better Auth's status and WWW-Authenticate challenge (OAuth discovery); replace its body with an actionable JSON-RPC error.
      result.headers.forEach((value, name) => {
        if (name !== "content-type" && name !== "content-length") response.setHeader(name, value);
      });
      const problem = result.status !== 401 ? `ViBread refused the request (HTTP ${result.status}).` : authorization ? "ViBread rejected the access token (invalid or expired)." : "ViBread needs an access token.";
      sendJsonRpcError(response, result.status, -32000, `${problem} ${TOKEN_HELP}`, requestId(request));
      return;
    }
    if (!oauthClaims) {
      sendJsonRpcError(response, 401, -32000, `ViBread couldn't read the OAuth token's claims. ${TOKEN_HELP}`, requestId(request));
      return;
    }
    const token = authorization.replace(/^Bearer\s+/i, "");
    const rawScope = oauthClaims.scope;
    const scopes = typeof rawScope === "string" ? rawScope.split(/\s+/).filter(Boolean) : Array.isArray(rawScope) ? rawScope.filter((scope): scope is string => typeof scope === "string") : [];
    const sub = typeof oauthClaims.sub === "string" ? oauthClaims.sub : undefined;
    const clientId = typeof oauthClaims.client_id === "string" ? oauthClaims.client_id : "oauth-client";
    const expiresAt = typeof oauthClaims.exp === "number" ? oauthClaims.exp : undefined;
    request.auth = { token, clientId, scopes, expiresAt, extra: { userId: sub } };
    next();
  };
}
const OPERATOR_EMAIL = "operator@vibread.local";

/** Single-operator mode: gives the operator user a credential account whose password is derived from the auth secret. */
async function operatorPassword(auth: Auth<BetterAuthOptions>, ctx: AppContext): Promise<string> {
  await ctx.operator();
  const context = await auth.$context;
  const password = `${ctx.config.authSecret}:vibread-operator`;
  const hash = await context.password.hash(password);
  const account = await context.internalAdapter.findCredentialAccount("operator");
  if (account) await context.internalAdapter.updateAccount(account.id, { password: hash });
  else await context.internalAdapter.linkAccount({ userId: "operator", providerId: "credential", accountId: "operator", password: hash });
  return password;
}

/** Mount JSON contracts consumed by the SPA OAuth pages. */
function mountOAuthApi(app: Express, ctx: AppContext, auth?: Auth<BetterAuthOptions>): void {
  app.use("/api/oauth", express.json());
  app.get("/api/oauth/providers", (_request, response) => {
    response.json({
      singleOperator: ctx.config.singleOperator,
      providers: [
        ...(ctx.config.google ? ["google" as const] : []),
        ...(ctx.config.github ? ["github" as const] : []),
      ],
    });
  });
  app.get("/api/oauth/client", async (request, response, next) => {
    try {
      const clientId = typeof request.query.client_id === "string" ? request.query.client_id : "";
      if (!clientId) {
        response.status(404).json({ error: "unknown_client" });
        return;
      }
      const [client] = await ctx.db.select({
        clientId: oauthClient.clientId,
        name: oauthClient.name,
        uri: oauthClient.uri,
        redirectUris: oauthClient.redirectUris,
        scopes: oauthClient.scopes,
      }).from(oauthClient).where(eq(oauthClient.clientId, clientId)).limit(1);
      if (!client) {
        response.status(404).json({ error: "unknown_client" });
        return;
      }
      response.json({
        clientId: client.clientId,
        name: client.name ?? client.clientId,
        ...(client.uri ? { uri: client.uri } : {}),
        redirectUris: client.redirectUris ?? [],
        scopes: client.scopes ?? [],
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/oauth/operator-login", async (request, response, next) => {
    if (!auth || !ctx.config.singleOperator) {
      response.status(401).json({ error: "invalid_credentials" });
      return;
    }
    const body = request.body as { email?: unknown; password?: unknown; oauth_query?: unknown };
    if (typeof body.email !== "string" || typeof body.password !== "string" || typeof body.oauth_query !== "string") {
      response.status(401).json({ error: "invalid_credentials" });
      return;
    }
    const signedExp = Number(new URLSearchParams(body.oauth_query).get("exp"));
    if (Number.isFinite(signedExp) && signedExp * 1000 < Date.now()) {
      response.status(400).json({ error: "link_expired" });
      return;
    }
    try {
      const headers = fromNodeHeaders(request.headers);
      headers.set("content-type", "application/json");
      const password = await operatorPassword(auth, ctx);
      headers.delete("content-length");
      const result = await auth.handler(new globalThis.Request(`${ctx.config.publicUrl}/api/auth/sign-in/email`, {
        method: "POST",
        headers,
        body: JSON.stringify({ email: body.email, password, oauth_query: body.oauth_query }),
      }));
      if (result.status >= 400) {
        response.status(401).json({ error: "invalid_credentials" });
        return;
      }
      const cookies = result.headers.getSetCookie();
      if (cookies.length > 0) response.setHeader("Set-Cookie", cookies);
      const location = result.headers.get("location");
      const payload: unknown = await result.json().catch(() => null);
      const redirect = location ?? (payload && typeof payload === "object" && "url" in payload && typeof payload.url === "string" ? payload.url : undefined);
      response.json({ redirect: redirect ?? "/" });
    } catch {
      response.status(401).json({ error: "invalid_credentials" });
    }
  });
}

/** Mount the scoped Streamable HTTP MCP server at `/mcp`. */
export function mountMcp(app: Express, ctx: AppContext, auth?: Auth<BetterAuthOptions>): void {
  const sessions = new Map<string, McpSession>();
  const bearer = bearerAuth(ctx, Boolean(auth));
  const hybridAuth = auth ? oauthMiddleware(auth, ctx, bearer) : bearer;
  mountOAuthApi(app, ctx, auth);
  app.use(MCP_PATH, express.json({ limit: BODY_LIMIT }), hybridAuth, async (request, response) => {
    const userId = authUserId(request);
    const scopes = requestedScopes(request);
    const sessionIdHeader = request.header("Mcp-Session-Id");
    const existing = sessionIdHeader ? sessions.get(sessionIdHeader) : undefined;
    // Unknown, ended, or another token's session: 404 tells a spec-compliant client to start a new session.
    if (sessionIdHeader && (!existing || existing.userId !== userId || existing.scopes.some((scope) => !scopes.includes(scope)) || scopes.some((scope) => !existing.scopes.includes(scope)))) {
      sendJsonRpcError(response, 404, -32001, "MCP session not found (it ended, ViBread restarted, or it belongs to another token). Start a new session: send initialize without an Mcp-Session-Id header.", requestId(request));
      return;
    }

    const session = existing ?? {
      server: createMcpServer(ctx, request),
      transport: new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() }),
      userId,
      scopes: [...scopes],
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
  app.use(MCP_PATH, jsonRpcErrorHandler(ctx));
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
  /** Every task this executor published and that is not finished yet (working or waiting in INPUT_REQUIRED) → its contextId. */
  const open = new Map<string, string>();
  /** Tasks whose turn is still running; `canceled` tells the turn not to publish its outcome. */
  const running = new Map<string, { canceled: boolean }>();
  return {
    async execute(requestContext: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
      const incoming = a2aUserMessage(requestContext);
      const text = textOf(incoming).trim();
      if (text.length === 0) throw new Error("Send the request as a text part, e.g. \"Build a moon-phase lamp\".");
      const actor = a2aActor(requestContext);
      const existing = missionIdFromTask(requestContext.task);
      // A new task's text becomes the mission brief, which has no length limit; later messages are chat turns.
      if (existing && text.length > MAX_TEXT) throw new Error(`The message is ${text.length} characters; ViBread accepts up to ${MAX_TEXT}. Send a shorter message.`);
      const missionId = existing ?? (await ctx.missions.create({ brief: text, owner: actor })).id;
      const task: Task = {
        id: requestContext.task?.id ?? requestContext.taskId,
        contextId: requestContext.task?.contextId ?? requestContext.contextId,
        status: taskStatus(TaskState.TASK_STATE_WORKING, undefined),
        artifacts: requestContext.task?.artifacts ?? [],
        history: [...(requestContext.task?.history ?? []), incoming],
        metadata: { ...(requestContext.task?.metadata ?? {}), missionId },
      };
      // A2A requires a task/message event before any status or artifact event, including continuations. Publishing it
      // before the turn makes the task visible to GetTask and CancelTask while ViBread works.
      eventBus.publish(AgentEvent.task(task));
      open.set(task.id, task.contextId);
      const run = { canceled: false };
      running.set(task.id, run);
      let result: AgentTurnResult;
      try {
        result = await ctx.missions.say(missionId, text, actor);
      } catch (error) {
        open.delete(task.id);
        throw error;
      } finally {
        running.delete(task.id);
      }
      // Canceled mid-turn: the mission keeps the turn's outcome, but the canceled task must not flip back to done.
      if (run.canceled) return;

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
      open.delete(task.id);
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
      const contextId = open.get(taskId);
      if (contextId === undefined) throw new Error(`Task ${taskId} is not open on this ViBread server, so it cannot be canceled.`);
      open.delete(taskId);
      // Only a running turn needs telling; a task waiting in INPUT_REQUIRED has no turn, but its bus is still alive and
      // CancelTask waits on it, so the CANCELED update and finish below are always published.
      const run = running.get(taskId);
      if (run) run.canceled = true;
      eventBus.publish(
        AgentEvent.statusUpdate({
          taskId,
          contextId,
          status: taskStatus(TaskState.TASK_STATE_CANCELED, a2aAgentMessage(contextId, taskId, "Task canceled. The ViBread mission keeps whatever this turn already changed.")),
          metadata: undefined,
        }),
      );
      eventBus.finished();
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
      oauth: {
        scheme: {
          $case: "oauth2SecurityScheme",
          value: {
            description: "Better Auth OAuth 2.1 authorization code + PKCE",
            oauth2MetadataUrl: `${baseUrl}/.well-known/oauth-authorization-server`,
            flows: {
              flow: {
                $case: "authorizationCode",
                value: {
                  authorizationUrl: `${baseUrl}/api/auth/oauth2/authorize`,
                  tokenUrl: `${baseUrl}/api/auth/oauth2/token`,
                  refreshUrl: `${baseUrl}/api/auth/oauth2/token`,
                  scopes: { "circuits:read": "Read missions", "circuits:write": "Propose software changes", "bench:request": "Request bench actions" },
                  pkceRequired: true,
                },
              },
            },
          },
        },
      },
    },
    securityRequirements: [{ schemes: { Bearer: { list: [] } } }, { schemes: { oauth: { list: ["circuits:read"] } } }],
    defaultInputModes: ["text"],
    defaultOutputModes: ["text"],
    skills: [{
      id: "mission-control",
      name: "Mission Control",
      description: "Design, check, and verify Arduino breadboard missions.",
      tags: ["arduino", "breadboard", "mission"],
      examples: ["Build a moon-phase lamp", "Check my wiring"],
      inputModes: ["text"],
      outputModes: ["text"],
      securityRequirements: [{ schemes: { Bearer: { list: [] } } }, { schemes: { oauth: { list: ["circuits:read"] } } }],
    }],
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
function a2aScopeMiddleware(request: Request, response: Response, next: () => void): void {
  const body = request.body && typeof request.body === "object" ? request.body as { method?: unknown; id?: unknown } : {};
  const method = typeof body.method === "string" ? body.method : "";
  const readMethods = new Set(["tasks/get", "GetTask", "tasks/list", "ListTasks", "tasks/pushNotificationConfig/get", "GetTaskPushNotificationConfig", "tasks/pushNotificationConfig/list", "ListTaskPushNotificationConfigs", "agent/getAuthenticatedExtendedCard", "GetExtendedAgentCard", "GetAgentCard"]);
  const required = readMethods.has(method) ? "circuits:read" : "circuits:write";
  if (!requestedScopes(request).includes(required)) {
    response.setHeader("WWW-Authenticate", `Bearer error="insufficient_scope", scope="${required}"`);
    sendJsonRpcError(response, 403, -32003, `insufficient_scope: ${method || "this request"} needs the ${required} scope. Mint a token with ${required} in ViBread Settings → Connect Claude Code.`, requestId(request));
    return;
  }
  next();
}

/** Mount the authenticated A2A JSON-RPC handler and public v1 agent card. */
export function mountA2a(app: Express, ctx: AppContext, auth?: Auth<BetterAuthOptions>): void {
  const card = makeAgentCard(ctx);
  const requestHandler = new DefaultRequestHandler(card, new InMemoryTaskStore(), createA2aExecutor(ctx));
  const bearer = bearerAuth(ctx, Boolean(auth));
  const hybridAuth = auth ? oauthMiddleware(auth, ctx, bearer) : bearer;
  app.use("/.well-known/agent-card.json", agentCardHandler({ agentCardProvider: requestHandler }));
  app.use(
    A2A_PATH,
    express.json({ limit: BODY_LIMIT }),
    hybridAuth,
    a2aScopeMiddleware,
    jsonRpcHandler({ requestHandler, userBuilder: a2aUserBuilder() }),
  );
  app.use(A2A_PATH, jsonRpcErrorHandler(ctx));
}