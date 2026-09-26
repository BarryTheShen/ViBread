import type { Actor, MissionStore } from "@vibread/core";
import { errorMessage } from "@vibread/tools";
import { pipeUIMessageStreamToResponse, type UIMessage } from "ai";
import type { Express, Request, Response } from "express";
import type { Logger } from "pino";
import type { MessageStore } from "../store/messages.js";
import type { ApprovalLinks } from "./approval-links.js";
import { mountRecorded } from "./recorded.js";
import type { RunManager } from "./runs.js";

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
  mountRecorded(app); // GET /api/recorded/:file — the recorded photo-check example picture

  /**
   * Every chat route requires a signed-in user who owns the mission (audit F3): a chat turn spends the owner's Claude
   * credential. `res.locals.user` is set by the server's session middleware (the operator in single-operator mode).
   * Not signed in → 401; missing or someone else's mission → 404 (never reveal that it exists).
   */
  async function owned(req: Request, res: Response): Promise<{ id: string; actor: Actor } | null> {
    const user = res.locals.user as { id?: unknown; name?: unknown } | undefined;
    if (typeof user?.id !== "string" || !user.id) {
      sendError(res, 401, "UNAUTHORIZED", "Sign in to use the chat.");
      return null;
    }
    const id = String(req.params.id);
    const found = await store.getMission(id);
    if (!found || found.ownerId !== user.id) {
      sendError(res, 404, "MISSION_NOT_FOUND", "Mission not found.");
      return null;
    }
    const actor = (res.locals.actor as Actor | undefined) ?? { kind: "human", id: user.id, ...(typeof user.name === "string" ? { name: user.name } : {}), channel: "web" };
    return { id, actor };
  }

  app.get("/api/missions/:id/chat", async (req, res) => {
    try {
      const owner = await owned(req, res);
      if (!owner) return;
      res.json(await links.hydrate(owner.id));
    } catch (error) {
      log.error({ err: errorMessage(error) }, "chat history failed");
      sendError(res, 500, "internal_error", "Could not load the chat.");
    }
  });

  app.post("/api/missions/:id/chat", async (req, res) => {
    try {
      const owner = await owned(req, res);
      if (!owner) return;
      const message = userMessage(req.body, owner.actor);
      if (!message) return sendError(res, 400, "bad_message", 'Send { message: { role: "user", parts: [{ type: "text", text }] } }.');
      const run = await runs.start(owner.id, { message, actor: owner.actor });
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
      const owner = await owned(req, res);
      if (!owner) return;
      const run = runs.replayable(owner.id);
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
    try {
      const owner = await owned(req, res);
      if (!owner) return;
      runs.stop(owner.id);
      res.json({ ok: true });
    } catch (error) {
      log.error({ err: errorMessage(error) }, "chat stop failed");
      if (!res.headersSent) sendError(res, 500, "internal_error", "Could not stop the agent.");
    }
  });
}
