import type { StreamFn } from "@earendil-works/pi-agent-core";
import { InMemoryCredentialStore, createAssistantMessageEventStream, hasApi, type AnthropicOptions, type Api, type AssistantMessage, type Context, type CredentialStore, type Model, type Models, type Usage } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { ClaudeNotConnectedError, errorMessage } from "@vibread/tools";
import type { Logger } from "pino";
import { CLAUDE_PROVIDER, claudeModels, type ClaudeAccountService } from "../claude/accounts.js";
import type { ServerConfig } from "../config.js";

/** Which credential pays for an agent call (shown on the timeline when it is the user's own account). */
export type ModelCredential = { kind: "claude-account"; email?: string } | { kind: "server-key" };

/** Options a single-shot call may set (Anthropic Messages): forced tool, thinking off, effort, output cap, cancellation. */
export type ClaudeCallOptions = Pick<AnthropicOptions, "toolChoice" | "thinkingEnabled" | "effort" | "maxTokens" | "signal">;

/**
 * A Claude model on pi-ai, bound to the credential that pays for it: `streamFn` drives the design agent (pi's Agent),
 * `complete` makes one request (test author, RETRO, photo check, scan).
 */
export interface ClaudeModel {
  model: Model<Api>;
  modelId: string;
  credential: ModelCredential;
  streamFn: StreamFn;
  complete(context: Context, options?: ClaudeCallOptions): Promise<AssistantMessage>;
}

/** What a model call is for, so the debug log can attribute it (trace.ts). */
export interface ModelTrace {
  missionId: string | null;
  purpose: "design" | "test-author" | "retro" | "photo-check" | "scan";
}

/**
 * Model access for the agent roles, resolved per call for the mission owner (users connect/disconnect at runtime).
 * `design` = design agent (config.model); `fast` = test author, RETRO, photo check, scan (config.fastModel).
 * Both reject with ClaudeNotConnectedError when no credential can serve the owner — never a fake answer.
 *
 * This file is the only place that picks a credential for a model call.
 */
export interface AgentModels {
  design(ownerId: string, trace: ModelTrace): Promise<ClaudeModel>;
  fast(ownerId: string, trace: ModelTrace): Promise<ClaudeModel>;
}

/** pi-ai's Claude catalog: context window, output cap, vision, and prompt-cache facts per model id. */
const CLAUDE_CATALOG = anthropicProvider().getModels();
/** For a model id pi's catalog doesn't know yet (VIBREAD_MODEL): Anthropic's current Claude limits. */
const CLAUDE_DEFAULTS: Omit<Model<"anthropic-messages">, "id" | "name" | "baseUrl"> = {
  api: "anthropic-messages",
  provider: CLAUDE_PROVIDER,
  reasoning: true,
  input: ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 32_000,
};

/** Rate limits, overloads and dropped connections are retried as Claude asks (retry-after), up to this wait per retry. */
const RETRY = { maxRetries: 2, maxRetryDelayMs: 30_000 } as const;

/**
 * The same model without pi-ai's managed request protocol (for claude-opus-5-5: adaptive thinking, mid-conversation
 * system messages carrying output_config, native tool changes with a deferred placeholder tool, server-side fallbacks, and
 * their beta headers): one leading system prompt and a plain tool list. Used by the 400 fallback and
 * VIBREAD_CLAUDE_PROTOCOL=plain.
 */
export function plainModel(model: Model<Api>): Model<Api> {
  if (!hasApi(model, "anthropic-messages")) return model;
  const { supportsMidConvoEffort: _effort, supportsMidConvoSystemMessages: _system, supportsMidConvoToolChanges: _tools, allowedFallbackModels: _fallbacks, ...compat } = model.compat ?? {};
  return { ...model, compat };
}

/** Whether requests for this model use any of pi-ai's managed protocol features. */
export function usesManagedProtocol(model: Model<Api>): boolean {
  if (!hasApi(model, "anthropic-messages")) return false;
  const compat = model.compat ?? {};
  return compat.supportsMidConvoEffort === true || compat.supportsMidConvoSystemMessages === true || compat.supportsMidConvoToolChanges === true || (compat.allowedFallbackModels?.length ?? 0) > 0;
}

/**
 * A 400 that rejects one of the managed protocol's features (an unknown beta header, a system-role message, output_config,
 * thinking controls, deferred or added/removed tools). Retrying without them is safe: they only shape caching and effort.
 */
export function rejectsManagedProtocol(errorMessage: string | undefined): boolean {
  if (!errorMessage || !/^\s*400\b/.test(errorMessage)) return false;
  return /anthropic-beta|\bbetas?\b|output_config|role|system|block_binding|thinking|defer_loading|tool_addition|tool_removal|tool.?changes|fallbacks/i.test(errorMessage);
}

interface ProtocolState {
  /** Model ids (per base URL) the API refused the managed protocol for; they go plain from then on. */
  plain: Set<string>;
  onFallback?(modelId: string, error: string): void;
}

