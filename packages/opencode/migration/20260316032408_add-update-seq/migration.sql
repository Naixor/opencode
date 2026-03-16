ALTER TABLE `message` ADD `update_seq` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `part` ADD `update_seq` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `session` ADD `update_seq` integer DEFAULT 0 NOT NULL;