import {
	and,
	asc,
	desc,
	eq,
	gt,
	inArray,
	lt,
	ne,
	or,
	type SQL,
	sql,
} from "drizzle-orm";
import { generateKeyBetween } from "fractional-indexing";
import type { Principal } from "./auth.ts";
import type { Db } from "./db/client.ts";
import {
	actors,
	labels,
	type TaskState,
	taskLabels,
	tasks,
} from "./db/schema.ts";
import { retryOnConflict, writeAll } from "./db/write.ts";
import { type Change, eventInserts } from "./events.ts";
import { newId } from "./id.ts";
import { projectExists } from "./projects.ts";
import { fail, ok, type Result } from "./result.ts";

export type Task = {
	id: string;
	project_id: string;
	parent_id: string | null;
	title: string;
	body: string;
	state: TaskState;
	assignee_id: string | null;
	order_key: string;
	waiting_on: string | null;
	created_by: string;
	created_at: string;
	updated_at: string;
	labels: string[];
};

type TaskRow = typeof tasks.$inferSelect;

const toTask = (row: TaskRow, labelNames: string[]): Task => ({
	id: row.id,
	project_id: row.projectId,
	parent_id: row.parentId,
	title: row.title,
	body: row.body,
	state: row.state,
	assignee_id: row.assigneeId,
	order_key: row.orderKey,
	waiting_on: row.waitingOn,
	created_by: row.createdBy,
	created_at: row.createdAt,
	updated_at: row.updatedAt,
	labels: labelNames,
});

const labelsOf = async (db: Db, taskIds: string[]) => {
	const byTask = new Map<string, string[]>();
	if (taskIds.length === 0) return byTask;
	const rows = await db
		.select({ taskId: taskLabels.taskId, name: labels.name })
		.from(taskLabels)
		.innerJoin(labels, eq(labels.id, taskLabels.labelId))
		.where(inArray(taskLabels.taskId, taskIds))
		.orderBy(asc(labels.name));
	for (const r of rows) {
		byTask.set(r.taskId, [...(byTask.get(r.taskId) ?? []), r.name]);
	}
	return byTask;
};

const findRow = async (db: Db, id: string) =>
	(await db.select().from(tasks).where(eq(tasks.id, id)).limit(1))[0];

export const getTask = async (db: Db, id: string): Promise<Result<Task>> => {
	const row = await findRow(db, id);
	if (!row) return fail(404, "task_not_found", "タスクが無い");
	return ok(toTask(row, (await labelsOf(db, [id])).get(id) ?? []));
};

// D1 が 1 文で受ける bind の数（100）に、ラベルを引く inArray が収まる件数にする
export const SEARCH_MAX_LIMIT = 90;
export const SEARCH_DEFAULT_LIMIT = 50;

export type TaskFilter = {
	project_id?: string;
	q?: string;
	state?: TaskState[];
	assignee_id?: string;
	parent_id?: string;
	label?: string;
	limit: number;
};

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export const searchTasks = async (
	db: Db,
	filter: TaskFilter,
): Promise<Task[]> => {
	const where: (SQL | undefined)[] = [];
	if (filter.project_id) where.push(eq(tasks.projectId, filter.project_id));
	if (filter.q) {
		// SQLite の LIKE には既定の escape 文字が無いので、明示しないと _ や % を含む語を探せない
		const pattern = `%${escapeLike(filter.q)}%`;
		where.push(
			or(
				sql`${tasks.title} LIKE ${pattern} ESCAPE '\\'`,
				sql`${tasks.body} LIKE ${pattern} ESCAPE '\\'`,
			),
		);
	}
	if (filter.state?.length) where.push(inArray(tasks.state, filter.state));
	if (filter.assignee_id) where.push(eq(tasks.assigneeId, filter.assignee_id));
	if (filter.parent_id) where.push(eq(tasks.parentId, filter.parent_id));
	if (filter.label) {
		where.push(
			inArray(
				tasks.id,
				db
					.select({ id: taskLabels.taskId })
					.from(taskLabels)
					.innerJoin(labels, eq(labels.id, taskLabels.labelId))
					.where(eq(labels.name, filter.label)),
			),
		);
	}
	const rows = await db
		.select()
		.from(tasks)
		.where(and(...where))
		.orderBy(asc(tasks.projectId), asc(tasks.orderKey))
		.limit(filter.limit);
	const names = await labelsOf(
		db,
		rows.map((r) => r.id),
	);
	return rows.map((r) => toTask(r, names.get(r.id) ?? []));
};

