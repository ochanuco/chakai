-- これまでに付けた成果物の PR にも、付けるべき actor のラベルを入れる。
-- 同期が付けたリンクはタスクの担当、それ以外はリンクした actor で、agent のときだけ
UPDATE `github_links` SET `actor_label` = (
	SELECT 'actor:' || a.`id`
	FROM `links` l
	JOIN `tasks` t ON t.`id` = l.`owner_id`
	JOIN `actors` a ON a.`id` = CASE WHEN l.`linked_by` = 'sync' THEN t.`assignee_id` ELSE l.`linked_by` END
	WHERE l.`id` = `github_links`.`link_id` AND a.`kind` = 'agent'
)
WHERE `actor_label` IS NULL;
