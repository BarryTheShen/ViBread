import { createAnthropic } from "@ai-sdk/anthropic";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createModels, createProvider, type Api, type Model, type ModelAuth } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { ClaudeNotConnectedError } from "@vibread/tools";
import type { LanguageModel } from "ai";
import type { ClaudeAccountService } from "../claude/accounts.js";
import type { ServerConfig } from "../config.js";

/** Which credential pays for an agent call (shown on the timeline when it is the user's own account). */
export type ModelCredential = { kind: "claude-account"; email?: string } | { kind: "server-key" };

/** A single-shot model (test author, RETRO, photo check, scan) on the AI SDK. */
export interface ResolvedModel {
  model: LanguageModel;
  modelId: string;
  credential: ModelCredential;
}

/** The design agent's model on pi: the pi model plus the stream function pi's Agent calls for every turn. */
export interface DesignModel {
  model: Model<Api>;
  streamFn: StreamFn;
  modelId: string;
  credential: ModelCredential;
}

/**
 * Model access for the agent roles, resolved per call for the mission owner (users connect/disconnect at runtime).
 * `design` = design agent on pi (config.model); `fast` = test author, RETRO, photo check (config.fastModel).
 * Both reject with ClaudeNotConnectedError when no credential can serve the owner — never a fake answer.
 *
 * This file is the only place that constructs an AI provider.
 */
/** What a model call is for, so the debug log can attribute it (trace.ts). */
export interface ModelTrace {
  missionId: string | null;
  purpose: "design" | "test-author" | "retro" | "photo-check" | "scan";
}

export interface AgentModels {
  design(ownerId: string, trace: ModelTrace): Promise<DesignModel>;
  fast(ownerId: string, trace: ModelTrace): Promise<ResolvedModel>;
}

/** pi provider id for ViBread's Claude credential (the owner's account through the gateway, or the server key). */
const CLAUDE_PROVIDER = "vibread-claude";
/** pi's Claude catalog: context window, output cap, vision, and prompt-cache facts per model id. */
const CLAUDE_CATALOG = anthropicProvider().getModels();
/** For a VIBREAD_MODEL pi's catalog doesn't know yet: Anthropic's current Claude limits. */
const CLAUDE_DEFAULTS: Omit<Model<"anthropic-messages">, "id" | "name" | "provider" | "baseUrl"> = {
  api: "anthropic-messages",
  reasoning: true,
  input: ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 32_000,
};

/**
 * Credential order (PLAN §5.11 item 16): (a) the mission owner's connected Claude account through the per-user auth
 * gateway (`endpointFor` pre-flights it and returns undefined when the account can't serve the model); (b) the server's
 * ANTHROPIC_API_KEY; (c) ClaudeNotConnectedError.
 */
export function anthropicModels(deps: {
  config: Pick<ServerConfig, "anthropicApiKey" | "model" | "fastModel"> & Partial<Pick<ServerConfig, "anthropicBaseUrl">>;
  claudeAccounts?: Pick<ClaudeAccountService, "endpointFor" | "view">;
  /** Test seam: the HTTP client every provider uses (defaults to global fetch). */
  fetch?: typeof globalThis.fetch;
}): AgentModels {
  const { config, claudeAccounts } = deps;
  const transport = deps.fetch ? { fetch: deps.fetch } : {};
  const serverBaseURL = config.anthropicBaseUrl ?? "https://api.anthropic.com/v1";
  const serverProvider = config.anthropicApiKey ? createAnthropic({ apiKey: config.anthropicApiKey, baseURL: serverBaseURL, ...transport }) : undefined;

  /** Where and how to reach Claude for this owner: the gateway (Bearer token) ahead of the server key (x-api-key). */
  async function credentialFor(ownerId: string, modelId: string): Promise<{ baseURL: string; bearer?: string; credential: ModelCredential }> {
    const endpoint = claudeAccounts ? await claudeAccounts.endpointFor(ownerId, modelId) : undefined;
    if (endpoint && claudeAccounts) {
      const account = await claudeAccounts.view(ownerId).catch(() => undefined);
      return { baseURL: endpoint.baseURL, bearer: endpoint.authToken, credential: { kind: "claude-account", ...(account?.email ? { email: account.email } : {}) } };
    }
    if (config.anthropicApiKey) return { baseURL: serverBaseURL, credential: { kind: "server-key" } };
    throw new ClaudeNotConnectedError();
  }

  async function resolve(ownerId: string, modelId: string): Promise<ResolvedModel> {
    const { baseURL, bearer, credential } = await credentialFor(ownerId, modelId);
    if (!bearer && serverProvider) return { model: serverProvider(modelId), modelId, credential };
    // The AI SDK provider sends `authToken` as `Authorization: Bearer`.
    return { model: createAnthropic({ baseURL, authToken: bearer, ...transport })(modelId), modelId, credential };
  }

  async function design(ownerId: string): Promise<DesignModel> {
    const modelId = config.model;
    const { baseURL, bearer, credential } = await credentialFor(ownerId, modelId);
    const auth: ModelAuth = bearer ? { headers: { authorization: `Bearer ${bearer}` } } : { apiKey: config.anthropicApiKey! };
    const known = CLAUDE_CATALOG.find((m) => m.id === modelId);
    // AI SDK base URLs end in /v1; the Anthropic SDK pi uses appends /v1/messages itself.
    const model: Model<"anthropic-messages"> = { ...(known ?? CLAUDE_DEFAULTS), id: modelId, name: known?.name ?? modelId, provider: CLAUDE_PROVIDER, baseUrl: baseURL.replace(/\/v1\/?$/, "") };
    const models = createModels();
    models.setProvider(
      createProvider({
        id: CLAUDE_PROVIDER,
        name: "Claude",
        auth: { apiKey: { name: credential.kind === "claude-account" ? "Your Claude account" : "Server ANTHROPIC_API_KEY", resolve: async () => ({ auth, source: credential.kind }) } },
        models: [model],
        api: anthropicMessagesApi(),
      }),
    );
    return { model, modelId, credential, streamFn: (m, context, options) => models.streamSimple(m, context, { ...options, ...transport }) };
  }

  return {
    design: (ownerId) => design(ownerId),
    fast: (ownerId) => resolve(ownerId, config.fastModel),
  };
}
