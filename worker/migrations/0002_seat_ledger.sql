CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`actor_id` text NOT NULL,
	`seat` text NOT NULL,
	`model` text,
	`hishaku_no` integer,
	`started_at` text NOT NULL,
	`ended_at` text,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`actor_id`) REFERENCES `actors`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `runs_task` ON `runs` (`task_id`);--> statement-breakpoint
CREATE TABLE `settings` (
	`scope` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	PRIMARY KEY(`scope`, `key`)
);
--> statement-breakpoint
CREATE TABLE `task_relations` (
	`from_task` text NOT NULL,
	`kind` text NOT NULL,
	`to_task` text NOT NULL,
	`run_id` text,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`from_task`, `kind`, `to_task`),
	FOREIGN KEY (`from_task`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`to_task`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `actors`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `task_relations_to` ON `task_relations` (`to_task`);--> statement-breakpoint
ALTER TABLE `tasks` ADD `triaged_at` text;