-- これまで同期が付けたリンクは、印から付けたものとして残す
UPDATE `links` SET `source` = 'marker' WHERE `linked_by` = 'sync';
--> statement-breakpoint
-- これまでに付けた成果物の PR にも、付けるべき actor のラベルを入れる。
-- 印から付けたリンクはタスクの担当、それ以外はリンクした actor で、agent のときだけ
UPDATE `github_links` SET `actor_label` = (
	SELECT 'actor:' || a.`id`
	FROM `links` l
	JOIN `tasks` t ON t.`id` = l.`owner_id`
	JOIN `actors` a ON a.`id` = CASE WHEN l.`source` = 'marker' THEN t.`assignee_id` ELSE l.`linked_by` END
	WHERE l.`id` = `github_links`.`link_id` AND a.`kind` = 'agent'
)
WHERE `actor_label` IS NULL;
