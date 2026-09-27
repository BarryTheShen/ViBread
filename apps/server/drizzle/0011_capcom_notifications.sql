CREATE TABLE `capcom_config` (
	`key` text PRIMARY KEY NOT NULL,
	`json` text NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `capcom_prefs` (
	`userId` text PRIMARY KEY NOT NULL,
	`json` text NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `capcom_queue` (
	`id` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`missionId` text,
	`text` text NOT NULL,
	`createdAt` integer NOT NULL
);
