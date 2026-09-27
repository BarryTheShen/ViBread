import type { ApprovalBroker, InventoryEntry, MissionStore, MyHardware, PartType } from "@vibread/core";
import type { Logger } from "pino";
import type { ClaudeAccountService } from "../claude/accounts.js";
import type { ServerConfig } from "../config.js";
import type { MissionMachine } from "../services/machine.js";
import type { DebugLog } from "../services/debug-log.js";
import type { MessageStore } from "../store/messages.js";

export type { ServerConfig } from "../config.js";
export type { MissionEvent, MissionMachine } from "../services/machine.js";
export type { MessageStore } from "../store/messages.js";

/** The owner's parts inventory (docs/ui-redesign-plan.md §5.4), implemented by ServerCore's inventory store. */
export interface InventoryReader {
  entries(ownerId: string): Promise<InventoryEntry[]>;
  /** Built-in types plus the owner's own. */
  types(ownerId: string): Promise<PartType[]>;
}

export interface AgentDeps {
  config: ServerConfig;
  log: Logger;
  store: MissionStore;
  broker: ApprovalBroker;
  machine: MissionMachine;
  messages: MessageStore;
  /** Per-user Claude accounts (PLAN §5.11 item 16); models.ts prefers the mission owner's account over the server key. */
  claudeAccounts: ClaudeAccountService;
  inventory: InventoryReader;
  /** The owner's hardware (issue #23): new missions snapshot it; absent in tests that don't need it. */
  hardware?: { get(ownerId: string): Promise<{ hardware: MyHardware }> };
  /** Per-mission debug log (ServerCore, services/debug-log.ts): agent runs, model calls, tool calls (trace.ts). */
  debug: DebugLog;
}
