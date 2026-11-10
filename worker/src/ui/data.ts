import { asc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import {
	labels,
	projectRepos,
	projects,
	type TaskState,
	taskLabels,
	tasks,
} from "../db/schema.ts";
import { chunked, reviewSince } from "../history.ts";

export type TaskRow = typeof tasks.$inferSelect & { labels: string[] };
export type ProjectRow = typeof projects.$inferSelect;

const withLabels = (
	rows: (typeof tasks.$inferSelect)[],
	pairs: { taskId: string; name: string }[],
): TaskRow[] => {
	const byTask = new Map<string, string[]>();
	for (const p of pairs) {
		byTask.set(p.taskId, [...(byTask.get(p.taskId) ?? []), p.name]);
	}
	return rows.map((r) => ({ ...r, labels: byTask.get(r.id) ?? [] }));
};

const labelPairs = async (db: Db, taskIds: string[]) => {
	const pairs: { taskId: string; name: string }[] = [];
	for (const ids of chunked(taskIds)) {
		pairs.push(
			...(await db
				.select({ taskId: taskLabels.taskId, name: labels.name })
				.from(taskLabels)
				.innerJoin(labels, eq(labels.id, taskLabels.labelId))
				.where(inArray(taskLabels.taskId, ids))
				.orderBy(asc(labels.name))),
		);
	}
	return pairs;
};

export const loadProjects = async (db: Db) =>
	db.select().from(projects).orderBy(asc(projects.name), asc(projects.id));

export type StateCounts = Partial<Record<TaskState, number>>;

export const loadStateCounts = async (db: Db) => {
	const rows = await db
		.select({
			projectId: tasks.projectId,
			state: tasks.state,
			count: sql<number>`count(*)`,
		})
		.from(tasks)
		.groupBy(tasks.projectId, tasks.state);
	const byProject = new Map<string, StateCounts>();
	for (const r of rows) {
		byProject.set(r.projectId, {
			...byProject.get(r.projectId),
			[r.state]: r.count,
		});
	}
	return byProject;
};

export type ReviewRow = TaskRow & { since: string };

/** owner の番のタスクを、待たせている時間の長い順に返す */
export const loadReviews = async (db: Db): Promise<ReviewRow[]> => {
	const rows = await db.select().from(tasks).where(eq(tasks.state, "review"));
	const ids = rows.map((r) => r.id);
	const since = await reviewSince(db, ids);
	return withLabels(rows, await labelPairs(db, ids))
		.map((r) => ({ ...r, since: since.get(r.id) ?? r.updatedAt }))
		.sort((a, b) => (a.since < b.since ? -1 : a.since > b.since ? 1 : 0));
};

export type ProjectView = {
	project: ProjectRow;
	repos: string[];
	tasks: TaskRow[];
};

/** プロジェクトのタスクを、並び順にすべて返す。ツリーを途中で切らないよう、件数は絞らない */
export const loadProject = async (
	db: Db,
	projectId: string,
): Promise<ProjectView | null> => {
	const [project] = await db
		.select()
		.from(projects)
		.where(eq(projects.id, projectId))
		.limit(1);
	if (!project) return null;
	const [repos, rows, pairs] = await Promise.all([
		db
			.select({ repo: projectRepos.repo })
			.from(projectRepos)
			.where(eq(projectRepos.projectId, projectId))
			.orderBy(asc(projectRepos.repo)),
		db
			.select()
			.from(tasks)
			.where(eq(tasks.projectId, projectId))
			.orderBy(asc(tasks.orderKey)),
		db
			.select({ taskId: taskLabels.taskId, name: labels.name })
			.from(taskLabels)
			.innerJoin(labels, eq(labels.id, taskLabels.labelId))
			.innerJoin(tasks, eq(tasks.id, taskLabels.taskId))
			.where(eq(tasks.projectId, projectId))
			.orderBy(asc(labels.name)),
	]);
	return {
		project,
		repos: repos.map((r) => r.repo),
		tasks: withLabels(rows, pairs),
	};
};

export type TaskView = {
	task: TaskRow;
	project: ProjectRow;
	/** 根から親までの順 */
	ancestors: { id: string; title: string }[];
	children: TaskRow[];
	reviewSince: string | null;
};

export const loadTask = async (
	db: Db,
	taskId: string,
): Promise<TaskView | null> => {
	const [row] = await db
		.select()
		.from(tasks)
		.where(eq(tasks.id, taskId))
		.limit(1);
	if (!row) return null;
	const [project] = await db
		.select()
		.from(projects)
		.where(eq(projects.id, row.projectId))
		.limit(1);
	if (!project) return null;

	const ancestors: { id: string; title: string }[] = [];
	const seen = new Set([row.id]);
	let parentId = row.parentId;
	// 親が自分に戻る輪があっても止まるようにする
	while (parentId && !seen.has(parentId)) {
		seen.add(parentId);
		const [parent] = await db
			.select({ id: tasks.id, title: tasks.title, parentId: tasks.parentId })
			.from(tasks)
			.where(eq(tasks.id, parentId))
			.limit(1);
		if (!parent) break;
		ancestors.unshift({ id: parent.id, title: parent.title });
		parentId = parent.parentId;
	}

	const childRows = await db
		.select()
		.from(tasks)
		.where(eq(tasks.parentId, taskId))
		.orderBy(asc(tasks.orderKey));
	const [task, ...children] = withLabels(
		[row, ...childRows],
		await labelPairs(db, [row.id, ...childRows.map((c) => c.id)]),
	);
	if (!task) return null;
	return {
		task,
		project,
		ancestors,
		children,
		reviewSince:
			row.state === "review"
				? ((await reviewSince(db, [row.id])).get(row.id) ?? null)
				: null,
	};
};
