import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import pino from "pino";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { toNodeHandler } from "better-auth/node";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { ClientFactory, ClientFactoryOptions, JsonRpcTransportFactory } from "@a2a-js/sdk/client";
import { AgentCard, Role } from "@a2a-js/sdk";
import { createAppContext, type AppContextHandle } from "../context.js";
import { loadConfig } from "../config.js";
import { mountA2a, mountMcp } from "./index.js";

interface RunningOAuthTest {
  server: Server;
  context: AppContextHandle;
}

const running: RunningOAuthTest[] = [];

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url").replace(/=+$/u, "");
  return { verifier, challenge };
}

function cookieValue(response: Response, jar: string): string {
  const setCookie = response.headers.get("set-cookie");
  if (!setCookie) return jar;
  const value = setCookie.split(";")[0];
  const [name] = value.split("=");
  const existing = jar.split("; ").filter((part) => !part.startsWith(`${name}=`));
  return [...existing, value].filter(Boolean).join("; ");
}
async function reservePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  if (!address || typeof address === "string") throw new Error("port reservation failed");
  const port = address.port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

async function startOAuthTest(): Promise<{ baseUrl: string; context: AppContextHandle; operatorPassword: string }> {
  const port = await reservePort();
  const config = loadConfig({
    DATA_DIR: `/tmp/vb-oauth-vitest-${randomBytes(6).toString("hex")}`,
    PORT: String(port),
    HOST: "127.0.0.1",
    PUBLIC_URL: `http://127.0.0.1:${port}`,
    BETTER_AUTH_SECRET: randomBytes(32).toString("base64url"),
    VIBREAD_APPROVAL_SECRET: randomBytes(32).toString("base64url"),
    CAPCOM_PROVIDER: "off",
  });
  const context = createAppContext({ config, log: pino({ level: "silent" }) });
  const authHandler = toNodeHandler(context.auth);
  const app = express();
  app.get("/.well-known/oauth-protected-resource/mcp", (_request, response) => response.json({ resource: `${config.publicUrl}/mcp`, authorization_servers: [`${config.publicUrl}/api/auth`], bearer_methods_supported: ["header"], scopes_supported: ["circuits:read", "circuits:write", "bench:request"] }));
  const authMetadata = async (_request: express.Request, response: express.Response, next: express.NextFunction): Promise<void> => {
    try {
      const result = await context.auth.handler(new globalThis.Request(`${config.publicUrl}/api/auth/.well-known/oauth-authorization-server`, { method: "GET" }));
      result.headers.forEach((value, name) => response.setHeader(name, value));
      response.status(result.status).send(await result.text());
    } catch (error) {
      next(error);
    }
  };
  app.get("/.well-known/oauth-authorization-server/api/auth", authMetadata);
  app.get("/.well-known/openid-configuration/api/auth", authMetadata);
  app.get("/.well-known/oauth-authorization-server", (_request, response) => response.redirect(307, "/api/auth/.well-known/oauth-authorization-server"));
  app.use("/.well-known", (request, response, next) => request.path === "/agent-card.json" ? next() : response.status(404).json({ error: "not_found" }));
  app.all("/api/auth/*splat", (request, response, next) => void authHandler(request, response).catch(next));
  const { ctx, auth } = context;
  const server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  mountMcp(app, ctx, auth);
  mountA2a(app, ctx, auth);
  const handle = { server, context };
  running.push(handle);
  return { baseUrl, context, operatorPassword: `${config.authSecret}:vibread-operator` };
}

afterEach(async () => {
  await Promise.all(running.splice(0).map(async ({ server, context }) => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    context.close();
  }));
});

