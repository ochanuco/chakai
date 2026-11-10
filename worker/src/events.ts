import type { Principal } from "./auth.ts";
import type { Db } from "./db/client.ts";
import { events } from "./db/schema.ts";
import { newId } from "./id.ts";

export type Change = {
	entity: "project" | "task" | "label" | "run" | "setting";
	entityId: string;
	field: string;
	before?: unknown;
	after?: unknown;
};

const encode = (value: unknown): string | null =>
	value === undefined || value === null ? null : JSON.stringify(value);

// D1 が 1 文で受ける bind は 100 まで。events は 1 行 9 列なので、10 行ずつに分ける
const ROWS_PER_INSERT = 10;

/**
 * events に追記する文を作る。書き込みと同じ batch に入れて、片方だけが残らないようにする。
 * changes は 1 つ以上渡す
 */
export const eventInserts = (
	db: Db,
	who: Principal,
	at: string,
	changes: Change[],
) => {
	const rows = eventRows(who, at, changes);
	return Array.from(
		{ length: Math.ceil(rows.length / ROWS_PER_INSERT) },
		(_, i) =>
			db
				.insert(events)
				.values(rows.slice(i * ROWS_PER_INSERT, (i + 1) * ROWS_PER_INSERT)),
	);
};

const eventRows = (
	who: Principal,
	at: string,
	changes: Change[],
): (typeof events.$inferInsert)[] =>
	changes.map((c) => ({
		id: newId(),
		entity: c.entity,
		entityId: c.entityId,
		actorId: who.actorId,
		callerId: who.callerId,
		at,
		field: c.field,
		before: encode(c.before),
		after: encode(c.after),
	}));
