-- 同期が自動で動かした書き込みを events に残すための actor。
-- 無効にして入れるので、X-Actor で名乗ることも、担当にすることもできない
INSERT OR IGNORE INTO `actors` (`id`, `kind`, `role`, `display_name`, `runtime`, `email`, `active`)
VALUES ('sync', 'system', 'member', '同期', NULL, NULL, 0);
