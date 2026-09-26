CREATE TABLE `account` (
	`id` text PRIMARY KEY NOT NULL,
	`accountId` text NOT NULL,
	`providerId` text NOT NULL,
	`userId` text NOT NULL,
	`accessToken` text,
	`refreshToken` text,
	`idToken` text,
	`accessTokenExpiresAt` integer,
	`refreshTokenExpiresAt` integer,
	`scope` text,
	`password` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `api_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`tokenHash` text NOT NULL,
	`scopes` text NOT NULL,
	`createdAt` integer NOT NULL,
	`expiresAt` integer NOT NULL,
	`lastUsedAt` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_tokens_tokenHash_unique` ON `api_tokens` (`tokenHash`);--> statement-breakpoint
CREATE TABLE `approvals` (
	`id` text PRIMARY KEY NOT NULL,
	`missionId` text NOT NULL,
	`revisionHash` text NOT NULL,
	`actionClass` text NOT NULL,
	`action` text NOT NULL,
	`actionHash` text NOT NULL,
	`input` text NOT NULL,
	`summary` text NOT NULL,
	`consequence` text NOT NULL,
	`requestedBy` text NOT NULL,
	`createdAt` integer NOT NULL,
	`expiresAt` integer NOT NULL,
	`status` text NOT NULL,
	`decision` text,
	`decidedBy` text,
	`preApprovedBy` text,
	`consumedAt` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `approvals_mission_revision_action_uidx` ON `approvals` (`missionId`,`revisionHash`,`actionHash`);--> statement-breakpoint
CREATE TABLE `artifacts` (
	`hash` text PRIMARY KEY NOT NULL,
	`contentType` text NOT NULL,
	`path` text NOT NULL,
	`size` integer NOT NULL,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`missionId` text NOT NULL,
	`at` integer NOT NULL,
	`channel` text NOT NULL,
	`actor` text NOT NULL,
	`kind` text NOT NULL,
	`text` text NOT NULL,
	`revision` integer,
	`data` text
);
--> statement-breakpoint
CREATE TABLE `imessage_links` (
	`id` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`codeHash` text NOT NULL,
	`handle` text,
	`createdAt` integer NOT NULL,
	`expiresAt` integer NOT NULL,
	`redeemedAt` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `imessage_links_codeHash_unique` ON `imessage_links` (`codeHash`);--> statement-breakpoint
CREATE UNIQUE INDEX `imessage_links_handle_unique` ON `imessage_links` (`handle`);--> statement-breakpoint
CREATE TABLE `messages` (
	`missionId` text PRIMARY KEY NOT NULL,
	`history` text NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `missions` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`brief` text NOT NULL,
	`ownerId` text NOT NULL,
	`mode` text NOT NULL,
	`phase` text NOT NULL,
	`inventory` text NOT NULL,
	`currentRevision` integer,
	`releasedRevision` integer,
	`snapshot` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `revisions` (
	`missionId` text NOT NULL,
	`n` integer NOT NULL,
	`hash` text NOT NULL,
	`parent` integer,
	`circuit` text NOT NULL,
	`suite` text,
	`author` text NOT NULL,
	`note` text,
	`results` text NOT NULL,
	`createdAt` integer NOT NULL,
	PRIMARY KEY(`missionId`, `n`)
);
--> statement-breakpoint
CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`missionId` text NOT NULL,
	`revision` integer NOT NULL,
	`kind` text NOT NULL,
	`result` text NOT NULL,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `session` (
	`id` text PRIMARY KEY NOT NULL,
	`expiresAt` integer NOT NULL,
	`token` text NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	`ipAddress` text,
	`userAgent` text,
	`userId` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_token_unique` ON `session` (`token`);--> statement-breakpoint
CREATE TABLE `user` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`emailVerified` integer NOT NULL,
	`image` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_email_unique` ON `user` (`email`);--> statement-breakpoint
CREATE TABLE `verification` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expiresAt` integer NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
