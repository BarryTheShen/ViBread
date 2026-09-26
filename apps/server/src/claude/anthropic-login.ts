import { Worker } from "node:worker_threads";
import type { OAuthCredential } from "@earendil-works/pi-ai";

/** Where pi-ai's local callback listens for this sign-in; `preferred` is false when localhost:53692 was taken. */
export interface CallbackListener {
  host: string;
  port: number;
  wanted: number;
  preferred: boolean;
}

/** One pi-ai Anthropic sign-in, running in its own worker thread (anthropic-login-worker.mjs). */
export interface AnthropicLogin {
  /** The claude.ai address to open. */
  url: Promise<string>;
  /** pi-ai's local callback listener, once it listens. */
  callback: Promise<CallbackListener>;
  /** The Claude credential, once the paste or the local callback finished the sign-in. */
  credential: Promise<OAuthCredential>;
  /** Hands the pasted code or redirect address to pi-ai. */
  paste(code: string): void;
  /** Ends the sign-in and frees the callback port. */
  cancel(): void;
}

type WorkerMessage =
  | { type: "auth_url"; url: string }
  | ({ type: "callback" } & CallbackListener)
  | { type: "done"; credential: OAuthCredential }
  | { type: "error"; message: string };

const WORKER = new URL("./anthropic-login-worker.mjs", import.meta.url);

/** Test seams: where pi-ai's local callback listens (0 = any free port), and a request URL to send elsewhere. */
export interface AnthropicLoginOptions {
  callbackPort?: number;
  rewrite?: { from: string; to: string };
}

export function startAnthropicLogin(options: AnthropicLoginOptions = {}): AnthropicLogin {
  const worker = new Worker(WORKER, { workerData: options });
  worker.unref(); // a pending sign-in never keeps the process alive
  const url = Promise.withResolvers<string>();
  const callback = Promise.withResolvers<CallbackListener>();
  const credential = Promise.withResolvers<OAuthCredential>();
  const fail = (error: Error) => {
    url.reject(error);
    callback.reject(error);
    credential.reject(error);
    void worker.terminate();
  };
  for (const pending of [url, callback, credential]) pending.promise.catch(() => undefined);
  worker.on("message", (message: WorkerMessage) => {
    if (message.type === "auth_url") url.resolve(message.url);
    else if (message.type === "callback") callback.resolve({ host: message.host, port: message.port, wanted: message.wanted, preferred: message.preferred });
    else if (message.type === "done") {
      credential.resolve(message.credential);
      void worker.terminate();
    } else fail(new Error(message.message));
  });
  worker.once("error", fail);
  worker.once("exit", () => fail(new Error("The sign-in ended.")));
  return {
    url: url.promise,
    callback: callback.promise,
    credential: credential.promise,
    paste: (code) => worker.postMessage({ type: "paste", code }),
    cancel: () => fail(new Error("Sign-in cancelled.")),
  };
}
