import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import http from "node:http";
import express, { type ErrorRequestHandler, type Express, type NextFunction, type Request, type RequestHandler, type Response } from "express";
import rateLimit from "express-rate-limit";
import pino from "pino";
import type { Logger } from "pino";
import pinoHttp from "pino-http";
import { toNodeHandler } from "better-auth/node";
import { mountA2a, mountMcp } from "./interop/index.js";
import { startCapcom } from "./capcom/index.js";
import { createAppContext, type AppContextHandle } from "./context.js";
import { getSessionUser } from "./auth.js";
import { loadConfig, type ServerConfig } from "./config.js";
import { mountApi, approvalOwnerMiddleware, missionOwnerMiddleware } from "./routes.js";
import type { DebugLog } from "./services/debug-log.js";
export interface RunningServer {
  app: Express;
  server: http.Server;
  context: AppContextHandle;
  close(): Promise<void>;
}

export function createApiErrorHandler(log: Logger, debug?: DebugLog): ErrorRequestHandler {
  return (error, req, res, next) => {
    if (res.headersSent) return next(error);
    const deliberate = typeof error?.status === "number" && typeof error?.code === "string";
    const status = deliberate ? error.status : 500;
    const code = deliberate ? error.code : "INTERNAL_ERROR";
    const message = deliberate && error instanceof Error ? error.message : "internal server error";
    if (!deliberate || status >= 500) log.error({ err: error }, "request failed");
    if (debug) {
      const mission = /^\/api\/missions\/([^/]+)/.exec(req.path)?.[1] ?? null;
      debug.event(mission, status >= 500 ? "error" : "http", `${req.method} ${req.path} failed`, { status, code, durationMs: Date.now() - Number(res.locals.debugStartedAt ?? Date.now()) }, status >= 500 ? "error" : "warn");
    }
    res.status(status).json({ error: { code, message } });
  };
}

