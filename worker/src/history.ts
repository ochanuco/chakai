import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "./db/client.ts";
import { callers, events, tasks } from "./db/schema.ts";
import { fail, ok, type Result } from "./result.ts";

export type TaskEvent = {
	id: string;
	at: string;
	actor_id: string;
	caller_id: string | null;
	caller_name: string | null;
	field: string;
	before: unknown;
	after: unknown;
};

const decode = (value: string | null): unknown => {
	if (value === null) return null;
	try {
		return JSON.parse(value);
	} catch {
		return value;
	}
};

/** タスクの履歴を古い順に返す。id は UUID v7 なので、id の順が書いた順になる */
export const listTaskEvents = async (
	db: Db,
	taskId: string,
): Promise<Result<TaskEvent[]>> => {
	const [task] = await db
		.select({ id: tasks.id })
		.from(tasks)
		.where(eq(tasks.id, taskId))
		.limit(1);
	if (!task) return fail(404, "task_not_found", "タスクが無い");
	const rows = await db
		.select({
			id: events.id,
			at: events.at,
			actorId: events.actorId,
			callerId: events.callerId,
			callerName: callers.name,
			field: events.field,
			before: events.before,
			after: events.after,
		})
		.from(events)
		.leftJoin(callers, eq(callers.id, events.callerId))
		.where(and(eq(events.entity, "task"), eq(events.entityId, taskId)))
		.orderBy(asc(events.id));
	return ok(
		rows.map((r) => ({
			id: r.id,
			at: r.at,
			actor_id: r.actorId,
			caller_id: r.callerId,
			caller_name: r.callerName,
			field: r.field,
			before: decode(r.before),
			after: decode(r.after),
		})),
	);
};

// D1 が 1 文で受ける bind は 100 まで
const IDS_PER_QUERY = 90;

export const chunked = <T>(items: T[], size = IDS_PER_QUERY): T[][] =>
	Array.from({ length: Math.ceil(items.length / size) }, (_, i) =>
		items.slice(i * size, (i + 1) * size),
	);

/** いまの review に入った時刻を、タスクごとに返す。最後に state を review にした履歴の時刻 */
export const reviewSince = async (db: Db, taskIds: string[]) => {
	const since = new Map<string, string>();
	for (const ids of chunked(taskIds)) {
		const rows = await db
			.select({ taskId: events.entityId, at: sql<string>`max(${events.at})` })
			.from(events)
			.where(
				and(
					eq(events.entity, "task"),
					eq(events.field, "state"),
					// after は JSON で入っているので、引用符ごと比べる
					eq(events.after, JSON.stringify("review")),
					inArray(events.entityId, ids),
				),
			)
			.groupBy(events.entityId);
		for (const r of rows) since.set(r.taskId, r.at);
	}
	return since;
};
