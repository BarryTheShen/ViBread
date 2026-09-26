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
export const approvalGrants = sqliteTable(
  "approval_grants",
  {
    missionId: text("missionId").notNull(),
    actionClass: text("actionClass").notNull(),
    action: text("action").notNull(),
    mode: text("mode").notNull(),
    createdAt: timestamp("createdAt").notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.missionId, table.actionClass, table.action] }),
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
export const jwks = sqliteTable("jwks", {
  id: text("id").primaryKey(),
  publicKey: text("publicKey").notNull(),
  privateKey: text("privateKey").notNull(),
  createdAt: timestamp("createdAt").notNull(),
  expiresAt: timestamp("expiresAt"),
  alg: text("alg"),
  crv: text("crv"),
});

export const oauthClient = sqliteTable("oauthClient", {
  id: text("id").primaryKey(),
  clientId: text("clientId").notNull().unique(),
  clientSecret: text("clientSecret"),
  clientDiscoveryId: text("clientDiscoveryId"),
  disabled: integer("disabled", { mode: "boolean" }).notNull().default(false),
  skipConsent: integer("skipConsent", { mode: "boolean" }),
  enableEndSession: integer("enableEndSession", { mode: "boolean" }),
  subjectType: text("subjectType"),
  scopes: text("scopes", { mode: "json" }).$type<string[]>(),
  clientCredentialsScopes: text("clientCredentialsScopes", { mode: "json" }).$type<string[]>().notNull().default([]),
  userId: text("userId"),
  createdAt: timestamp("createdAt"),
  updatedAt: timestamp("updatedAt"),
  name: text("name"),
  uri: text("uri"),
  icon: text("icon"),
  contacts: text("contacts", { mode: "json" }).$type<string[]>(),
  tos: text("tos"),
  policy: text("policy"),
  softwareId: text("softwareId"),
  softwareVersion: text("softwareVersion"),
  softwareStatement: text("softwareStatement"),
  redirectUris: text("redirectUris", { mode: "json" }).$type<string[]>().notNull(),
  postLogoutRedirectUris: text("postLogoutRedirectUris", { mode: "json" }).$type<string[]>(),
  backchannelLogoutUri: text("backchannelLogoutUri"),
  backchannelLogoutSessionRequired: integer("backchannelLogoutSessionRequired", { mode: "boolean" }),
  tokenEndpointAuthMethod: text("tokenEndpointAuthMethod"),
  applicationType: text("applicationType"),
  jwks: text("jwks"),
  jwksUri: text("jwksUri"),
  grantTypes: text("grantTypes", { mode: "json" }).$type<string[]>(),
  responseTypes: text("responseTypes", { mode: "json" }).$type<string[]>(),
  requirePKCE: integer("requirePKCE", { mode: "boolean" }),
  dpopBoundAccessTokens: integer("dpopBoundAccessTokens", { mode: "boolean" }).notNull().default(false),
  referenceId: text("referenceId"),
  metadata: text("metadata", { mode: "json" }).$type<Record<string, unknown>>(),
});

export const oauthResource = sqliteTable("oauthResource", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull().unique(),
  name: text("name").notNull(),
  accessTokenTtl: integer("accessTokenTtl"),
  refreshTokenTtl: integer("refreshTokenTtl"),
  signingAlgorithm: text("signingAlgorithm"),
  signingKeyId: text("signingKeyId"),
  allowedScopes: text("allowedScopes", { mode: "json" }).$type<string[]>(),
  customClaims: text("customClaims", { mode: "json" }).$type<Record<string, unknown>>(),
  dpopBoundAccessTokensRequired: integer("dpopBoundAccessTokensRequired", { mode: "boolean" }).notNull().default(false),
  disabled: integer("disabled", { mode: "boolean" }).notNull().default(false),
  createdAt: timestamp("createdAt"),
  updatedAt: timestamp("updatedAt"),
  policyVersion: integer("policyVersion").notNull().default(1),
  metadata: text("metadata", { mode: "json" }).$type<Record<string, unknown>>(),
});