export function createHostOriginGuard(config: ServerConfig, env: NodeJS.ProcessEnv = process.env): RequestHandler {
  const allowedHosts = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
  for (const origin of [config.publicUrl, config.phoneUrl, ...(env.VIBREAD_ALLOWED_HOSTS?.split(",") ?? [])]) {
    const host = hostName(origin);
    if (host) allowedHosts.add(host);
  }
  return (req: Request, res: Response, next: NextFunction): void => {
    const host = hostName(req.headers.host);
    if (!host || !allowedHosts.has(host)) {
      res.status(421).json({ error: { code: "host_not_allowed", message: "This Host is not a ViBread origin." } });
      return;
    }
    if (req.path.startsWith("/api/") && ["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) {
      if (req.headers["sec-fetch-site"] === "cross-site") {
        res.status(403).json({ error: { code: "origin_not_allowed", message: "Cross-site requests are not allowed." } });
        return;
      }
      const origin = req.headers.origin;
      if (origin && !allowedHosts.has(hostName(origin))) {
        res.status(403).json({ error: { code: "origin_not_allowed", message: "This Origin is not a ViBread origin." } });
        return;
      }
    }
    next();
  };
}

function hostName(value: string | undefined): string {
  if (!value) return "";
  try {
    const parsed = new URL(value.includes("://") ? value : `http://${value}`);
    return parsed.hostname.toLowerCase();
  } catch {
    return "";
  }
}

export async function startServer(config: ServerConfig = loadConfig()): Promise<RunningServer> {
  const log = pino({ level: process.env.LOG_LEVEL ?? "info" });
  const context = createAppContext({ config, log });
  const { ctx, auth } = context;
  const app = express();
  app.disable("x-powered-by");
  app.use(createHostOriginGuard(config));
  app.use(ctx.lanGuard.middleware());
  if (ctx.lanGuard.active) log.info(`Phones and other computers: open ${config.phoneUrl}/?pair=${ctx.lanGuard.pairToken()}`);
  app.use(pinoHttp({
    logger: log,
    redact: {
      paths: ["req.headers.authorization", "req.headers.cookie", "res.headers[\"set-cookie\"]"],
      censor: "[REDACTED]",
    },
  }));
  app.use((req, res, next) => {
    res.locals.debugStartedAt = Date.now();
    next();
  });
  const authLimiter = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: "draft-8", legacyHeaders: false });
  const tokenLimiter = rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: "draft-8", legacyHeaders: false });
  const clientErrorLimiter = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: "draft-8", legacyHeaders: false });
  app.use("/api/auth", authLimiter);
  app.use("/api/connections/tokens", tokenLimiter);
  app.use("/api/debug/client-errors", clientErrorLimiter);
  const authHandler = toNodeHandler(auth);
  // Better Auth must see the raw request stream before express.json consumes it.
  app.get("/.well-known/oauth-protected-resource/mcp", (_req, res) => {
    res.json({
      resource: `${config.publicUrl}/mcp`,
      authorization_servers: [`${config.publicUrl}/api/auth`],
      bearer_methods_supported: ["header"],
      scopes_supported: ["circuits:read", "circuits:write", "bench:request"],
    });
  });
  const authMetadata = async (_req: express.Request, res: express.Response, next: express.NextFunction): Promise<void> => {
    try {
      const result = await auth.handler(new globalThis.Request(`${config.publicUrl}/api/auth/.well-known/oauth-authorization-server`, { method: "GET" }));
      result.headers.forEach((value, name) => res.setHeader(name, value));
      res.status(result.status).send(await result.text());
    } catch (error) {
      next(error);
    }
  };
  app.get("/.well-known/oauth-authorization-server", authMetadata);
  app.get("/.well-known/oauth-authorization-server/api/auth", authMetadata);
  app.get("/.well-known/openid-configuration/api/auth", authMetadata);
  app.use("/.well-known", (request, response, next) => request.path === "/agent-card.json" ? next() : response.status(404).json({ error: "not_found" }));
  const authAtRoot = (req: http.IncomingMessage, res: http.ServerResponse, next: (error?: unknown) => void): void => {
    const originalUrl = req.url ?? "/";
    req.url = `/api/auth${originalUrl}`;
    void authHandler(req, res).catch(next).finally(() => {
      req.url = originalUrl;
    });
  };
  app.use("/.well-known/oauth-protected-resource", authAtRoot);
  app.use("/.well-known/oauth-authorization-server", authAtRoot);
  app.use("/jwks", authAtRoot);
  app.all("/api/auth/*splat", (req, res, next) => {
    void authHandler(req, res).catch(next);
  });
  app.use(express.json({ limit: "2mb" }));
  app.use(async (req, res, next) => {
    try {
      const user = config.singleOperator ? await ctx.operator() : await getSessionUser(auth, req.headers);
      if (user) {
        res.locals.user = user;
        res.locals.actor = { kind: "human", id: user.id, name: user.name, channel: "web" };
      }
      next();
    } catch (error) {
      next(error);
    }
  });

  app.use("/api/missions/:id", missionOwnerMiddleware(ctx));
  app.use("/api/approvals/:approvalId", approvalOwnerMiddleware(ctx));
  mountApi(app, ctx);
  ctx.runtime.mountChat(app);
  mountMcp(app, ctx, auth);
  mountA2a(app, ctx, auth);

  const candidateWebDirs = [resolve(process.cwd(), "apps/web/dist"), resolve(process.cwd(), "../../apps/web/dist")];
  const webDist = candidateWebDirs.find((directory) => existsSync(resolve(directory, "index.html")));
  if (process.env.VIBREAD_NO_STATIC !== "1" && webDist) {
    app.use(express.static(webDist, { index: false }));
    // Root-relative on purpose: `send` rejects absolute paths that pass through a dot-directory (AppImages run from
    // /tmp/.mount_*, many installs live under ~/.local), which would turn every SPA route into a 404.
    app.get("*splat", (_req, res) => res.sendFile("index.html", { root: webDist }));
  }

  app.use(createApiErrorHandler(log, ctx.debug));

  const capcom = await startCapcom(ctx);
  const server = await new Promise<http.Server>((resolveServer, reject) => {
    const listener = app.listen(config.port, config.host, () => resolveServer(listener));
    listener.once("error", reject);
  });
  let closing: Promise<void> | undefined;
  const close = async (): Promise<void> => {
    if (closing) return closing;
    closing = (async () => {
      await capcom.stop();
      await new Promise<void>((resolveClose, rejectClose) => server.close((error) => (error ? rejectClose(error) : resolveClose())));
      context.close();
    })();
    return closing;
  };
  return { app, server, context, close };
}

// Run directly (`tsx src/main.ts`); compared as URLs so Windows paths and paths with spaces match too.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const config = loadConfig();
  const running = await startServer(config);
  const fatal = (error: unknown, message: string): void => {
    running.context.ctx.debug.event(null, "error", message, { error: error instanceof Error ? error.stack ?? error.message : String(error) }, "error");
    void running.close().finally(() => process.exit(1));
  };
  process.once("unhandledRejection", (error) => fatal(error, "unhandledRejection"));
  process.once("uncaughtException", (error) => fatal(error, "uncaughtException"));
  const shutdown = (): void => {
    void running.close().finally(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
