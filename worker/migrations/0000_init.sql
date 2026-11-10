CREATE TABLE `actor_external_ids` (
	`actor_id` text NOT NULL,
	`provider` text NOT NULL,
	`external_id` text NOT NULL,
	PRIMARY KEY(`actor_id`, `provider`),
	FOREIGN KEY (`actor_id`) REFERENCES `actors`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `actor_external_ids_external` ON `actor_external_ids` (`provider`,`external_id`);--> statement-breakpoint
CREATE TABLE `actors` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`role` text NOT NULL,
	`display_name` text NOT NULL,
	`runtime` text,
	`email` text,
	`active` integer DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `actors_email_unique` ON `actors` (`email`);--> statement-breakpoint
CREATE TABLE `caller_actors` (
	`caller_id` text NOT NULL,
	`actor_id` text NOT NULL,
	PRIMARY KEY(`caller_id`, `actor_id`),
	FOREIGN KEY (`caller_id`) REFERENCES `callers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`actor_id`) REFERENCES `actors`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `callers` (
	`id` text PRIMARY KEY NOT NULL,
	`access_client_id` text NOT NULL,
	`name` text NOT NULL,
	`default_actor_id` text,
	FOREIGN KEY (`default_actor_id`) REFERENCES `actors`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `callers_access_client_id_unique` ON `callers` (`access_client_id`);--> statement-breakpoint
CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`entity` text NOT NULL,
	`entity_id` text NOT NULL,
	`actor_id` text NOT NULL,
	`caller_id` text,
	`at` text NOT NULL,
	`field` text NOT NULL,
	`before` text,
	`after` text,
	FOREIGN KEY (`actor_id`) REFERENCES `actors`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`caller_id`) REFERENCES `callers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `events_entity` ON `events` (`entity`,`entity_id`,`id`);--> statement-breakpoint
CREATE TABLE `labels` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `labels_name_unique` ON `labels` (`name`);--> statement-breakpoint
CREATE TABLE `project_repos` (
	`project_id` text NOT NULL,
	`repo` text NOT NULL,
	PRIMARY KEY(`project_id`, `repo`),
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `actors`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `task_labels` (
	`task_id` text NOT NULL,
	`label_id` text NOT NULL,
	PRIMARY KEY(`task_id`, `label_id`),
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`label_id`) REFERENCES `labels`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`parent_id` text,
	`title` text NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`state` text DEFAULT 'backlog' NOT NULL,
	`assignee_id` text,
	`order_key` text NOT NULL,
	`waiting_on` text,
	`revision` integer DEFAULT 0 NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`assignee_id`) REFERENCES `actors`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `actors`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_project_order` ON `tasks` (`project_id`,`order_key`);--> statement-breakpoint
CREATE INDEX `tasks_parent` ON `tasks` (`parent_id`);--> statement-breakpoint
CREATE INDEX `tasks_state` ON `tasks` (`state`);