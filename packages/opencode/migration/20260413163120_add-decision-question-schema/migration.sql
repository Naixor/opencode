CREATE TABLE `decision` (
	`id` text PRIMARY KEY,
	`kind` text NOT NULL,
	`summary` text NOT NULL,
	`source` text NOT NULL,
	`status` text DEFAULT 'proposed' NOT NULL,
	`requires_user_confirmation` integer NOT NULL,
	`applies_to` text NOT NULL,
	`related_question_id` text,
	`decided_by` text,
	`decided_at` integer
);
--> statement-breakpoint
CREATE TABLE `open_question` (
	`id` text PRIMARY KEY,
	`title` text NOT NULL,
	`context` text NOT NULL,
	`options` text NOT NULL,
	`recommended_option` text,
	`status` text DEFAULT 'open' NOT NULL,
	`deadline_policy` text,
	`blocking` integer NOT NULL,
	`affects` text NOT NULL,
	`related_decision_id` text,
	`raised_by` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `decision_status_idx` ON `decision` (`status`);--> statement-breakpoint
CREATE INDEX `decision_related_question_idx` ON `decision` (`related_question_id`);--> statement-breakpoint
CREATE INDEX `open_question_status_idx` ON `open_question` (`status`);--> statement-breakpoint
CREATE INDEX `open_question_related_decision_idx` ON `open_question` (`related_decision_id`);