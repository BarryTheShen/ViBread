import { createAnthropic } from "@ai-sdk/anthropic";
import { ClaudeNotConnectedError } from "@vibread/tools";
import type { LanguageModel } from "ai";
import type { ClaudeAccountService } from "../claude/accounts.js";
import type { ServerConfig } from "../config.js";

/** Which credential pays for an agent call (shown on the timeline when it is the user's own account). */
export type ModelCredential = { kind: "claude-account"; email?: string } | { kind: "server-key" };

export interface ResolvedModel {
  model: LanguageModel;
  modelId: string;
  credential: ModelCredential;
}

/**
 * Model access for the agent roles, resolved per call for the mission owner (users connect/disconnect at runtime).
 * `design` = design agent (config.model); `fast` = test author, RETRO, photo check (config.fastModel).
 * Both reject with ClaudeNotConnectedError when no credential can serve the owner — never a fake answer.
 *
 * This file is the only place that constructs an AI provider.
 */
export interface AgentModels {
  design(ownerId: string): Promise<ResolvedModel>;
  fast(ownerId: string): Promise<ResolvedModel>;
}

/**
 * Credential order (PLAN §5.11 item 16): (a) the mission owner's connected Claude account through the per-user auth
 * gateway (`endpointFor` pre-flights it and returns undefined when the account can't serve the model); (b) the server's
 * ANTHROPIC_API_KEY; (c) ClaudeNotConnectedError.
 */
export function anthropicModels(deps: {
  config: Pick<ServerConfig, "anthropicApiKey" | "model" | "fastModel">;
  claudeAccounts?: Pick<ClaudeAccountService, "endpointFor" | "view">;
  /** Test seam: the HTTP client both providers use (defaults to global fetch). */
  fetch?: typeof globalThis.fetch;
}): AgentModels {
  const { config, claudeAccounts } = deps;
  const transport = deps.fetch ? { fetch: deps.fetch } : {};
  const serverProvider = config.anthropicApiKey ? createAnthropic({ apiKey: config.anthropicApiKey, ...transport }) : undefined;

  async function resolve(ownerId: string, modelId: string): Promise<ResolvedModel> {
    const endpoint = claudeAccounts ? await claudeAccounts.endpointFor(ownerId, modelId) : undefined;
    if (endpoint && claudeAccounts) {
      // The gateway authenticates with `Authorization: Bearer`, which the provider sends for `authToken`.
      const provider = createAnthropic({ baseURL: endpoint.baseURL, authToken: endpoint.authToken, ...transport });
      const account = await claudeAccounts.view(ownerId).catch(() => undefined);
      return { model: provider(modelId), modelId, credential: { kind: "claude-account", ...(account?.email ? { email: account.email } : {}) } };
    }
    if (serverProvider) return { model: serverProvider(modelId), modelId, credential: { kind: "server-key" } };
    throw new ClaudeNotConnectedError();
  }

  return {
    design: (ownerId) => resolve(ownerId, config.model),
    fast: (ownerId) => resolve(ownerId, config.fastModel),
  };
}
