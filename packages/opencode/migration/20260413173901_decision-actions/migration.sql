ALTER TABLE `decision` ADD `participants` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `decision` ADD `candidate_outcomes` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `decision` ADD `input_context` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `decision` ADD `actions` text DEFAULT '[]' NOT NULL;
