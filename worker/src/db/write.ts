import type { BatchItem } from "drizzle-orm/batch";
import type { Db } from "./client.ts";

type Statement = BatchItem<"sqlite">;

/** D1 には対話的な transaction が無いので、まとめて通したい書き込みは 1 つの batch にする */
export const writeAll = async (db: Db, statements: Statement[]) => {
	const [first, ...rest] = statements;
	if (first) await db.batch([first, ...rest]);
};

// tasks と settings の revision の trigger が出す文の、共通の部分
export const CHANGED_SINCE_READ = "changed since read";

export const isConflict = (e: unknown) =>
	e instanceof Error &&
	new RegExp(`UNIQUE constraint failed|${CHANGED_SINCE_READ}`).test(
		`${e.message} ${String(e.cause ?? "")}`,
	);

/**
 * D1 では読んでから書くまでを 1 つの transaction にできないので、その間に他の書き込みが入ることがある。
 * 一意制約か revision の trigger で弾かれたら、読み直すところからやり直す
 */
export const retryOnConflict = async <T>(
	attempt: () => Promise<T>,
	exhausted: () => T | Promise<T>,
) => {
	for (let i = 0; i < 5; i++) {
		try {
			return await attempt();
		} catch (e) {
			if (!isConflict(e)) throw e;
		}
	}
	return exhausted();
};
