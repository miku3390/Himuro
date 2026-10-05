CREATE TABLE `characters` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`emoji` text DEFAULT '🙂' NOT NULL,
	`color` text DEFAULT '#6366f1' NOT NULL,
	`identity` text DEFAULT '' NOT NULL,
	`speech_style` text DEFAULT '' NOT NULL,
	`values` text DEFAULT '' NOT NULL,
	`boundaries` text DEFAULT '' NOT NULL,
	`user_addressing` text DEFAULT '' NOT NULL,
	`relationship` text DEFAULT '' NOT NULL,
	`first_message` text DEFAULT '' NOT NULL,
	`examples_json` text DEFAULT '[]' NOT NULL,
	`is_template` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`character_id` text NOT NULL,
	`title` text DEFAULT '新的会话' NOT NULL,
	`mode` text DEFAULT 'daily' NOT NULL,
	`tier` text DEFAULT 'light' NOT NULL,
	`chapter` integer DEFAULT 1 NOT NULL,
	`summary_text` text DEFAULT '' NOT NULL,
	`summarized_count` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`idx` integer NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`emotion` text,
	`starred` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `msg_chunks` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`message_id` text NOT NULL,
	`chunk` text NOT NULL,
	`vector_json` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`light_base_url` text DEFAULT 'mock' NOT NULL,
	`light_api_key` text DEFAULT '' NOT NULL,
	`light_model` text DEFAULT '演示模型' NOT NULL,
	`quality_base_url` text DEFAULT 'mock' NOT NULL,
	`quality_api_key` text DEFAULT '' NOT NULL,
	`quality_model` text DEFAULT '演示模型' NOT NULL,
	`embed_base_url` text DEFAULT '' NOT NULL,
	`embed_api_key` text DEFAULT '' NOT NULL,
	`embed_model` text DEFAULT '' NOT NULL,
	`summary_every_turns` integer DEFAULT 10 NOT NULL,
	`wb_max_hits` integer DEFAULT 6 NOT NULL,
	`vec_top_k` integer DEFAULT 4 NOT NULL,
	`tts_voice` text DEFAULT '' NOT NULL,
	`tts_rate` real DEFAULT 1 NOT NULL,
	`tts_pitch` real DEFAULT 1 NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `wb_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`worldbook_id` text NOT NULL,
	`category` text DEFAULT '事件' NOT NULL,
	`title` text NOT NULL,
	`content` text DEFAULT '' NOT NULL,
	`keywords_json` text DEFAULT '[]' NOT NULL,
	`weight` integer DEFAULT 5 NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `wb_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`worldbook_id` text NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`snapshot_json` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `worldbooks` (
	`id` text PRIMARY KEY NOT NULL,
	`character_id` text NOT NULL,
	`name` text DEFAULT '世界书' NOT NULL,
	`created_at` integer NOT NULL
);
