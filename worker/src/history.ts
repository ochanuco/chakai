import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "./db/client.ts";
import {
	callers,
	events,
	TASK_STATES,
	type TaskState,
	tasks,
} from "./db/schema.ts";
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

/** いまの review に入った時刻と、入る前の状態と、review にした actor を、タスクごとに返す。最後に state を review にした履歴から取る */
export const reviewSince = async (db: Db, taskIds: string[]) => {
	const since = new Map<
		string,
		{ at: string; from: TaskState | null; by: string }
	>();
	for (const ids of chunked(taskIds)) {
		// SQLite は max() と並べた列を、max の行の値で返す
		const rows = await db
			.select({
				taskId: events.entityId,
				at: sql<string>`max(${events.at})`,
				before: events.before,
				by: events.actorId,
			})
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
		for (const r of rows) {
			since.set(r.taskId, {
				at: r.at,
				from: asState(decode(r.before)),
				by: r.by,
			});
		}
	}
	return since;
};

const asState = (value: unknown): TaskState | null =>
	TASK_STATES.includes(value as TaskState) ? (value as TaskState) : null;

/** 最後の review の問いと、review を出たときの判断 */
export type LastReview = {
	/** review の前の状態 */
	from: TaskState | null;
	question: string | null;
	asked_by: string;
	asked_at: string;
	/** review を出た先。まだ review なら null */
	to: TaskState | null;
	answer: string | null;
	answered_by: string | null;
	answered_at: string | null;
};

/**
 * タスクの最後の review を、履歴から組み立てる。review に入る・出る更新と、
 * それに添えた waiting_on と note は同じ batch で書くので、同じ at の行をまとめて読む
 */
export const lastReview = async (
	db: Db,
	taskId: string,
): Promise<LastReview | null> => {
	const rows = await db
		.select({
			at: events.at,
			actorId: events.actorId,
			field: events.field,
			before: events.before,
			after: events.after,
		})
		.from(events)
		.where(
			and(
				eq(events.entity, "task"),
				eq(events.entityId, taskId),
				inArray(events.field, ["state", "waiting_on", "note"]),
			),
		)
		.orderBy(asc(events.id));
	const byAt = new Map<string, typeof rows>();
	for (const r of rows) byAt.set(r.at, [...(byAt.get(r.at) ?? []), r]);

	let review: LastReview | null = null;
	for (const [at, group] of byAt) {
		const state = group.find((r) => r.field === "state");
		const before = asState(decode(state?.before ?? null));
		const after = asState(decode(state?.after ?? null));
		if (state && after === "review") {
			review = {
				from: before,
				question: null,
				asked_by: state.actorId,
				asked_at: at,
				to: null,
				answer: null,
				answered_by: null,
				answered_at: null,
			};
		}
		if (!review || review.answered_at) continue;
		const waiting = decode(
			group.find((r) => r.field === "waiting_on")?.after ?? null,
		);
		if (typeof waiting === "string") review.question = waiting;
		if (state && before === "review") {
			const note = decode(group.find((r) => r.field === "note")?.after ?? null);
			review.to = after;
			review.answer = typeof note === "string" ? note : null;
			review.answered_by = state.actorId;
			review.answered_at = at;
		}
	}
	return review;
};
