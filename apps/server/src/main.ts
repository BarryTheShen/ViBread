import { existsSync } from "node:fs";
import { resolve } from "node:path";
import http from "node:http";
import express, { type ErrorRequestHandler, type Express } from "express";
import rateLimit from "express-rate-limit";
import pino from "pino";
import pinoHttp from "pino-http";
import { toNodeHandler } from "better-auth/node";
import { mountA2a, mountMcp } from "./interop/index.js";
import { startCapcom } from "./capcom/index.js";
import { createAppContext, type AppContextHandle } from "./context.js";
import { getSessionUser } from "./auth.js";
import { loadConfig, type ServerConfig } from "./config.js";
import { mountApi } from "./routes.js";

export interface RunningServer {
  app: Express;
  server: http.Server;
  context: AppContextHandle;
  close(): Promise<void>;
}

export async function startServer(config: ServerConfig = loadConfig()): Promise<RunningServer> {
  const log = pino({ level: process.env.LOG_LEVEL ?? "info" });
  const context = createAppContext({ config, log });
  const { ctx, auth } = context;
  const app = express();
  app.disable("x-powered-by");
  app.use(pinoHttp({
    logger: log,
    redact: {
      paths: ["req.headers.authorization", "req.headers.cookie", "res.headers[\"set-cookie\"]"],
      censor: "[REDACTED]",
    },
  }));

  const authLimiter = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: "draft-8", legacyHeaders: false });
  const tokenLimiter = rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: "draft-8", legacyHeaders: false });
  app.use("/api/auth", authLimiter);
  app.use("/api/connections/tokens", tokenLimiter);
  const authHandler = toNodeHandler(auth);
  // Better Auth must see the raw request stream before express.json consumes it.
  app.get("/.well-known/oauth-protected-resource/mcp", (_req, res) => {
    res.json({
      resource: `${config.publicUrl}/mcp`,
      authorization_servers: [config.publicUrl],
      bearer_methods_supported: ["header"],
      scopes_supported: ["circuits:read", "circuits:write", "bench:request"],
    });
  });
  app.get("/.well-known/oauth-authorization-server", (_req, res) => res.redirect(307, "/api/auth/.well-known/oauth-authorization-server"));
  app.get("/jwks", (_req, res) => res.redirect(307, "/api/auth/jwks"));
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

  mountApi(app, ctx);
  ctx.runtime.mountChat(app);
  mountMcp(app, ctx, auth);
  mountA2a(app, ctx, auth);

  const candidateWebDirs = [resolve(process.cwd(), "apps/web/dist"), resolve(process.cwd(), "../../apps/web/dist")];
  const webDist = candidateWebDirs.find((directory) => existsSync(resolve(directory, "index.html")));
  const indexPath = webDist ? resolve(webDist, "index.html") : undefined;
  if (process.env.VIBREAD_NO_STATIC !== "1" && indexPath && webDist) {
    app.use(express.static(webDist, { index: false }));
    app.get("*splat", (_req, res) => res.sendFile(indexPath));
  }

  const apiErrorHandler: ErrorRequestHandler = (error, _req, res, next) => {
    if (res.headersSent) return next(error);
    const status = typeof error?.status === "number" ? error.status : 500;
    const code = typeof error?.code === "string" ? error.code : "INTERNAL_ERROR";
    const message = status >= 500 && code === "INTERNAL_ERROR" ? "internal server error" : error instanceof Error ? error.message : "request failed";
    if (status >= 500) log.error({ err: error }, "request failed");
    res.status(status).json({ error: { code, message } });
  };
  app.use(apiErrorHandler);

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

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfig();
  const running = await startServer(config);
  const shutdown = (): void => {
    void running.close().finally(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
