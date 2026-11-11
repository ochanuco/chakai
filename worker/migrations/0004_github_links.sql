CREATE TABLE `github_links` (
	`link_id` text PRIMARY KEY NOT NULL,
	`repo` text NOT NULL,
	`number` integer NOT NULL,
	`base_branch` text,
	`draft` integer,
	`state` text,
	`merged_into_default` integer,
	`review` text,
	`checks` text,
	`synced_at` text,
	FOREIGN KEY (`link_id`) REFERENCES `links`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `github_links_pull` ON `github_links` (`repo`,`number`);--> statement-breakpoint
CREATE TABLE `links` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_type` text NOT NULL,
	`owner_id` text NOT NULL,
	`role` text NOT NULL,
	`kind` text NOT NULL,
	`url` text NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`linked_by` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`linked_by`) REFERENCES `actors`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `links_owner_url` ON `links` (`owner_type`,`owner_id`,`url`);--> statement-breakpoint
ALTER TABLE `project_repos` ADD `scanned_at` text;