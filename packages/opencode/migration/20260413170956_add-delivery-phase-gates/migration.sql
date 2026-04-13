ALTER TABLE `swarm_run` ADD `gate` text NOT NULL DEFAULT '{"status":"pending","reason":null,"enter":["run is active"],"exit":["plan work item is completed"],"fallback":null,"updated_at":null}';--> statement-breakpoint
UPDATE `swarm_run`
SET `gate` = CASE `phase`
  WHEN 'plan' THEN '{"status":"pending","reason":null,"enter":["run is active"],"exit":["plan work item is completed"],"fallback":null,"updated_at":null}'
  WHEN 'implement' THEN '{"status":"pending","reason":null,"enter":["plan work item is completed"],"exit":["implementation work item is completed"],"fallback":"plan","updated_at":null}'
  WHEN 'verify' THEN '{"status":"pending","reason":null,"enter":["implementation work item is completed"],"exit":["verification work item is completed","required verification passed"],"fallback":"implement","updated_at":null}'
  WHEN 'commit' THEN '{"status":"pending","reason":null,"enter":["verification work item is completed","required verification passed"],"exit":["commit work item is completed"],"fallback":"verify","updated_at":null}'
  ELSE '{"status":"pending","reason":null,"enter":["commit work item is completed"],"exit":["retrospective work item is completed"],"fallback":"commit","updated_at":null}'
END;--> statement-breakpoint
ALTER TABLE `work_item` ADD `gate` text NOT NULL DEFAULT '{"status":"pending","reason":null,"enter":["run is active"],"exit":["plan work item is completed"],"fallback":null,"updated_at":null}';--> statement-breakpoint
UPDATE `work_item`
SET `gate` = CASE `phase_gate`
  WHEN 'plan' THEN '{"status":"pending","reason":null,"enter":["run is active"],"exit":["plan work item is completed"],"fallback":null,"updated_at":null}'
  WHEN 'implement' THEN '{"status":"pending","reason":null,"enter":["plan work item is completed"],"exit":["implementation work item is completed"],"fallback":"plan","updated_at":null}'
  WHEN 'verify' THEN '{"status":"pending","reason":null,"enter":["implementation work item is completed"],"exit":["verification work item is completed","required verification passed"],"fallback":"implement","updated_at":null}'
  WHEN 'commit' THEN '{"status":"pending","reason":null,"enter":["verification work item is completed","required verification passed"],"exit":["commit work item is completed"],"fallback":"verify","updated_at":null}'
  ELSE '{"status":"pending","reason":null,"enter":["commit work item is completed"],"exit":["retrospective work item is completed"],"fallback":"commit","updated_at":null}'
END;
