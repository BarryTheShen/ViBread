import type { Actor, MissionStore } from "@vibread/core";
import { errorMessage } from "@vibread/tools";
import { pipeUIMessageStreamToResponse, type UIMessage } from "ai";
import type { Express, Request, Response } from "express";
import type { Logger } from "pino";
import type { MessageStore } from "../store/messages.js";
import type { ApprovalLinks } from "./approval-links.js";
import type { RunManager } from "./runs.js";

const OPERATOR: Actor = { kind: "human", id: "operator", name: "Operator", channel: "web" };

function sendError(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: { code, message } });
}

function statusOf(error: unknown): { status: number; code: string } {
  const e = error as { status?: unknown; code?: unknown };
  return {
    status: typeof e?.status === "number" ? e.status : 500,
    code: typeof e?.code === "string" ? e.code : "internal_error",
  };
}

/** Only a new user message with text/file parts is accepted: history (assistant/tool parts, approvals) is server-held. */
function userMessage(body: unknown, actor: Actor): UIMessage | null {
  const message = (body as { message?: unknown } | undefined)?.message as Partial<UIMessage> | undefined;
  if (!message || message.role !== "user" || !Array.isArray(message.parts) || !message.parts.length) return null;
  const parts: UIMessage["parts"] = [];
  for (const part of message.parts) {
    if (part.type === "text" && typeof part.text === "string" && part.text.trim()) parts.push({ type: "text", text: part.text });
    else if (part.type === "file" && typeof part.url === "string" && typeof part.mediaType === "string") {
      parts.push({ type: "file", url: part.url, mediaType: part.mediaType, ...(part.filename ? { filename: part.filename } : {}) });
    } else return null;
  }
  const id = typeof message.id === "string" && /^[\w-]{1,100}$/.test(message.id) ? message.id : crypto.randomUUID();
  return { id, role: "user", parts, metadata: { vibread: { actor } } };
}

/**
 * Chat routes (packages/core api.ts):
 *   GET  /api/missions/:id/chat          → UIMessage[] (server-held history)
 *   POST /api/missions/:id/chat          { message } → AI SDK UI message stream (SSE); the run continues if the client leaves
 *   GET  /api/missions/:id/chat/stream   → replay of the active run (or one that just finished unwatched) from its start, then live; 204 when idle
 *   POST /api/missions/:id/chat/stop     → { ok: true }; aborts the active run
 */
export function mountChat(app: Express, deps: { store: MissionStore; messages: MessageStore; runs: RunManager; links: ApprovalLinks; log: Logger }): void {
  const { store, runs, links, log } = deps;

  async function mission(req: Request, res: Response): Promise<string | null> {
    const id = String(req.params.id);
    const found = await store.getMission(id);
    const user = res.locals.user as { id?: string } | undefined;
    if (!found || (user?.id && found.ownerId !== user.id)) {
      sendError(res, 404, "not_found", "Mission not found.");
      return null;
    }
    return id;
  }

  app.get("/api/missions/:id/chat", async (req, res) => {
    try {
      const id = await mission(req, res);
      if (!id) return;
      res.json(await links.hydrate(id));
    } catch (error) {
      log.error({ err: errorMessage(error) }, "chat history failed");
      sendError(res, 500, "internal_error", "Could not load the chat.");
    }
  });

  app.post("/api/missions/:id/chat", async (req, res) => {
    try {
      const id = await mission(req, res);
      if (!id) return;
      const actor = (res.locals.actor as Actor | undefined) ?? OPERATOR;
      const message = userMessage(req.body, actor);
      if (!message) return sendError(res, 400, "bad_message", 'Send { message: { role: "user", parts: [{ type: "text", text }] } }.');
      const run = await runs.start(id, { message, actor });
      await pipeUIMessageStreamToResponse({ response: res, stream: runs.stream(run) });
    } catch (error) {
      const { status, code } = statusOf(error);
      if (res.headersSent) {
        res.end();
        return;
      }
      if (status >= 500) log.error({ err: errorMessage(error) }, "chat turn failed");
      sendError(res, status, code, status === 500 && code === "internal_error" ? "The agent could not start." : errorMessage(error));
    }
  });

  app.get("/api/missions/:id/chat/stream", async (req, res) => {
    try {
      const id = await mission(req, res);
      if (!id) return;
      const run = runs.replayable(id);
      if (!run) {
        res.status(204).end();
        return;
      }
      await pipeUIMessageStreamToResponse({ response: res, stream: runs.stream(run) });
    } catch (error) {
      if (!res.headersSent) sendError(res, 500, "internal_error", "Could not resume the stream.");
      else res.end();
      log.error({ err: errorMessage(error) }, "chat resume failed");
    }
  });

  app.post("/api/missions/:id/chat/stop", async (req, res) => {
    const id = await mission(req, res);
    if (!id) return;
    runs.stop(id);
    res.json({ ok: true });
  });
}
