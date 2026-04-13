CREATE TABLE `role_spec` (
	`role_id` text PRIMARY KEY,
	`name` text NOT NULL,
	`responsibility` text NOT NULL,
	`skills` text NOT NULL,
	`limits` text NOT NULL,
	`approval_required` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `swarm_run` (
	`id` text PRIMARY KEY,
	`goal` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`phase` text DEFAULT 'plan' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`owner_session_id` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `swarm_run_status_idx` ON `swarm_run` (`status`);--> statement-breakpoint
CREATE INDEX `swarm_run_phase_idx` ON `swarm_run` (`phase`);--> statement-breakpoint
CREATE INDEX `swarm_run_owner_session_idx` ON `swarm_run` (`owner_session_id`);