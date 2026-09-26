CREATE TABLE `inventory_items` (
	`id` text PRIMARY KEY NOT NULL,
	`ownerId` text NOT NULL,
	`typeId` text NOT NULL,
	`identity` text NOT NULL,
	`values` text NOT NULL,
	`quantity` integer NOT NULL,
	`status` text NOT NULL,
	`source` text NOT NULL,
	`candidates` text,
	`photoUrl` text,
	`note` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `inventory_items_owner_identity_uidx` ON `inventory_items` (`ownerId`,`identity`);--> statement-breakpoint
CREATE TABLE `inventory_scans` (
	`id` text PRIMARY KEY NOT NULL,
	`ownerId` text NOT NULL,
	`status` text NOT NULL,
	`photos` text NOT NULL,
	`analyzed` text,
	`observations` text,
	`items` text,
	`error` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `part_types` (
	`id` text PRIMARY KEY NOT NULL,
	`ownerId` text NOT NULL,
	`json` text NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `missions` ADD `inventoryNotes` text;