function bind(models: Models, model: Model<Api>, credential: ModelCredential, transport: { fetch?: typeof globalThis.fetch }, protocol: ProtocolState): ClaudeModel {
  const key = `${model.baseUrl} ${model.id}`;
  const effective = (m: Model<Api>) => (protocol.plain.has(key) ? plainModel(m) : m);
  const fellBack = (error: string | undefined, current: Model<Api>): boolean => {
    if (protocol.plain.has(key) || !usesManagedProtocol(current) || !rejectsManagedProtocol(error)) return false;
    protocol.plain.add(key);
    protocol.onFallback?.(model.id, error ?? "");
    return true;
  };
  return {
    model,
    modelId: model.id,
    credential,
    streamFn: async (m, context, options) => {
      const first = effective(m);
      const stream = models.streamSimple(first, context, { ...RETRY, ...options, ...transport });
      // A request the API refuses outright fails before it starts streaming: its only event is the error.
      const out = createAssistantMessageEventStream();
      void (async () => {
        let forwarded = false;
        for await (const event of stream) {
          if (!forwarded && event.type === "error" && fellBack(event.error.errorMessage, first)) {
            for await (const retried of models.streamSimple(plainModel(m), context, { ...RETRY, ...options, ...transport })) out.push(retried);
            return;
          }
          forwarded = true;
          out.push(event);
        }
      })().catch((error: unknown) => out.push({ type: "error", reason: "error", error: { role: "assistant", content: [], api: m.api, provider: m.provider, model: m.id, usage: emptyUsage(), stopReason: "error", errorMessage: errorMessage(error), timestamp: Date.now() } }));
      return out;
    },
    async complete(context, options) {
      const first = effective(model) as Model<"anthropic-messages">;
      const reply = await models.complete(first, context, { ...RETRY, ...options, ...transport });
      if (reply.stopReason === "error" && fellBack(reply.errorMessage, first)) return models.complete(plainModel(model) as Model<"anthropic-messages">, context, { ...RETRY, ...options, ...transport });
      return reply;
    },
  };
}

function emptyUsage(): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

/**
 * Credential order (PLAN §5.11 item 16): (a) the mission owner's own Claude credential (Claude sign-in or API key, stored
 * per user; pi-ai refreshes OAuth tokens), (b) the server's ANTHROPIC_API_KEY, (c) ClaudeNotConnectedError. An owner
 * credential that can't be used (refresh failed) falls through to the server key and is logged.
 */
export function anthropicModels(deps: {
  config: Pick<ServerConfig, "anthropicApiKey" | "model" | "fastModel"> & Partial<Pick<ServerConfig, "anthropicBaseUrl" | "claudeProtocol">>;
  claudeAccounts?: Pick<ClaudeAccountService, "credentials" | "view">;
  log?: Pick<Logger, "warn">;
  /** Called when the API refused the managed protocol and a request was retried plain (debug log). */
  onProtocolFallback?(modelId: string, error: string): void;
  /** Test seam: the HTTP client every request uses (defaults to global fetch). */
  fetch?: typeof globalThis.fetch;
}): AgentModels {
  const { config, claudeAccounts } = deps;
  const transport = deps.fetch ? { fetch: deps.fetch } : {};
  const baseUrl = config.anthropicBaseUrl ?? "https://api.anthropic.com";
  const protocol: ProtocolState = {
    plain: new Set(),
    onFallback(modelId, error) {
      deps.log?.warn({ modelId, err: error }, "Claude refused pi-ai's managed request protocol; retrying without it (plain) from now on");
      deps.onProtocolFallback?.(modelId, error);
    },
  };
  const serverKey: Promise<CredentialStore> | undefined = config.anthropicApiKey
    ? (async (key: string) => {
        const store = new InMemoryCredentialStore();
        await store.modify(CLAUDE_PROVIDER, async () => ({ type: "api_key", key }));
        return store;
      })(config.anthropicApiKey)
    : undefined;

  async function resolve(ownerId: string, modelId: string): Promise<ClaudeModel> {
    const known = CLAUDE_CATALOG.find((m) => m.id === modelId);
    const catalogModel: Model<Api> = { ...(known ?? CLAUDE_DEFAULTS), id: modelId, name: known?.name ?? modelId, baseUrl };
    const model = config.claudeProtocol === "plain" ? plainModel(catalogModel) : catalogModel;
    const owned = claudeAccounts?.credentials(ownerId);
    if (owned && (await owned.read(CLAUDE_PROVIDER))) {
      const models = claudeModels(owned);
      try {
        // Refreshes an expired Claude sign-in now, so a broken one falls back instead of failing mid-run.
        if (await models.getAuth(CLAUDE_PROVIDER)) {
          const account = await claudeAccounts!.view(ownerId).catch(() => undefined);
          return bind(models, model, { kind: "claude-account", ...(account?.email ? { email: account.email } : {}) }, transport, protocol);
        }
      } catch (error) {
        deps.log?.warn({ ownerId, err: errorMessage(error) }, "the owner's Claude credential can't be used; trying the server key");
      }
    }
    if (serverKey) return bind(claudeModels(await serverKey), model, { kind: "server-key" }, transport, protocol);
    throw new ClaudeNotConnectedError();
  }

  return {
    design: (ownerId) => resolve(ownerId, config.model),
    fast: (ownerId) => resolve(ownerId, config.fastModel),
  };
}
