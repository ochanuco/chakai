-- events は履歴の正なので、書き換えと削除を DB で拒む
CREATE TRIGGER `events_no_update` BEFORE UPDATE ON `events`
BEGIN
	SELECT RAISE(ABORT, 'events is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `events_no_delete` BEFORE DELETE ON `events`
BEGIN
	SELECT RAISE(ABORT, 'events is append-only');
END;
--> statement-breakpoint
-- タスクは消さずに dropped にする
CREATE TRIGGER `tasks_no_delete` BEFORE DELETE ON `tasks`
BEGIN
	SELECT RAISE(ABORT, 'tasks are never deleted');
END;
