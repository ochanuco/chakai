-- 更新は、読んだ時点の revision に 1 を足して書く。間に他の更新が入っていたら、履歴の before が実際とずれるので拒む
CREATE TRIGGER `settings_revision` BEFORE UPDATE ON `settings`
WHEN NEW.`revision` <> OLD.`revision` + 1
BEGIN
	SELECT RAISE(ABORT, 'setting changed since read');
END;
--> statement-breakpoint
-- 行を消すと、消す前に読んだ側の書き込みを revision で拒めなくなる
CREATE TRIGGER `settings_no_delete` BEFORE DELETE ON `settings`
BEGIN
	SELECT RAISE(ABORT, 'settings are never deleted');
END;
