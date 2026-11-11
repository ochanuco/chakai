CREATE TABLE `sync_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`at` text NOT NULL,
	`trigger` text NOT NULL,
	`actor_id` text NOT NULL,
	`caller_id` text,
	`skipped` integer NOT NULL,
	`synced` integer NOT NULL,
	`linked` integer NOT NULL,
	`done` integer NOT NULL,
	`warnings` text NOT NULL,
	FOREIGN KEY (`actor_id`) REFERENCES `actors`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`caller_id`) REFERENCES `callers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `github_links` ADD `actor_label` text;--> statement-breakpoint
ALTER TABLE `github_links` ADD `labeled_at` text;