PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS "missions" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "title" TEXT NOT NULL,
  "brief" TEXT NOT NULL,
  "ownerId" TEXT NOT NULL,
  "mode" TEXT NOT NULL,
  "phase" TEXT NOT NULL,
  "inventory" TEXT NOT NULL,
  "currentRevision" INTEGER,
  "releasedRevision" INTEGER,
  "snapshot" TEXT,
  "createdAt" INTEGER NOT NULL,
  "updatedAt" INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS "revisions" (
  "missionId" TEXT NOT NULL,
  "n" INTEGER NOT NULL,
  "hash" TEXT NOT NULL,
  "parent" INTEGER,
  "circuit" TEXT NOT NULL,
  "suite" TEXT,
  "author" TEXT NOT NULL,
  "note" TEXT,
  "results" TEXT NOT NULL,
  "createdAt" INTEGER NOT NULL,
  PRIMARY KEY ("missionId", "n")
);
CREATE TABLE IF NOT EXISTS "messages" (
  "missionId" TEXT PRIMARY KEY NOT NULL,
  "history" TEXT NOT NULL,
  "updatedAt" INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS "approvals" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "missionId" TEXT NOT NULL,
  "revisionHash" TEXT NOT NULL,
  "actionClass" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "actionHash" TEXT NOT NULL,
  "input" TEXT NOT NULL,
  "summary" TEXT NOT NULL,
  "consequence" TEXT NOT NULL,
  "requestedBy" TEXT NOT NULL,
  "createdAt" INTEGER NOT NULL,
  "expiresAt" INTEGER NOT NULL,
  "status" TEXT NOT NULL,
  "decision" TEXT,
  "decidedBy" TEXT,
  "preApprovedBy" TEXT,
  "consumedAt" INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS "approvals_mission_revision_action_uidx" ON "approvals" ("missionId", "revisionHash", "actionHash");
CREATE TABLE IF NOT EXISTS "runs" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "missionId" TEXT NOT NULL,
  "revision" INTEGER NOT NULL,
  "kind" TEXT NOT NULL,
  "result" TEXT NOT NULL,
  "createdAt" INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS "artifacts" (
  "hash" TEXT PRIMARY KEY NOT NULL,
  "contentType" TEXT NOT NULL,
  "path" TEXT NOT NULL,
  "size" INTEGER NOT NULL,
  "createdAt" INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS "events" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "missionId" TEXT NOT NULL,
  "at" INTEGER NOT NULL,
  "channel" TEXT NOT NULL,
  "actor" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "text" TEXT NOT NULL,
  "revision" INTEGER,
  "data" TEXT
);
CREATE INDEX IF NOT EXISTS "events_mission_at_idx" ON "events" ("missionId", "at", "id");
CREATE TABLE IF NOT EXISTS "api_tokens" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "userId" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL UNIQUE,
  "scopes" TEXT NOT NULL,
  "createdAt" INTEGER NOT NULL,
  "expiresAt" INTEGER NOT NULL,
  "lastUsedAt" INTEGER
);
CREATE TABLE IF NOT EXISTS "imessage_links" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "userId" TEXT NOT NULL,
  "codeHash" TEXT NOT NULL UNIQUE,
  "handle" TEXT UNIQUE,
  "createdAt" INTEGER NOT NULL,
  "expiresAt" INTEGER NOT NULL,
  "redeemedAt" INTEGER
);
CREATE TABLE IF NOT EXISTS "build_progress" (
  "missionId" TEXT PRIMARY KEY NOT NULL,
  "revision" INTEGER,
  "current" INTEGER NOT NULL,
  "plug" TEXT NOT NULL,
  "headline" TEXT,
  "updatedAt" INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS "user" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "name" TEXT NOT NULL,
  "email" TEXT NOT NULL UNIQUE,
  "emailVerified" INTEGER NOT NULL,
  "image" TEXT,
  "createdAt" INTEGER NOT NULL,
  "updatedAt" INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS "session" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "expiresAt" INTEGER NOT NULL,
  "token" TEXT NOT NULL UNIQUE,
  "createdAt" INTEGER NOT NULL,
  "updatedAt" INTEGER NOT NULL,
  "ipAddress" TEXT,
  "userAgent" TEXT,
  "userId" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "session_userId_idx" ON "session" ("userId");
CREATE TABLE IF NOT EXISTS "account" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "accountId" TEXT NOT NULL,
  "providerId" TEXT NOT NULL,
  "userId" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "accessToken" TEXT,
  "refreshToken" TEXT,
  "idToken" TEXT,
  "accessTokenExpiresAt" INTEGER,
  "refreshTokenExpiresAt" INTEGER,
  "scope" TEXT,
  "password" TEXT,
  "createdAt" INTEGER NOT NULL,
  "updatedAt" INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS "account_userId_idx" ON "account" ("userId");
CREATE TABLE IF NOT EXISTS "verification" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "identifier" TEXT NOT NULL,
  "value" TEXT NOT NULL,
  "expiresAt" INTEGER NOT NULL,
  "createdAt" INTEGER NOT NULL,
  "updatedAt" INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS "verification_identifier_idx" ON "verification" ("identifier");

CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "hash" TEXT NOT NULL,
  "created_at" INTEGER
);
