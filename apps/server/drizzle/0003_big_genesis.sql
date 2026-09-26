CREATE TABLE `claude_accounts` (
	`userId` text PRIMARY KEY NOT NULL,
	`credentialId` integer NOT NULL,
	`identityKey` text NOT NULL,
	`email` text,
	`orgName` text,
	`connectedAt` integer NOT NULL
);
