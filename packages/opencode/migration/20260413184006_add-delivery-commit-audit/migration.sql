ALTER TABLE `swarm_run` ADD `audit` text NOT NULL DEFAULT '[]';--> statement-breakpoint
ALTER TABLE `work_item` ADD `commit` text;
