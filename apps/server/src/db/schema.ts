import {
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

const timestamp = (name: string) => integer(name, { mode: "timestamp_ms" });

export const missions = sqliteTable("missions", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  brief: text("brief").notNull(),
  ownerId: text("ownerId").notNull(),
  mode: text("mode").notNull(),
  phase: text("phase").notNull(),
  inventory: text("inventory").notNull(),
  currentRevision: integer("currentRevision"),
  releasedRevision: integer("releasedRevision"),
  snapshot: text("snapshot"),
  createdAt: timestamp("createdAt").notNull(),
  updatedAt: timestamp("updatedAt").notNull(),
});

export const revisions = sqliteTable(
  "revisions",
  {
    missionId: text("missionId").notNull(),
    n: integer("n").notNull(),
    hash: text("hash").notNull(),
    parent: integer("parent"),
    circuit: text("circuit").notNull(),
    suite: text("suite"),
    author: text("author").notNull(),
    note: text("note"),
    results: text("results").notNull(),
    createdAt: timestamp("createdAt").notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.missionId, table.n] }),
  }),
);

export const messages = sqliteTable("messages", {
  missionId: text("missionId").primaryKey(),
  history: text("history").notNull(),
  updatedAt: timestamp("updatedAt").notNull(),
});

export const approvals = sqliteTable(
  "approvals",
  {
    id: text("id").primaryKey(),
    missionId: text("missionId").notNull(),
    revisionHash: text("revisionHash").notNull(),
    actionClass: text("actionClass").notNull(),
    action: text("action").notNull(),
    actionHash: text("actionHash").notNull(),
    input: text("input").notNull(),
    summary: text("summary").notNull(),
    consequence: text("consequence").notNull(),
    requestedBy: text("requestedBy").notNull(),
    createdAt: timestamp("createdAt").notNull(),
    expiresAt: timestamp("expiresAt").notNull(),
    status: text("status").notNull(),
    decision: text("decision"),
    decidedBy: text("decidedBy"),
    preApprovedBy: text("preApprovedBy"),
    consumedAt: timestamp("consumedAt"),
  },
  (table) => ({
    actionIdx: uniqueIndex("approvals_mission_revision_action_uidx").on(table.missionId, table.revisionHash, table.actionHash),
  }),
);

export const runs = sqliteTable("runs", {
  id: text("id").primaryKey(),
  missionId: text("missionId").notNull(),
  revision: integer("revision").notNull(),
  kind: text("kind").notNull(),
  result: text("result").notNull(),
  createdAt: timestamp("createdAt").notNull(),
});

export const artifacts = sqliteTable("artifacts", {
  hash: text("hash").primaryKey(),
  contentType: text("contentType").notNull(),
  path: text("path").notNull(),
  size: integer("size").notNull(),
  createdAt: timestamp("createdAt").notNull(),
});

export const events = sqliteTable("events", {
  id: text("id").primaryKey(),
  missionId: text("missionId").notNull(),
  at: timestamp("at").notNull(),
  channel: text("channel").notNull(),
  actor: text("actor").notNull(),
  kind: text("kind").notNull(),
  text: text("text").notNull(),
  revision: integer("revision"),
  data: text("data"),
});

export const apiTokens = sqliteTable("api_tokens", {
  id: text("id").primaryKey(),
  userId: text("userId").notNull(),
  tokenHash: text("tokenHash").notNull().unique(),
  scopes: text("scopes").notNull(),
  createdAt: timestamp("createdAt").notNull(),
  expiresAt: timestamp("expiresAt").notNull(),
  lastUsedAt: timestamp("lastUsedAt"),
});

export const imessageLinks = sqliteTable("imessage_links", {
  id: text("id").primaryKey(),
  userId: text("userId").notNull(),
  codeHash: text("codeHash").notNull().unique(),
  handle: text("handle").unique(),
  createdAt: timestamp("createdAt").notNull(),
  expiresAt: timestamp("expiresAt").notNull(),
  redeemedAt: timestamp("redeemedAt"),
});


// Better Auth's Drizzle adapter requires these exact model keys.
export const user = sqliteTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: integer("emailVerified", { mode: "boolean" }).notNull(),
  image: text("image"),
  createdAt: timestamp("createdAt").notNull(),
  updatedAt: timestamp("updatedAt").notNull(),
});

export const session = sqliteTable("session", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expiresAt").notNull(),
  token: text("token").notNull().unique(),
  createdAt: timestamp("createdAt").notNull(),
  updatedAt: timestamp("updatedAt").notNull(),
  ipAddress: text("ipAddress"),
  userAgent: text("userAgent"),
  userId: text("userId").notNull(),
});

export const account = sqliteTable("account", {
  id: text("id").primaryKey(),
  accountId: text("accountId").notNull(),
  providerId: text("providerId").notNull(),
  userId: text("userId").notNull(),
  accessToken: text("accessToken"),
  refreshToken: text("refreshToken"),
  idToken: text("idToken"),
  accessTokenExpiresAt: timestamp("accessTokenExpiresAt"),
  refreshTokenExpiresAt: timestamp("refreshTokenExpiresAt"),
  scope: text("scope"),
  password: text("password"),
  createdAt: timestamp("createdAt").notNull(),
  updatedAt: timestamp("updatedAt").notNull(),
});

export const verification = sqliteTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expiresAt").notNull(),
  createdAt: timestamp("createdAt").notNull(),
  updatedAt: timestamp("updatedAt").notNull(),
});

export const dbSchema = {
  missions,
  revisions,
  messages,
  approvals,
  runs,
  artifacts,
  events,
  apiTokens,
  imessageLinks,
  user,
  session,
  account,
  verification,
};

export type DB = BetterSQLite3Database<typeof dbSchema>;
