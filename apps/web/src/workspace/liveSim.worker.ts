/// <reference lib="webworker" />

import { createLiveSimHost } from "./liveSimHost.js";
import type { LiveSimInput, LiveSimOutput } from "./liveSimProtocol.js";

const host = createLiveSimHost((message: LiveSimOutput) => self.postMessage(message), {
  now: () => performance.now(),
  every: (ms, tick) => {
    const timer = self.setInterval(tick, ms);
    return () => self.clearInterval(timer);
  },
});

self.onmessage = (event: MessageEvent<LiveSimInput>) => host.handle(event.data);

// Anything that still escapes reaches the page as a normal error message with its stack: the page's `worker.onerror`
// only gets the text, and none at all when the error is cross-origin or the script failed to load.
self.addEventListener("error", (event) => {
  event.preventDefault();
  host.fail(event.error ?? event.message);
});
self.addEventListener("unhandledrejection", (event) => {
  event.preventDefault();
  host.fail(event.reason);
});
