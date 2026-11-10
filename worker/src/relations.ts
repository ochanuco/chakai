import { and, eq, or } from "drizzle-orm";
import type { Principal } from "./auth.ts";
import type { Db } from "./db/client.ts";
import { type RelationKind, taskRelations, tasks } from "./db/schema.ts";
import { writeAll } from "./db/write.ts";
import { eventInserts } from "./events.ts";
import { fail, ok, type Result } from "./result.ts";
import { runExists } from "./runs.ts";

export type Relation = {
	from_task: string;
	kind: RelationKind;
	to_task: string;
	run_id: string | null;
	created_by: string;
	created_at: string;
};

type RelationRow = typeof taskRelations.$inferSelect;

const toRelation = (row: RelationRow): Relation => ({
	from_task: row.fromTask,
	kind: row.kind,
	to_task: row.toTask,
	run_id: row.runId,
	created_by: row.createdBy,
	created_at: row.createdAt,
});

/** タスクが from か to に出てくる関係。古いタスクからも新しいタスクからも辿れるよう、両向きを返す */
export const relationsOf = async (db: Db, taskId: string) =>
	(
		await db
			.select()
			.from(taskRelations)
			.where(
				or(
					eq(taskRelations.fromTask, taskId),
					eq(taskRelations.toTask, taskId),
				),
			)
			.orderBy(
				taskRelations.createdAt,
				taskRelations.fromTask,
				taskRelations.kind,
				taskRelations.toTask,
			)
	).map(toRelation);

export type RelationInput = {
	kind: RelationKind;
	to_task: string;
	run_id?: string;
};

const taskExists = async (db: Db, id: string) =>
	(
		await db
			.select({ id: tasks.id })
			.from(tasks)
			.where(eq(tasks.id, id))
			.limit(1)
	).length > 0;

/** 関係の相手と run を確かめる。from のタスクは、呼ぶ側が確かめる */
export const checkRelation = async (
	db: Db,
	fromTask: string | null,
	input: RelationInput,
): Promise<Result<null>> => {
	if (input.to_task === fromTask) {
		return fail(400, "self_relation", "タスクを自分自身にはつなげない");
	}
	if (!(await taskExists(db, input.to_task))) {
		return fail(400, "unknown_task", "つなぐ相手のタスクが無い");
	}
	if (input.run_id !== undefined) {
		if (input.kind !== "discovered_from") {
			return fail(
				400,
				"run_only_with_discovered_from",
				"run_id は discovered_from にだけ付けられる",
			);
		}
		if (!(await runExists(db, input.run_id))) {
			return fail(400, "unknown_run", "run が無い");
		}
	}
	return ok(null);
};

/** 関係の行と、from のタスクの履歴に残す文を作る */
export const relationWrites = (
	db: Db,
	who: Principal,
	at: string,
	fromTask: string,
	input: RelationInput,
) => {
	const row: RelationRow = {
		fromTask,
		kind: input.kind,
		toTask: input.to_task,
		runId: input.run_id ?? null,
		createdBy: who.actorId,
		createdAt: at,
	};
	return {
		relation: toRelation(row),
		statements: [
			db.insert(taskRelations).values(row),
			...eventInserts(db, who, at, [
				{
					entity: "task",
					entityId: fromTask,
					field: "relation",
					after: { kind: row.kind, to_task: row.toTask, run_id: row.runId },
				},
			]),
		],
	};
};

/** もうある関係をもう一度付けても、最初の行のまま返す */
export const relateTasks = async (
	db: Db,
	who: Principal,
	fromTask: string,
	input: RelationInput,
): Promise<Result<Relation>> => {
	if (!(await taskExists(db, fromTask))) {
		return fail(404, "task_not_found", "タスクが無い");
	}
	const checked = await checkRelation(db, fromTask, input);
	if (!checked.ok) return checked;

	const [existing] = await db
		.select()
		.from(taskRelations)
		.where(
			and(
				eq(taskRelations.fromTask, fromTask),
				eq(taskRelations.kind, input.kind),
				eq(taskRelations.toTask, input.to_task),
			),
		)
		.limit(1);
	if (existing) return ok(toRelation(existing));

	const { relation, statements } = relationWrites(
		db,
		who,
		new Date().toISOString(),
		fromTask,
		input,
	);
	await writeAll(db, statements);
	return ok(relation);
};
