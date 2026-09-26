import pino from "pino";
import type { Logger } from "pino";
import type { MissionService, MissionStore, ApprovalBroker, ToolRegistry } from "@vibread/core";
import type { ServerAuth } from "./auth.js";
import { createAgentRuntime } from "./agents/index.js";
import { createServerAuth } from "./auth.js";
import { loadConfig, type ServerConfig } from "./config.js";
import { createClaudeAccountService, type ClaudeAccountService } from "./claude/accounts.js";
import { openDatabase, type DB, type OpenDatabase } from "./db/index.js";
import { createMissionMachine, type MissionMachine, type MissionEvent } from "./services/machine.js";
import { createApprovalBroker } from "./services/approvals.js";
import { createLinkService, type LinkService } from "./services/links.js";
import { createTokenService, type TokenService } from "./services/tokens.js";
import { createCapcomSpaceStore, type CapcomSpaceStore } from "./services/capcom-spaces.js";
import { createBenchAskStore, type BenchAskStore } from "./services/bench-asks.js";
import { createLanGuard, type LanGuard } from "./services/lan-guard.js";
import { createMissionStore } from "./store/missions.js";
import { createMessageStore, type MessageStore } from "./store/messages.js";
import { ensureOperatorUser } from "./auth.js";
import type { AgentRuntime } from "./agents/index.js";
export interface AppContext {
  config: ServerConfig;
  log: Logger;
  db: DB;
  store: MissionStore;
  broker: ApprovalBroker;
  machine: MissionMachine;
  tokens: TokenService;
  links: LinkService;
  capcomSpaces: CapcomSpaceStore;
  benchAsks: BenchAskStore;
  lanGuard: LanGuard;
  missions: MissionService;
  tools: ToolRegistry;
  runtime: AgentRuntime;
  messages: MessageStore;
  claudeAccounts: ClaudeAccountService;
  operator(): Promise<{ id: string; name: string }>;
}

export interface AppContextHandle {
  ctx: AppContext;
  auth: ServerAuth["auth"];
  close(): void;
}

export function createAppContext(input: { config?: ServerConfig; log?: Logger } = {}): AppContextHandle {
  const config = input.config ?? loadConfig();
  const log = input.log ?? pino({ level: process.env.LOG_LEVEL ?? "info" });
  const opened: OpenDatabase = openDatabase(config.dataDir);
  const store = createMissionStore({ db: opened.db, sqlite: opened.sqlite, dataDir: config.dataDir });
  const broker = createApprovalBroker({ db: opened.db, sqlite: opened.sqlite, approvalSecret: config.approvalSecret, store });
  const machine = createMissionMachine({ db: opened.db, sqlite: opened.sqlite, store });
  const tokens = createTokenService({ db: opened.db, sqlite: opened.sqlite });
  const links = createLinkService({ db: opened.db, sqlite: opened.sqlite });
  const capcomSpaces = createCapcomSpaceStore({ db: opened.db, sqlite: opened.sqlite });
  const benchAsks = createBenchAskStore({ store });
  const lanGuard = createLanGuard({ dataDir: config.dataDir, singleOperator: config.singleOperator, pairing: process.env.VIBREAD_LAN_PAIRING });
  const messages = createMessageStore({ db: opened.db, sqlite: opened.sqlite });
  const claudeAccounts = createClaudeAccountService({ config, db: opened.db, log });
  const runtime = createAgentRuntime({ config, log, store, broker, machine, messages, claudeAccounts });
  const ctx: AppContext = {
    config,
    log,
    db: opened.db,
    store,
    broker,
    machine,
    tokens,
    links,
    capcomSpaces,
    benchAsks,
    lanGuard,
    missions: runtime.missions,
    tools: runtime.tools,
    runtime,
    messages,
    claudeAccounts,
    async operator() {
      ensureOperatorUser(opened.sqlite);
      return { id: "operator", name: "Operator" };
    },
  };
  const auth = createServerAuth(config, opened.db).auth;
  return {
    ctx,
    auth,
    close() {
      void claudeAccounts.stop();
      opened.close();
    },
  };
}
