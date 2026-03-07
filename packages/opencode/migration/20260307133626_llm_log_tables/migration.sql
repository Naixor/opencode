CREATE TABLE IF NOT EXISTS `llm_log_annotation` (
	`id` text PRIMARY KEY,
	`llm_log_id` text NOT NULL,
	`type` text NOT NULL,
	`content` text NOT NULL,
	`marked_text` text,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	CONSTRAINT `fk_llm_log_annotation_llm_log_id_llm_log_id_fk` FOREIGN KEY (`llm_log_id`) REFERENCES `llm_log`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `llm_log_hook` (
	`id` text PRIMARY KEY,
	`llm_log_id` text NOT NULL,
	`hook_name` text NOT NULL,
	`chain_type` text NOT NULL,
	`priority` integer NOT NULL,
	`modified_fields` text,
	`duration_ms` integer,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	CONSTRAINT `fk_llm_log_hook_llm_log_id_llm_log_id_fk` FOREIGN KEY (`llm_log_id`) REFERENCES `llm_log`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `llm_log_request` (
	`id` text PRIMARY KEY,
	`llm_log_id` text NOT NULL,
	`system_prompt` blob NOT NULL,
	`messages` blob NOT NULL,
	`tools` text,
	`options` text,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	CONSTRAINT `fk_llm_log_request_llm_log_id_llm_log_id_fk` FOREIGN KEY (`llm_log_id`) REFERENCES `llm_log`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `llm_log_response` (
	`id` text PRIMARY KEY,
	`llm_log_id` text NOT NULL,
	`completion_text` text,
	`tool_calls` text,
	`raw_response` blob,
	`error` text,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	CONSTRAINT `fk_llm_log_response_llm_log_id_llm_log_id_fk` FOREIGN KEY (`llm_log_id`) REFERENCES `llm_log`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `llm_log` (
	`id` text PRIMARY KEY,
	`session_id` text NOT NULL,
	`agent` text NOT NULL,
	`model` text NOT NULL,
	`provider` text NOT NULL,
	`variant` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`time_start` integer NOT NULL,
	`time_end` integer,
	`duration_ms` integer,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	CONSTRAINT `fk_llm_log_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `llm_log_tokens` (
	`id` text PRIMARY KEY,
	`llm_log_id` text NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`reasoning_tokens` integer DEFAULT 0 NOT NULL,
	`cache_read_tokens` integer DEFAULT 0 NOT NULL,
	`cache_write_tokens` integer DEFAULT 0 NOT NULL,
	`cost` integer DEFAULT 0 NOT NULL,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	CONSTRAINT `fk_llm_log_tokens_llm_log_id_llm_log_id_fk` FOREIGN KEY (`llm_log_id`) REFERENCES `llm_log`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `llm_log_tool_call` (
	`id` text PRIMARY KEY,
	`llm_log_id` text NOT NULL,
	`call_id` text,
	`tool_name` text NOT NULL,
	`input` text,
	`output` text,
	`title` text,
	`status` text,
	`time_start` integer,
	`time_end` integer,
	`duration_ms` integer,
	`output_bytes` integer,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	CONSTRAINT `fk_llm_log_tool_call_llm_log_id_llm_log_id_fk` FOREIGN KEY (`llm_log_id`) REFERENCES `llm_log`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `llm_log_annotation_log_idx` ON `llm_log_annotation` (`llm_log_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `llm_log_hook_log_idx` ON `llm_log_hook` (`llm_log_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `llm_log_session_idx` ON `llm_log` (`session_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `llm_log_agent_idx` ON `llm_log` (`agent`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `llm_log_model_idx` ON `llm_log` (`model`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `llm_log_provider_idx` ON `llm_log` (`provider`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `llm_log_status_idx` ON `llm_log` (`status`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `llm_log_time_start_idx` ON `llm_log` (`time_start`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `llm_log_tool_call_log_idx` ON `llm_log_tool_call` (`llm_log_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `llm_log_tool_call_name_idx` ON `llm_log_tool_call` (`tool_name`);