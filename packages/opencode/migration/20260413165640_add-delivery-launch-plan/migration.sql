PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_swarm_run` (
	`id` text PRIMARY KEY,
	`goal` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`phase` text DEFAULT 'plan' NOT NULL,
	`phases` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`owner_session_id` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_swarm_run`(`id`, `goal`, `status`, `phase`, `phases`, `created_at`, `updated_at`, `owner_session_id`)
SELECT `id`, `goal`, `status`, `phase`, '["plan","implement","verify","commit","retrospective"]', `created_at`, `updated_at`, `owner_session_id`
FROM `swarm_run`;--> statement-breakpoint
INSERT INTO `__new_swarm_run`(`id`, `goal`, `status`, `phase`, `phases`, `created_at`, `updated_at`, `owner_session_id`)
SELECT 'LEGACY-' || `id`, 'Legacy work item: ' || `title`, 'active', `phase_gate`, '["plan","implement","verify","commit","retrospective"]', CAST(unixepoch('now') * 1000 AS integer), CAST(unixepoch('now') * 1000 AS integer), 'legacy'
FROM `work_item`;--> statement-breakpoint
DROP TABLE `swarm_run`;--> statement-breakpoint
ALTER TABLE `__new_swarm_run` RENAME TO `swarm_run`;--> statement-breakpoint
CREATE TABLE `__new_work_item` (
	`id` text PRIMARY KEY,
	`swarm_run_id` text NOT NULL,
	`title` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`owner_role_id` text NOT NULL,
	`blocked_by` text NOT NULL,
	`scope` text NOT NULL,
	`phase_gate` text DEFAULT 'plan' NOT NULL,
	`verification` text NOT NULL,
	`small_mr_required` integer NOT NULL,
	CONSTRAINT `fk_work_item_swarm_run_id_swarm_run_id_fk` FOREIGN KEY (`swarm_run_id`) REFERENCES `swarm_run`(`id`),
	CONSTRAINT `fk_work_item_owner_role_id_role_spec_role_id_fk` FOREIGN KEY (`owner_role_id`) REFERENCES `role_spec`(`role_id`)
);
--> statement-breakpoint
INSERT INTO `__new_work_item`(`id`, `swarm_run_id`, `title`, `status`, `owner_role_id`, `blocked_by`, `scope`, `phase_gate`, `verification`, `small_mr_required`)
SELECT `id`, 'LEGACY-' || `id`, `title`, `status`, `owner_role_id`, `blocked_by`, `scope`, `phase_gate`, `verification`, `small_mr_required`
FROM `work_item`;--> statement-breakpoint
DROP TABLE `work_item`;--> statement-breakpoint
ALTER TABLE `__new_work_item` RENAME TO `work_item`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `swarm_run_status_idx` ON `swarm_run` (`status`);--> statement-breakpoint
CREATE INDEX `swarm_run_phase_idx` ON `swarm_run` (`phase`);--> statement-breakpoint
CREATE INDEX `swarm_run_owner_session_idx` ON `swarm_run` (`owner_session_id`);--> statement-breakpoint
CREATE INDEX `work_item_swarm_run_idx` ON `work_item` (`swarm_run_id`);--> statement-breakpoint
CREATE INDEX `work_item_status_idx` ON `work_item` (`status`);--> statement-breakpoint
CREATE INDEX `work_item_owner_role_idx` ON `work_item` (`owner_role_id`);--> statement-breakpoint
CREATE INDEX `work_item_phase_gate_idx` ON `work_item` (`phase_gate`);--> statement-breakpoint
CREATE INDEX `work_item_small_mr_required_idx` ON `work_item` (`small_mr_required`);
