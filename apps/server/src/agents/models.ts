import { createAnthropic } from "@ai-sdk/anthropic";
import { ClaudeNotConnectedError } from "@vibread/tools";
import type { LanguageModel } from "ai";
import type { ServerConfig } from "../config.js";

/**
 * Model access for the three agent roles. `design` = the design agent (config.model); `fast` = test author, RETRO, photo
 * check (config.fastModel). Both throw ClaudeNotConnectedError when no API key is configured — never a fake answer.
 *
 * This file is the only place that constructs an AI provider (agents, RETRO, test author, and photo check all receive an
 * AgentModels). A later per-user credential (PLAN §5.11 item 16) plugs in here as another AgentModels factory.
 */
export interface AgentModels {
  design(): LanguageModel;
  fast(): LanguageModel;
  readonly designId: string;
  readonly fastId: string;
}

export function anthropicModels(config: Pick<ServerConfig, "anthropicApiKey" | "model" | "fastModel">): AgentModels {
  const provider = config.anthropicApiKey ? createAnthropic({ apiKey: config.anthropicApiKey }) : undefined;
  const pick = (id: string): LanguageModel => {
    if (!provider) throw new ClaudeNotConnectedError();
    return provider(id);
  };
  return {
    design: () => pick(config.model),
    fast: () => pick(config.fastModel),
    designId: config.model,
    fastId: config.fastModel,
  };
}
