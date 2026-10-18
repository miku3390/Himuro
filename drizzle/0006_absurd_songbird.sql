CREATE TABLE `regex_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`find_regex` text NOT NULL,
	`replacement` text DEFAULT '' NOT NULL,
	`flags` text DEFAULT 'g' NOT NULL,
	`target` text DEFAULT 'output' NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `characters` ADD `persona_inject` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `characters` ADD `author_note` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `characters` ADD `author_note_depth` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD `light_temp` real DEFAULT 0.8 NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD `light_top_p` real DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD `quality_temp` real DEFAULT 0.8 NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD `quality_top_p` real DEFAULT 1 NOT NULL;