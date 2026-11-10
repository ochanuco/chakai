import { and, eq, isNull } from "drizzle-orm";
import type { Principal } from "./auth.ts";
import type { Db } from "./db/client.ts";
import { projectRepos, runs, tasks } from "./db/schema.ts";
import { writeAll } from "./db/write.ts";
import { eventInserts } from "./events.ts";
import { newId } from "./id.ts";
import { fail, ok, type Result } from "./result.ts";

export type Run = {
	id: string;
	task_id: string;
	actor_id: string;
	seat: string;
	model: string | null;
	hishaku_no: number | null;
	started_at: string;
	ended_at: string | null;
};

type RunRow = typeof runs.$inferSelect;

const toRun = (row: RunRow): Run => ({
	id: row.id,
	task_id: row.taskId,
	actor_id: row.actorId,
	seat: row.seat,
	model: row.model,
	hishaku_no: row.hishakuNo,
	started_at: row.startedAt,
	ended_at: row.endedAt,
});

export const runExists = async (db: Db, id: string) =>
	(await db.select({ id: runs.id }).from(runs).where(eq(runs.id, id)).limit(1))
		.length > 0;

export type StartRunInput = {
	task_id: string;
	seat: string;
	model?: string;
	hishaku_no?: number;
};

export const startRun = async (
	db: Db,
	who: Principal,
	input: StartRunInput,
): Promise<Result<Run>> => {
	const [task] = await db
		.select({ projectId: tasks.projectId })
		.from(tasks)
		.where(eq(tasks.id, input.task_id))
		.limit(1);
	if (!task) return fail(404, "task_not_found", "タスクが無い");
	const [repo] = await db
		.select({ repo: projectRepos.repo })
		.from(projectRepos)
		.where(eq(projectRepos.projectId, task.projectId))
		.limit(1);
	if (!repo) {
		return fail(
			400,
			"repo_required",
			"repo の無いプロジェクトのタスクは席に渡せない。先に repo を紐付ける",
		);
	}
	const row: RunRow = {
		id: newId(),
		taskId: input.task_id,
		actorId: who.actorId,
		seat: input.seat,
		model: input.model ?? null,
		hishakuNo: input.hishaku_no ?? null,
		startedAt: new Date().toISOString(),
		endedAt: null,
	};
	const run = toRun(row);
	await writeAll(db, [
		db.insert(runs).values(row),
		...eventInserts(db, who, row.startedAt, [
			{ entity: "run", entityId: row.id, field: "started", after: run },
		]),
	]);
	return ok(run);
};

/** 閉じた run をもう一度閉じても、最初に閉じた時刻のまま返す */
export const endRun = async (
	db: Db,
	who: Principal,
	id: string,
): Promise<Result<Run>> => {
	const [current] = await db
		.select()
		.from(runs)
		.where(eq(runs.id, id))
		.limit(1);
	if (!current) return fail(404, "run_not_found", "run が無い");
	if (current.endedAt) return ok(toRun(current));

	const now = new Date().toISOString();
	await writeAll(db, [
		db
			.update(runs)
			.set({ endedAt: now })
			.where(and(eq(runs.id, id), isNull(runs.endedAt))),
		...eventInserts(db, who, now, [
			{ entity: "run", entityId: id, field: "ended_at", after: now },
		]),
	]);
	return ok(toRun({ ...current, endedAt: now }));
};