const actorIsActive = async (db: Db, id: string) =>
	(
		await db
			.select({ id: actors.id })
			.from(actors)
			.where(and(eq(actors.id, id), eq(actors.active, true)))
			.limit(1)
	).length > 0;

const uniqueNames = (names: string[]) => [...new Set(names)].sort();

/** 名前からラベルを引き、無いものは作る行を返す。ラベルは全体で 1 つのタグなので、名前で共有する */
const resolveLabels = async (db: Db, names: string[]) => {
	const existing =
		names.length === 0
			? []
			: await db.select().from(labels).where(inArray(labels.name, names));
	const idByName = new Map(existing.map((l) => [l.name, l.id]));
	const created = names
		.filter((name) => !idByName.has(name))
		.map((name) => ({ id: newId(), name }));
	for (const l of created) idByName.set(l.name, l.id);
	return { idByName, created };
};

const labelWrites = (db: Db, created: { id: string; name: string }[]) =>
	created.length === 0 ? [] : [db.insert(labels).values(created)];

const labelChanges = (created: { id: string; name: string }[]): Change[] =>
	created.map((l) => ({
		entity: "label",
		entityId: l.id,
		field: "created",
		after: { id: l.id, name: l.name },
	}));

const busy = () =>
	fail(409, "conflict", "他の書き込みと重なった。もう一度試す");

export type CreateTaskInput = {
	project_id: string;
	title: string;
	body: string;
	parent_id?: string;
	state: "backlog" | "todo";
	assignee_id?: string;
	labels: string[];
};

export const createTask = async (
	db: Db,
	who: Principal,
	input: CreateTaskInput,
): Promise<Result<Task>> => {
	if (!(await projectExists(db, input.project_id))) {
		return fail(404, "project_not_found", "プロジェクトが無い");
	}
	if (input.parent_id) {
		const parent = await findRow(db, input.parent_id);
		if (!parent || parent.projectId !== input.project_id) {
			return fail(400, "unknown_parent", "親タスクが同じプロジェクトに無い");
		}
	}
	if (input.assignee_id && !(await actorIsActive(db, input.assignee_id))) {
		return fail(400, "unknown_assignee", "担当にする actor が名簿に無い");
	}
	const names = uniqueNames(input.labels);

	return retryOnConflict(async () => {
		const [last] = await db
			.select({ orderKey: tasks.orderKey })
			.from(tasks)
			.where(eq(tasks.projectId, input.project_id))
			.orderBy(desc(tasks.orderKey))
			.limit(1);
		const now = new Date().toISOString();
		const row: TaskRow = {
			id: newId(),
			projectId: input.project_id,
			parentId: input.parent_id ?? null,
			title: input.title,
			body: input.body,
			state: input.state,
			assigneeId: input.assignee_id ?? null,
			orderKey: generateKeyBetween(last?.orderKey ?? null, null),
			waitingOn: null,
			revision: 0,
			createdBy: who.actorId,
			createdAt: now,
			updatedAt: now,
		};
		const { idByName, created } = await resolveLabels(db, names);
		const task = toTask(row, names);
		await writeAll(db, [
			...labelWrites(db, created),
			db.insert(tasks).values(row),
			...names.map((name) =>
				db
					.insert(taskLabels)
					.values({ taskId: row.id, labelId: idByName.get(name) ?? "" }),
			),
			...eventInserts(db, who, now, [
				...labelChanges(created),
				{ entity: "task", entityId: row.id, field: "created", after: task },
			]),
		]);
		return ok(task);
	}, busy);
};

export type UpdateTaskInput = {
	title?: string;
	body?: string;
	state?: TaskState;
	waiting_on?: string | null;
	assignee_id?: string | null;
	labels?: string[];
	order?: { before: string } | { after: string };
};

