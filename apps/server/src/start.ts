/**
 * `npm start` / `npm run dev` entry: always starts the server. main.ts only exports startServer, so importing it (tests,
 * the desktop app's own entry) never starts one — no argv/import.meta path comparison, which broke on some Windows paths.
 */
import { loadConfig } from "./config.js";
import { startServer } from "./main.js";

const running = await startServer(loadConfig());
const fatal = (error: unknown, message: string): void => {
  // Fatal errors go to stderr as well as the debug log, so a crash is never silent.
  console.error(`ViBread server stopped (${message}):`, error);
  running.context.ctx.debug.event(null, "error", message, { error: error instanceof Error ? (error.stack ?? error.message) : String(error) }, "error");
  void running.close().finally(() => process.exit(1));
};
process.once("unhandledRejection", (error) => fatal(error, "unhandledRejection"));
process.once("uncaughtException", (error) => fatal(error, "uncaughtException"));
const shutdown = (): void => {
  void running.close().finally(() => process.exit(0));
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
