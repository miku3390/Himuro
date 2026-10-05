ALTER TABLE `characters` ADD `tts_ref_audio` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `characters` ADD `tts_prompt_text` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `characters` ADD `tts_prompt_lang` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `characters` ADD `tts_lang` text DEFAULT '' NOT NULL;