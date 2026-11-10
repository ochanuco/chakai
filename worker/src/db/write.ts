import type { BatchItem } from "drizzle-orm/batch";
import type { Db } from "./client.ts";

type Statement = BatchItem<"sqlite">;

/** D1 には対話的な transaction が無いので、まとめて通したい書き込みは 1 つの batch にする */
export const writeAll = async (db: Db, statements: Statement[]) => {
	const [first, ...rest] = statements;
	if (first) await db.batch([first, ...rest]);
};

const isUniqueViolation = (e: unknown) =>
	e instanceof Error &&
	/UNIQUE constraint failed/.test(`${e.message} ${String(e.cause ?? "")}`);

/**
 * 読んでから書くまでの間に、他の書き込みが同じ order_key やラベル名を取ることがある。
 * 一意制約で弾かれたら、読み直すところからやり直す
 */
export const retryOnConflict = async <T>(attempt: () => Promise<T>) => {
	for (let i = 0; ; i++) {
		try {
			return await attempt();
		} catch (e) {
			if (i >= 4 || !isUniqueViolation(e)) throw e;
		}
	}
};
