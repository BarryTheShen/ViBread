// Runs pi-ai's own Anthropic sign-in (the provider's OAuth login) in a worker thread, one worker per sign-in; see
// anthropic-login.ts for the message protocol. pi-ai listens for the browser's redirect on the fixed localhost:53692.
// This thread's node:http is adjusted before pi-ai loads so that listener can't break the sign-in: when another program
// holds the port, it listens on a free port instead (the redirect can't reach it, so the person pastes the code).
// Test seams in `workerData`: `callbackPort` picks the listener's port outright; `rewrite: {from, to}` sends this
// thread's requests for `from` to `to` (a local stand-in for Anthropic's token endpoint). Only this worker sees either.
import { createRequire, syncBuiltinESMExports } from "node:module";
import { createServer as createProbe } from "node:net";
import { parentPort, workerData } from "node:worker_threads";

const port = parentPort;
const http = createRequire(import.meta.url)("node:http");
const createServer = http.createServer;

/** Whether `host:wanted` can be bound right now. */
function isFree(wanted, host) {
  const { promise, resolve } = Promise.withResolvers();
  const probe = createProbe();
  probe.once("error", () => resolve(false));
  probe.listen(wanted, host, () => probe.close(() => resolve(true)));
  return promise;
}

http.createServer = (...args) => {
  const server = createServer(...args);
  const listen = server.listen.bind(server);
  server.listen = (wanted, host, onListening) => {
    const forced = workerData?.callbackPort;
    void (forced === undefined ? isFree(wanted, host) : Promise.resolve(false)).then((free) => {
      listen(free ? wanted : (forced ?? 0), host, () => {
        const address = server.address();
        port.postMessage({ type: "callback", host, port: typeof address === "object" && address ? address.port : wanted, wanted, preferred: free });
        onListening?.();
      });
    });
    return server;
  };
  return server;
};
syncBuiltinESMExports();

const rewrite = workerData?.rewrite;
if (rewrite) {
  const fetch = globalThis.fetch;
  globalThis.fetch = (input, init) => fetch(String(input) === rewrite.from ? rewrite.to : input, init);
}

const { anthropicProvider } = await import("@earendil-works/pi-ai/providers/anthropic");

// pi-ai asks for the pasted code once, racing it against its local callback.
const paste = Promise.withResolvers();
paste.promise.catch(() => undefined);
port.on("message", (message) => {
  if (message?.type === "paste") paste.resolve(message.code);
});

const interaction = {
  signal: new AbortController().signal,
  notify(event) {
    if (event.type === "auth_url") port.postMessage({ type: "auth_url", url: event.url });
  },
  prompt(prompt) {
    if (prompt.type !== "manual_code") return Promise.reject(new Error(`Unexpected sign-in question: ${prompt.message}`));
    prompt.signal?.addEventListener("abort", () => paste.reject(new Error("The local callback finished the sign-in.")), { once: true });
    return paste.promise;
  },
};

try {
  const credential = await anthropicProvider().auth.oauth.login(interaction);
  port.postMessage({ type: "done", credential });
} catch (error) {
  port.postMessage({ type: "error", message: error instanceof Error ? error.message : String(error) });
}
