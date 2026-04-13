CREATE TABLE `work_item` (
	`id` text PRIMARY KEY,
	`title` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`owner_role_id` text NOT NULL,
	`blocked_by` text NOT NULL,
	`scope` text NOT NULL,
	`phase_gate` text DEFAULT 'plan' NOT NULL,
	`verification` text NOT NULL,
	`small_mr_required` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `work_item_status_idx` ON `work_item` (`status`);--> statement-breakpoint
CREATE INDEX `work_item_owner_role_idx` ON `work_item` (`owner_role_id`);--> statement-breakpoint
CREATE INDEX `work_item_phase_gate_idx` ON `work_item` (`phase_gate`);