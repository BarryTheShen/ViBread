import express from "express";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ClientFactory, ClientFactoryOptions, JsonRpcTransportFactory } from "@a2a-js/sdk/client";
import { AgentCard, Role, TaskState, type Task } from "@a2a-js/sdk";
import { BUILT_IN_PART_TYPES } from "@vibread/core";
import { mountA2a, mountMcp } from "./index.js";

interface TestServer {
  server: Server;
  baseUrl: string;
}

const servers: TestServer[] = [];
const expiry = new Date(Date.now() + 60_000).toISOString();

function asTask(value: unknown): Task {
  if (!value || typeof value !== "object" || !("status" in value) || !("id" in value) || !("contextId" in value)) throw new Error("A2A response was not a task");
  return value as Task;
}

function testContext() {
  let sayCount = 0;
  const missions = {
    async detail(id: string) {
      return {
        mission: { id, title: "Test mission", brief: "test", ownerId: "u1", phase: "DESIGN", inventory: [], createdAt: "", updatedAt: "" },
        consoles: [],
        pendingApprovals: [],
        agentBusy: false,
      };
    },
    async list() {
      return [{ id: "m1", title: "Test mission", brief: "test", phase: "DESIGN", updatedAt: "" }];
    },
    async create() {
      return { id: "m1", title: "Test mission", brief: "test", ownerId: "u1", phase: "BRIEF", inventory: [], createdAt: "", updatedAt: "" };
    },
    async say(_missionId: string, answer: string) {
      sayCount += 1;
      return sayCount === 1
        ? { text: "Need one detail", question: "Which LED?", pendingApprovals: [] }
        : { text: `Completed ${answer}`, revision: 1, pendingApprovals: [] };
    },
    subscribe() {
      return () => undefined;
    },
  };
  return {
    config: { publicUrl: "http://127.0.0.1", capcom: { provider: "off" } },
    tokens: {
      async verify(token: string) {
        if (token === "read") return { id: "tok-read", userId: "u1", scopes: ["circuits:read"], expiresAt: expiry };
        if (token === "write") return { id: "tok-write", userId: "u1", scopes: ["circuits:write"], expiresAt: expiry };
        if (token === "other") return { id: "tok-other", userId: "u2", scopes: ["circuits:read"], expiresAt: expiry };
        return null;
      },
    },
    tools: {
      list() {
        return [
          {
            name: "echo_read",
            title: "Echo read",
            description: "A deterministic read-only test tool.",
            actionClass: "read-only",
            input: z.object({ value: z.string() }),
            async handler(_toolContext: unknown, input: { value: string }) {
              return { echoed: input.value };
            },
          },
          {
            name: "write_only",
            title: "Write only",
            description: "A deterministic write test tool.",
            actionClass: "state-changing",
            input: z.object({ value: z.string() }),
            async handler(_toolContext: unknown, input: { value: string }) {
              return { wrote: input.value };
            },
          },
        ];
      },
      get(name: string) {
        return this.list().find((tool) => tool.name === name);
      },
    },
    store: {
      async getMission(id: string) {
        return { id, title: "Test mission", brief: "test", ownerId: "u1", phase: "DESIGN", inventory: [], createdAt: "", updatedAt: "" };
      },
      async getRevision() {
        return null;
      },
    },
    missions,
    // Only read-only tools are called here; they never reach the bench-request broker.
    broker: {},
    inventory: {
      async entries(ownerId: string) {
        const at = "2026-09-26T00:00:00.000Z";
        if (ownerId === "u1") return [{ id: "e1", typeId: "led", values: { color: "red" }, quantity: 3, status: "ready", source: "typed", createdAt: at, updatedAt: at }];
        if (ownerId === "u2") return [{ id: "e2", typeId: "servo", values: {}, quantity: 1, status: "ready", source: "typed", note: "u2-private", createdAt: at, updatedAt: at }];
        return [];
      },
      async types() {
        return BUILT_IN_PART_TYPES;
      },
    },
  };
}