/** 並べる相手の隣に入る order_key を作る。動かすタスク自身は隣として数えない */
const keyBeside = async (
	db: Db,
	self: TaskRow,
	order: NonNullable<UpdateTaskInput["order"]>,
): Promise<Result<string>> => {
	const anchorId = "after" in order ? order.after : order.before;
	const anchor = anchorId === self.id ? undefined : await findRow(db, anchorId);
	if (!anchor || anchor.projectId !== self.projectId) {
		return fail(
			400,
			"unknown_order_anchor",
			"並べる相手のタスクが同じプロジェクトに無い",
		);
	}
	const inProject = and(
		eq(tasks.projectId, self.projectId),
		ne(tasks.id, self.id),
	);
	if ("after" in order) {
		const [next] = await db
			.select({ orderKey: tasks.orderKey })
			.from(tasks)
			.where(and(inProject, gt(tasks.orderKey, anchor.orderKey)))
			.orderBy(asc(tasks.orderKey))
			.limit(1);
		return ok(generateKeyBetween(anchor.orderKey, next?.orderKey ?? null));
	}
	const [prev] = await db
		.select({ orderKey: tasks.orderKey })
		.from(tasks)
		.where(and(inProject, lt(tasks.orderKey, anchor.orderKey)))
		.orderBy(desc(tasks.orderKey))
		.limit(1);
	return ok(generateKeyBetween(prev?.orderKey ?? null, anchor.orderKey));
};

export const updateTask = async (
	db: Db,
	who: Principal,
	id: string,
	input: UpdateTaskInput,
): Promise<Result<Task>> => {
	if (input.assignee_id && !(await actorIsActive(db, input.assignee_id))) {
		return fail(400, "unknown_assignee", "担当にする actor が名簿に無い");
	}

	return retryOnConflict(async () => {
		const current = await findRow(db, id);
		if (!current) return fail(404, "task_not_found", "タスクが無い");
		const currentLabels = (await labelsOf(db, [id])).get(id) ?? [];

		const state = input.state ?? current.state;
		let waitingOn: string | null;
		if (state === "review") {
			waitingOn =
				input.waiting_on !== undefined ? input.waiting_on : current.waitingOn;
			if (!waitingOn) {
				return fail(
					400,
					"waiting_on_required",
					"review にするときは waiting_on に owner へ仰ぐ内容を書く",
				);
			}
		} else {
			if (input.waiting_on) {
				return fail(
					400,
					"waiting_on_only_in_review",
					"waiting_on は review のタスクにだけ付けられる",
				);
			}
			// review は owner の番を表すので、番が終われば理由も残さない
			waitingOn = null;
		}

		let orderKey = current.orderKey;
		if (input.order) {
			const key = await keyBeside(db, current, input.order);
			if (!key.ok) return key;
			orderKey = key.value;
		}
		const assigneeId =
			input.assignee_id !== undefined ? input.assignee_id : current.assigneeId;
		const nextLabels =
			input.labels !== undefined ? uniqueNames(input.labels) : currentLabels;

		const changes: Change[] = [];
		const change = (field: string, before: unknown, after: unknown) => {
			if (before !== after) {
				changes.push({ entity: "task", entityId: id, field, before, after });
			}
		};
		const title = input.title ?? current.title;
		const body = input.body ?? current.body;
		change("title", current.title, title);
		change("body", current.body, body);
		change("state", current.state, state);
		change("waiting_on", current.waitingOn, waitingOn);
		change("assignee_id", current.assigneeId, assigneeId);
		change("order_key", current.orderKey, orderKey);
		const labelsChanged =
			nextLabels.length !== currentLabels.length ||
			nextLabels.some((name, i) => name !== currentLabels[i]);
		if (labelsChanged) {
			changes.push({
				entity: "task",
				entityId: id,
				field: "labels",
				before: currentLabels,
				after: nextLabels,
			});
		}
		if (changes.length === 0) return ok(toTask(current, currentLabels));

		const now = new Date().toISOString();
		const next: TaskRow = {
			...current,
			title,
			body,
			state,
			waitingOn,
			assigneeId,
			orderKey,
			updatedAt: now,
			revision: current.revision + 1,
		};
		const { idByName, created } = labelsChanged
			? await resolveLabels(db, nextLabels)
			: { idByName: new Map<string, string>(), created: [] };
		await writeAll(db, [
			...labelWrites(db, created),
			// 読んだ後に他の更新が入っていたら、trigger が revision の飛びを見つけて batch ごと取り消す。
			// events の before が、実際の直前の値とずれないようにするため
			db.update(tasks).set(next).where(eq(tasks.id, id)),
			...(labelsChanged
				? [
						db.delete(taskLabels).where(eq(taskLabels.taskId, id)),
						...nextLabels.map((name) =>
							db
								.insert(taskLabels)
								.values({ taskId: id, labelId: idByName.get(name) ?? "" }),
						),
					]
				: []),
			...eventInserts(db, who, now, [...labelChanges(created), ...changes]),
		]);
		return ok(toTask(next, nextLabels));
	}, busy);
};
