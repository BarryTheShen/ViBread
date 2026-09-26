CREATE TABLE `claude_accounts` (
	`userId` text PRIMARY KEY NOT NULL,
	`credential` text NOT NULL,
	`email` text,
	`orgName` text,
	`connectedAt` integer NOT NULL
);
