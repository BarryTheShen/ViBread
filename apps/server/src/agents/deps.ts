import type { ApprovalBroker, MissionStore } from "@vibread/core";
import type { Logger } from "pino";
import type { ServerConfig } from "../config.js";
import type { MissionMachine } from "../services/machine.js";
import type { MessageStore } from "../store/messages.js";

export type { ServerConfig } from "../config.js";
export type { MissionEvent, MissionMachine } from "../services/machine.js";
export type { MessageStore } from "../store/messages.js";

export interface AgentDeps {
  config: ServerConfig;
  log: Logger;
  store: MissionStore;
  broker: ApprovalBroker;
  machine: MissionMachine;
  messages: MessageStore;
}
