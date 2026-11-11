import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import {
	labels,
	projectRepos,
	projects,
	type RelationKind,
	runs,
	type TaskState,
	taskLabels,
	taskRelations,
	tasks,
} from "../db/schema.ts";
import { chunked, reviewSince } from "../history.ts";
import { type Link, linksOf } from "../links.ts";
import { relationsOf } from "../relations.ts";
import { listRuns, type Run } from "../runs.ts";
import { type Settings, settingsOfScopes } from "../settings.ts";
import { awaitingTriage } from "../tasks.ts";

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

export const countTriage = async (db: Db) =>
	(
		await db
			.select({ count: sql<number>`count(*)` })
			.from(tasks)
			.where(awaitingTriage(db))
	)[0]?.count ?? 0;

export type TriageRow = TaskRow & {
	/** どのタスクの作業中に見つけたか。席は、見つけた run が分かるときだけ */
	discoveredFrom: { id: string; title: string; seat: string | null }[];
};

/** 仕分け待ちのタスクを、起票の古い順にすべて返す */
export const loadTriage = async (db: Db): Promise<TriageRow[]> => {
	const rows = await db
		.select()
		.from(tasks)
		.where(awaitingTriage(db))
		.orderBy(asc(tasks.createdAt), asc(tasks.id));
	const ids = rows.map((r) => r.id);
	const found = new Map<string, TriageRow["discoveredFrom"]>();
	for (const chunk of chunked(ids)) {
		const origins = await db
			.select({
				from: taskRelations.fromTask,
				id: tasks.id,
				title: tasks.title,
				seat: runs.seat,
			})
			.from(taskRelations)
			.innerJoin(tasks, eq(tasks.id, taskRelations.toTask))
			.leftJoin(runs, eq(runs.id, taskRelations.runId))
			.where(
				and(
					eq(taskRelations.kind, "discovered_from"),
					inArray(taskRelations.fromTask, chunk),
				),
			)
			.orderBy(asc(taskRelations.createdAt), asc(taskRelations.toTask));
		for (const { from, ...origin } of origins) {
			found.set(from, [...(found.get(from) ?? []), origin]);
		}
	}
	return withLabels(rows, await labelPairs(db, ids)).map((r) => ({
		...r,
		discoveredFrom: found.get(r.id) ?? [],
	}));
};

export type SettingsView = {
	global: Settings;
	projects: { project: ProjectRow; settings: Settings }[];
};

export const loadSettings = async (db: Db): Promise<SettingsView> => {
	const all = await loadProjects(db);
	const resolved = await settingsOfScopes(
		db,
		all.map((p) => p.id),
	);
	const byScope = new Map(resolved.projects.map((s) => [s.scope, s]));
	return {
		global: resolved.global,
		projects: all.flatMap((project) => {
			const settings = byScope.get(project.id);
			return settings ? [{ project, settings }] : [];
		}),
	};
};

export type ProjectView = {
	project: ProjectRow;
	repos: string[];
	tasks: TaskRow[];
	links: Link[];
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
	const [repos, rows, pairs, linked] = await Promise.all([
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
		linksOf(db, "project", [projectId]),
	]);
	return {
		project,
		repos: repos.map((r) => r.repo),
		tasks: withLabels(rows, pairs),
		links: linked.get(projectId) ?? [],
	};
};

export type TaskView = {
	task: TaskRow;
	project: ProjectRow;
	/** 根から親までの順 */
	ancestors: { id: string; title: string }[];
	children: TaskRow[];
	reviewSince: string | null;
	relations: RelatedTask[];
	runs: Run[];
	links: Link[];
};

export type RelatedTask = {
	kind: RelationKind;
	/** このタスクが from_task の側か */
	outgoing: boolean;
	task: { id: string; title: string; state: TaskState };
	seat: string | null;
};

const loadRelations = async (db: Db, taskId: string) => {
	const relations = await relationsOf(db, taskId);
	const other = (r: (typeof relations)[number]) =>
		r.from_task === taskId ? r.to_task : r.from_task;
	const byId = new Map<string, RelatedTask["task"]>();
	for (const ids of chunked([...new Set(relations.map(other))])) {
		for (const t of await db
			.select({ id: tasks.id, title: tasks.title, state: tasks.state })
			.from(tasks)
			.where(inArray(tasks.id, ids))) {
			byId.set(t.id, t);
		}
	}
	const seats = new Map<string, string>();
	const runIds = relations.flatMap((r) => (r.run_id ? [r.run_id] : []));
	for (const ids of chunked([...new Set(runIds)])) {
		for (const r of await db
			.select({ id: runs.id, seat: runs.seat })
			.from(runs)
			.where(inArray(runs.id, ids))) {
			seats.set(r.id, r.seat);
		}
	}
	return relations.flatMap((r): RelatedTask[] => {
		const task = byId.get(other(r));
		if (!task) return [];
		return [
			{
				kind: r.kind,
				outgoing: r.from_task === taskId,
				task,
				seat: (r.run_id && seats.get(r.run_id)) || null,
			},
		];
	});
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
	const [relations, ran, linked] = await Promise.all([
		loadRelations(db, taskId),
		listRuns(db, taskId),
		linksOf(db, "task", [taskId]),
	]);
	return {
		task,
		project,
		ancestors,
		children,
		relations,
		runs: ran.ok ? ran.value : [],
		links: linked.get(taskId) ?? [],
		reviewSince:
			row.state === "review"
				? ((await reviewSince(db, [row.id])).get(row.id) ?? null)
				: null,
	};
};
