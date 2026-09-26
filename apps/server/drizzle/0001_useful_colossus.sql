CREATE TABLE `approval_grants` (
	`missionId` text NOT NULL,
	`actionClass` text NOT NULL,
	`action` text NOT NULL,
	`mode` text NOT NULL,
	`createdAt` integer NOT NULL,
	PRIMARY KEY(`missionId`, `actionClass`, `action`)
);
