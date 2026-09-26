// Server entry used by the desktop app (staged as resources/runtime/server-entry.ts, run with the bundled Node + tsx).
// apps/server/src/main.ts only exports startServer (npm start uses apps/server/src/start.ts); this entry calls it and adds
// the desktop protocol (a ready line with the port, shutdown on stdin close).
// The desktop app keeps stdin open; when it closes (app quit or crash) the server shuts down and its exit hooks stop the
// schematic/PNG workers, so no orphan processes outlive the app on any OS.
import type { AddressInfo } from "node:net";
import { startServer } from "./apps/server/src/main.js";

const running = await startServer();
const address = running.server.address() as AddressInfo;
console.log(`VIBREAD_SERVER_READY port=${address.port}`);

let stopping = false;
const shutdown = (reason: string): void => {
  if (stopping) return;
  stopping = true;
  console.log(`VIBREAD_SERVER_STOPPING ${reason}`);
  const force = setTimeout(() => process.exit(0), 5_000);
  force.unref();
  void running.close().finally(() => process.exit(0));
};
process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
process.stdin.on("data", (chunk: Buffer) => {
  if (chunk.toString("utf8").includes("shutdown")) shutdown("requested");
});
process.stdin.once("end", () => shutdown("parent closed stdin"));
process.stdin.resume();
