CREATE TABLE `conv_members` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`character_id` text NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL,
	`joined_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `conversations` ADD `group_strategy` text;--> statement-breakpoint
ALTER TABLE `messages` ADD `character_id` text;