describe("Better Auth OAuth → MCP", () => {
  it("completes PKCE authorization and calls read-scoped MCP", async () => {
    const { baseUrl, operatorPassword } = await startOAuthTest();
    const clientRedirect = "http://127.0.0.1:39999/callback";
    const registration = await fetch(`${baseUrl}/api/auth/oauth2/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Vitest OAuth client",
        redirect_uris: [clientRedirect],
        grant_types: ["authorization_code"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        scope: "circuits:read",
        application_type: "native",
        resources: [`${baseUrl}/mcp`],
      }),
    });
    expect(registration.status).toBe(201);
    const registered = (await registration.json()) as { client_id: string };
    const { verifier, challenge } = pkce();
    const authorization = new URL(`${baseUrl}/api/auth/oauth2/authorize`);
    authorization.search = new URLSearchParams({
      client_id: registered.client_id,
      redirect_uri: clientRedirect,
      response_type: "code",
      scope: "circuits:read",
      resource: `${baseUrl}/mcp`,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "oauth-test-state",
    }).toString();

    let cookie = "";
    const authorize = await fetch(authorization, { redirect: "manual" });
    const authorizeBody = (await authorize.clone().json().catch(() => ({}))) as { url?: string };
    expect([200, 302]).toContain(authorize.status);
    const loginUrl = new URL(authorize.headers.get("location") ?? authorizeBody.url ?? "", baseUrl);
    const login = await fetch(`${baseUrl}/api/oauth/operator-login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "operator@vibread.local", password: operatorPassword, oauth_query: loginUrl.search.slice(1) }),
      redirect: "manual",
    });
    cookie = cookieValue(login, cookie);
    const loginBody = (await login.json()) as { redirect: string };
    const consentUrl = new URL(loginBody.redirect, baseUrl);
    const consentQuery = consentUrl.searchParams.get("oauth_query") ?? consentUrl.search.slice(1);
    const accepted = await fetch(`${baseUrl}/api/auth/oauth2/consent`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ accept: true, oauth_query: consentQuery }),
      redirect: "manual",
    });
    expect(accepted.status).toBeGreaterThanOrEqual(200);
    expect(accepted.status).toBeLessThan(400);
    const acceptedBody = (await accepted.json()) as { url?: string };
    const callback = new URL(acceptedBody.url ?? accepted.headers.get("location") ?? "");
    expect(callback.searchParams.get("state")).toBe("oauth-test-state");
    expect(callback.searchParams.get("code")).toBeTruthy();

    const token = await fetch(`${baseUrl}/api/auth/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: registered.client_id,
        code: callback.searchParams.get("code") ?? "",
        redirect_uri: clientRedirect,
        code_verifier: verifier,
        resource: `${baseUrl}/mcp`,
      }),
    });
    expect(token.status).toBe(200);
    const tokenBody = (await token.json()) as { access_token: string; scope?: string };
    expect(tokenBody.scope).toContain("circuits:read");
    const resourceMetadata = await (await fetch(`${baseUrl}/.well-known/oauth-protected-resource/mcp`)).json() as { authorization_servers: string[] };
    const pathInserted = ["/.well-known/oauth-authorization-server/api/auth", "/.well-known/openid-configuration/api/auth"];
    for (const path of pathInserted) {
      const metadataResponse = await fetch(`${baseUrl}${path}`);
      expect(metadataResponse.status).toBe(200);
      expect((await metadataResponse.json() as { issuer: string }).issuer).toBe(resourceMetadata.authorization_servers[0]);
    }
    const unknownWellKnown = await fetch(`${baseUrl}/.well-known/not-a-real-document`);
    expect(unknownWellKnown.status).toBe(404);
    expect(unknownWellKnown.headers.get("content-type")).toContain("application/json");
    const unauthorized = await fetch(`${baseUrl}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("www-authenticate")).toContain("resource_metadata");
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), { requestInit: { headers: { authorization: `Bearer ${tokenBody.access_token}` } } });
    const client = new McpClient({ name: "oauth-vitest", version: "1" });
    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toContain("vibread_list_missions");
    expect(tools.tools.map((tool) => tool.name)).not.toContain("vibread_create_mission");
    await client.close();
    const cardResponse = await fetch(`${baseUrl}/.well-known/agent-card.json`);
    expect(cardResponse.status).toBe(200);
    const cardJson = (await cardResponse.json()) as { securitySchemes: { oauth: { scheme: { $case: string } } } };
    expect(cardJson.securitySchemes.oauth.scheme.$case).toBe("oauth2SecurityScheme");
    const unauthorizedA2a = await fetch(`${baseUrl}/a2a`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(unauthorizedA2a.status).toBe(401);
    const card = AgentCard.fromJSON(cardJson);
    const a2aFactory = new ClientFactory(ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
      transports: [new JsonRpcTransportFactory({
        fetchImpl: async (input, init) => {
          const headers = new Headers(init?.headers);
          headers.set("authorization", `Bearer ${tokenBody.access_token}`);
          return fetch(input, { ...init, headers });
        },
      })],
    }));
    const a2a = await a2aFactory.createFromAgentCard(card);
    await expect(a2a.sendMessage({
      tenant: "",
      metadata: {},
      message: {
        messageId: "oauth-a2a",
        role: Role.ROLE_USER,
        parts: [{ content: { $case: "text", value: "hello" }, metadata: {}, filename: "", mediaType: "text/plain" }],
        taskId: "",
        contextId: "",
        extensions: [],
        metadata: {},
        referenceTaskIds: [],
      },
      configuration: undefined,
    })).rejects.toThrow();
  }, 10_000);
});
