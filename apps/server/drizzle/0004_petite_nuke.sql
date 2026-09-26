CREATE TABLE `capcom_spaces` (
	`spaceId` text PRIMARY KEY NOT NULL,
	`handle` text NOT NULL,
	`userId` text NOT NULL,
	`missionId` text,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
DROP INDEX `approvals_mission_revision_action_uidx`;--> statement-breakpoint
CREATE UNIQUE INDEX `approvals_mission_revision_action_uidx` ON `approvals` (`missionId`,`revisionHash`,`actionHash`) WHERE "status" = 'pending';