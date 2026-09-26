CREATE TABLE `paired_devices` (
	`idHash` text PRIMARY KEY NOT NULL,
	`createdAt` integer NOT NULL,
	`lastSeenAt` integer,
	`userAgent` text
);