export const oauthClientResource = sqliteTable("oauthClientResource", {
  id: text("id").primaryKey(),
  clientId: text("clientId").notNull(),
  resourceId: text("resourceId").notNull(),
  metadata: text("metadata", { mode: "json" }).$type<Record<string, unknown>>(),
  createdAt: timestamp("createdAt"),
}, (table) => ({
  pair: uniqueIndex("oauthClientResource_client_resource_uidx").on(table.clientId, table.resourceId),
}));

export const oauthRefreshToken = sqliteTable("oauthRefreshToken", {
  id: text("id").primaryKey(),
  token: text("token").notNull().unique(),
  clientId: text("clientId").notNull(),
  sessionId: text("sessionId"),
  userId: text("userId").notNull(),
  referenceId: text("referenceId"),
  authorizationCodeId: text("authorizationCodeId"),
  resources: text("resources", { mode: "json" }).$type<string[]>(),
  requestedUserInfoClaims: text("requestedUserInfoClaims", { mode: "json" }).$type<string[]>(),
  expiresAt: timestamp("expiresAt").notNull(),
  createdAt: timestamp("createdAt").notNull(),
  revoked: timestamp("revoked"),
  rotatedAt: timestamp("rotatedAt"),
  rotationReplayResponse: text("rotationReplayResponse"),
  rotationReplayExpiresAt: timestamp("rotationReplayExpiresAt"),
  authTime: timestamp("authTime"),
  confirmation: text("confirmation", { mode: "json" }).$type<Record<string, unknown>>(),
  scopes: text("scopes", { mode: "json" }).$type<string[]>().notNull(),
});

export const oauthAccessToken = sqliteTable("oauthAccessToken", {
  id: text("id").primaryKey(),
  token: text("token").notNull().unique(),
  clientId: text("clientId").notNull(),
  sessionId: text("sessionId"),
  userId: text("userId"),
  referenceId: text("referenceId"),
  authorizationCodeId: text("authorizationCodeId"),
  resources: text("resources", { mode: "json" }).$type<string[]>(),
  requestedUserInfoClaims: text("requestedUserInfoClaims", { mode: "json" }).$type<string[]>(),
  refreshId: text("refreshId"),
  expiresAt: timestamp("expiresAt").notNull(),
  createdAt: timestamp("createdAt").notNull(),
  revoked: timestamp("revoked"),
  confirmation: text("confirmation", { mode: "json" }).$type<Record<string, unknown>>(),
  scopes: text("scopes", { mode: "json" }).$type<string[]>().notNull(),
});

export const oauthConsent = sqliteTable("oauthConsent", {
  id: text("id").primaryKey(),
  clientId: text("clientId").notNull(),
  userId: text("userId"),
  referenceId: text("referenceId"),
  resources: text("resources", { mode: "json" }).$type<string[]>(),
  requestedUserInfoClaims: text("requestedUserInfoClaims", { mode: "json" }).$type<string[]>(),
  scopes: text("scopes", { mode: "json" }).$type<string[]>().notNull(),
  createdAt: timestamp("createdAt").notNull(),
  updatedAt: timestamp("updatedAt").notNull(),
});

export const oauthClientAssertion = sqliteTable("oauthClientAssertion", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expiresAt").notNull(),
});

export const dbSchema = {
  missions,
  revisions,
  messages,
  approvals,
  approvalGrants,
  artifacts,
  events,
  apiTokens,
  imessageLinks,
  user,
  session,
  account,
  verification,
  jwks,
  oauthClient,
  oauthResource,
  oauthClientResource,
  oauthRefreshToken,
  oauthAccessToken,
  oauthConsent,
  oauthClientAssertion,
};

export type DB = BetterSQLite3Database<typeof dbSchema>;