async function openServer(say?: (missionId: string, text: string) => Promise<unknown>): Promise<TestServer> {
  const app = express();
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const context = testContext();
  context.config.publicUrl = baseUrl;
  if (say) Object.assign(context.missions, { say });
  mountMcp(app, context as never);
  mountA2a(app, context as never);
  const opened = { server, baseUrl };
  servers.push(opened);
  return opened;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(({ server }) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("MCP and A2A mounts", () => {
  it("requires MCP bearer auth, filters tools by scope, and calls a read tool", async () => {
    const { baseUrl } = await openServer();
    const unauthorized = await fetch(`${baseUrl}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(unauthorized.status).toBe(401);

    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), { requestInit: { headers: { authorization: "Bearer read" } } });
    const client = new McpClient({ name: "vitest", version: "1" });
    await client.connect(transport);
    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual(["echo_read", "vibread_list_missions", "vibread_status", "vibread_get_inventory"]);
    const echo = await client.callTool({ name: "echo_read", arguments: { missionId: "m1", value: "ok" } });
    expect(echo.isError).not.toBe(true);
    expect(echo.content).toEqual([{ type: "text", text: '{"echoed":"ok"}' }]);
    await client.close();
    const writeTransport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), { requestInit: { headers: { authorization: "Bearer write" } } });
    const writeClient = new McpClient({ name: "vitest-write", version: "1" });
    await writeClient.connect(writeTransport);
    const writeTools = await writeClient.listTools();
    expect(writeTools.tools.map((tool) => tool.name)).toEqual(["write_only", "vibread_create_mission", "vibread_say", "vibread_continue_task"]);
    await writeClient.close();
  });

  it("a read-scoped token lists and calls vibread_get_inventory, and sees only its own user's parts", async () => {
    const { baseUrl } = await openServer();
    const call = async (token: string) => {
      const client = new McpClient({ name: `inventory-${token}`, version: "1" });
      await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      const result = names.includes("vibread_get_inventory") ? await client.callTool({ name: "vibread_get_inventory", arguments: {} }) : undefined;
      await client.close();
      return { names, result };
    };
    const u1 = await call("read");
    expect(u1.result?.isError).not.toBe(true);
    const u1Text = (u1.result?.content as { text: string }[])[0]!.text;
    const u1Inventory = JSON.parse(u1Text) as { groups: { typeId: string; total: number; support: string }[] };
    expect(u1Inventory.groups.map((g) => [g.typeId, g.total, g.support])).toEqual([["led", 3, "full"]]);
    expect(u1Text).not.toContain("u2-private");
    expect(u1Text).not.toContain("servo");

    const u2 = await call("other");
    expect(JSON.parse((u2.result?.content as { text: string }[])[0]!.text).groups.map((g: { typeId: string }) => g.typeId)).toEqual(["servo"]);
    // Write-only tokens don't get the read tool.
    expect((await call("write")).names).not.toContain("vibread_get_inventory");
  });

  it("does not let another bearer user reuse an MCP session", async () => {
    const { baseUrl } = await openServer();
    const firstTransport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), { requestInit: { headers: { authorization: "Bearer read" } } });
    const first = new McpClient({ name: "owner", version: "1" });
    await first.connect(firstTransport);
    const sessionId = firstTransport.sessionId;
    expect(sessionId).toBeTruthy();
    const sessionResponse = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { authorization: "Bearer other", "content-type": "application/json", "mcp-session-id": sessionId ?? "" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping", params: {} }),
    });
    expect(sessionResponse.status).toBe(404);
    await first.close();
  });

  it("serves a bearer card and completes an A2A ask-back continuation with an artifact", async () => {
    const { baseUrl } = await openServer();
    const cardResponse = await fetch(`${baseUrl}/.well-known/agent-card.json`);
    expect(cardResponse.status).toBe(200);
    const cardJson = (await cardResponse.json()) as {
      securitySchemes: { Bearer: { scheme: { $case: string; value: { scheme: string } } } };
    };
    expect(cardJson.securitySchemes.Bearer.scheme.$case).toBe("httpAuthSecurityScheme");
    expect(cardJson.securitySchemes.Bearer.scheme.value.scheme).toBe("bearer");
    const readRejected = await fetch(`${baseUrl}/a2a`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer read" }, body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "message/send", params: {} }) });
    expect(readRejected.status).toBe(403);
    expect(await readRejected.json()).toMatchObject({ jsonrpc: "2.0", id: 7, error: { code: -32003 } });
    for (const method of ["SendStreamingMessage", "message/stream", "tasks/pushNotificationConfig/set", "SetTaskPushNotificationConfig", "made-up-method"]) {
      const rejected = await fetch(`${baseUrl}/a2a`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer read" }, body: JSON.stringify({ jsonrpc: "2.0", id: 8, method, params: {} }) });
      expect(rejected.status).toBe(403);
    }
    const taskQuery = await fetch(`${baseUrl}/a2a`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer read" }, body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tasks/get", params: { id: "missing" } }) });
    expect(taskQuery.status).not.toBe(403);
    const card = AgentCard.fromJSON(cardJson);
    const factory = new ClientFactory(ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
      transports: [new JsonRpcTransportFactory({
        fetchImpl: async (input, init) => {
          const headers = new Headers(init?.headers);
          headers.set("authorization", "Bearer write");
          return fetch(input, { ...init, headers });
        },
      })],
    }));
    const client = await factory.createFromAgentCard(card);
    const message = {
      tenant: "",
      metadata: {},
      message: {
        messageId: "m1",
        role: Role.ROLE_USER,
        parts: [{ content: { $case: "text" as const, value: "start" }, metadata: {}, filename: "", mediaType: "text/plain" }],
        taskId: "",
        contextId: "",
        extensions: [],
        metadata: {},
        referenceTaskIds: [],
      },
      configuration: undefined,
    };
    const first = asTask(await client.sendMessage(message));
    expect(first.status?.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);
    const continuation = {
      ...message,
      message: {
        ...message.message,
        messageId: "m2",
        taskId: first.id,
        contextId: first.contextId,
        parts: [{ content: { $case: "text" as const, value: "red" }, metadata: {}, filename: "", mediaType: "text/plain" }],
      },
    };
    const second = asTask(await client.sendMessage(continuation));
    expect(second.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(second.artifacts[0]?.parts[0]?.content).toEqual({ $case: "text", value: expect.stringContaining("Revision summary") });
  });

  it("shows a running A2A task and keeps it canceled after ViBread's turn ends", async () => {
    let started!: () => void;
    let finish!: () => void;
    const turnStarted = new Promise<void>((resolve) => (started = resolve));
    const turnDone = new Promise<void>((resolve) => (finish = resolve));
    const { baseUrl } = await openServer(async () => {
      started();
      await turnDone;
      return { text: "Designed it", revision: 1, pendingApprovals: [] };
    });
    const rpc = async (token: string, method: string, params: unknown) => {
      const response = await fetch(`${baseUrl}/a2a`, { method: "POST", headers: { "content-type": "application/json", "a2a-version": "1.0", authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
      return (await response.json()) as { result?: { id?: string; contextId?: string; status?: { state?: string }; tasks?: { id: string; contextId: string; status: { state: string } }[] }; error?: unknown };
    };
    const sent = rpc("write", "SendMessage", { message: { messageId: "m-cancel", role: "ROLE_USER", parts: [{ text: "Build a moon-phase lamp" }] } });
    await turnStarted;
    const listed = await rpc("read", "ListTasks", {});
    const running = listed.result?.tasks?.[0];
    expect(running?.status.state).toBe("TASK_STATE_WORKING");
    const canceled = await rpc("write", "CancelTask", { id: running!.id });
    expect(canceled.result).toMatchObject({ id: running!.id, contextId: running!.contextId, status: { state: "TASK_STATE_CANCELED" } });
    finish();
    await sent;
    const after = await rpc("read", "GetTask", { id: running!.id });
    expect(after.result?.status?.state).toBe("TASK_STATE_CANCELED");
  });
});
