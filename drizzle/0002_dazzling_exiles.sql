ALTER TABLE `settings` ADD `tts_provider` text DEFAULT 'browser' NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD `tts_base_url` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD `tts_lang` text DEFAULT 'zh' NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD `tts_ref_audio` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD `tts_prompt_text` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD `tts_prompt_lang` text DEFAULT 'ja' NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD `tts_model` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD `tts_openai_voice` text DEFAULT '' NOT NULL;