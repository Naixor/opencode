PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_work_item` (
	`id` text PRIMARY KEY,
	`title` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`owner_role_id` text NOT NULL,
	`blocked_by` text NOT NULL,
	`scope` text NOT NULL,
	`phase_gate` text DEFAULT 'plan' NOT NULL,
	`verification` text NOT NULL,
	`small_mr_required` integer NOT NULL,
	CONSTRAINT `fk_work_item_owner_role_id_role_spec_role_id_fk` FOREIGN KEY (`owner_role_id`) REFERENCES `role_spec`(`role_id`)
);
--> statement-breakpoint
INSERT INTO `__new_work_item`(`id`, `title`, `status`, `owner_role_id`, `blocked_by`, `scope`, `phase_gate`, `verification`, `small_mr_required`) SELECT `id`, `title`, `status`, `owner_role_id`, `blocked_by`, `scope`, `phase_gate`, `verification`, `small_mr_required` FROM `work_item`;--> statement-breakpoint
DROP TABLE `work_item`;--> statement-breakpoint
ALTER TABLE `__new_work_item` RENAME TO `work_item`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `work_item_status_idx` ON `work_item` (`status`);--> statement-breakpoint
CREATE INDEX `work_item_owner_role_idx` ON `work_item` (`owner_role_id`);--> statement-breakpoint
CREATE INDEX `work_item_phase_gate_idx` ON `work_item` (`phase_gate`);--> statement-breakpoint
CREATE INDEX `work_item_small_mr_required_idx` ON `work_item` (`small_mr_required`);