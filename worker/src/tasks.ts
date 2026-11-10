import {
	and,
	asc,
	desc,
	eq,
	gt,
	inArray,
	isNull,
	lt,
	ne,
	or,
	type SQL,
	sql,
} from "drizzle-orm";
import { generateKeyBetween } from "fractional-indexing";
import { findActor, isOwner, requireOwner } from "./actors.ts";
import type { Principal } from "./auth.ts";
import type { Db } from "./db/client.ts";
import {
	actors,
	events,
	labels,
	TASK_STATES,
	type TaskState,
	taskLabels,
	tasks,
} from "./db/schema.ts";
import { retryOnConflict, writeAll } from "./db/write.ts";
import { type Change, eventInserts } from "./events.ts";
import { newId } from "./id.ts";
import { projectExists } from "./projects.ts";
import {
	checkRelation,
	type Relation,
	type RelationInput,
	relationsOf,
	relationWrites,
} from "./relations.ts";
import { fail, ok, type Result } from "./result.ts";
import { settingFor } from "./settings.ts";

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
	triaged_at: string | null;
	labels: string[];
};

export type TaskWithRelations = Task & { relations: Relation[] };

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
	triaged_at: row.triagedAt,
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

export const getTask = async (
	db: Db,
	id: string,
): Promise<Result<TaskWithRelations>> => {
	const row = await findRow(db, id);
	if (!row) return fail(404, "task_not_found", "タスクが無い");
	return ok({
		...toTask(row, (await labelsOf(db, [id])).get(id) ?? []),
		relations: await relationsOf(db, id),
	});
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
	awaiting_triage?: boolean;
	limit: number;
};

const createdByAgent = (db: Db) =>
	inArray(
		tasks.createdBy,
		db.select({ id: actors.id }).from(actors).where(eq(actors.kind, "agent")),
	);

/** 仕分け待ち: agent が起票し、owner がまだ扱いを決めていない backlog */
const awaitingTriage = (db: Db) =>
	and(eq(tasks.state, "backlog"), isNull(tasks.triagedAt), createdByAgent(db));

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
	if (filter.awaiting_triage) where.push(awaitingTriage(db));
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
	discovered_from?: { task_id: string; run_id?: string };
};

/**
 * start から上へ、agent が作ったタスクが続く数。人が作ったタスクと、席に渡したことのあるタスク
 * （runs に行がある）で止まる。席に渡した親を深さ 0 とするため。
 * 上限を超えたかどうかだけが要るので、cap より先は数えない
 */
const agentChainFrom = async (db: Db, start: string, cap: number) => {
	const [row] = await db.all<{ n: number }>(sql`
		WITH RECURSIVE up(parent_id, counted, depth) AS (
			SELECT t.parent_id, ${countedInChain}, 1 FROM tasks t
				JOIN actors a ON a.id = t.created_by WHERE t.id = ${start}
			UNION ALL
			SELECT t.parent_id, ${countedInChain}, up.depth + 1 FROM up
				JOIN tasks t ON t.id = up.parent_id
				JOIN actors a ON a.id = t.created_by
				WHERE up.counted AND up.depth < ${cap}
		)
		SELECT count(*) AS n FROM up WHERE counted`);
	return row?.n ?? 0;
};

const countedInChain = sql`(
	a.kind = 'agent' AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.task_id = t.id)
)`;

/**
 * agent が親の下のタスクを todo にしてよいかを確かめる。
 * self は todo にするタスクで、これから作るタスクなら null（作るタスク自身を 1 と数える）
 */
const checkSelfTodoDepth = async (
	db: Db,
	who: Principal,
	projectId: string,
	parentId: string,
	self: string | null,
): Promise<Result<null>> => {
	if ((await findActor(db, who.actorId))?.kind !== "agent") return ok(null);
	const limit = await settingFor(db, projectId, "max_self_todo_depth");
	const depth = self
		? await agentChainFrom(db, self, limit + 1)
		: 1 + (await agentChainFrom(db, parentId, limit));
	return depth > limit
		? fail(
				400,
				"todo_depth_exceeded",
				`AI が自分で作る todo の深さの上限（${limit}）を超える。backlog で作る（backlog のままにする）か、親を review にして owner の判断を仰ぐ`,
			)
		: ok(null);
};

export const createTask = async (
	db: Db,
	who: Principal,
	input: CreateTaskInput,
): Promise<Result<TaskWithRelations>> => {
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
	if (input.parent_id && input.state === "todo") {
		const depth = await checkSelfTodoDepth(
			db,
			who,
			input.project_id,
			input.parent_id,
			null,
		);
		if (!depth.ok) return depth;
	}
	const discovered: RelationInput | undefined = input.discovered_from && {
		kind: "discovered_from",
		to_task: input.discovered_from.task_id,
		run_id: input.discovered_from.run_id,
	};
	if (discovered) {
		const checked = await checkRelation(db, null, discovered);
		if (!checked.ok) return checked;
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
			triagedAt: null,
		};
		const { idByName, created } = await resolveLabels(db, names);
		const task = toTask(row, names);
		// events は ID の順に読むので、起票の履歴を関係の履歴より先に作る
		const createdEvents = eventInserts(db, who, now, [
			...labelChanges(created),
			{ entity: "task", entityId: row.id, field: "created", after: task },
		]);
		const relation = discovered
			? relationWrites(db, who, now, row.id, discovered)
			: undefined;
		await writeAll(db, [
			...labelWrites(db, created),
			db.insert(tasks).values(row),
			...names.map((name) =>
				db
					.insert(taskLabels)
					.values({ taskId: row.id, labelId: idByName.get(name) ?? "" }),
			),
			...createdEvents,
			...(relation?.statements ?? []),
		]);
		return ok({ ...task, relations: relation ? [relation.relation] : [] });
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

const isAwaitingTriage = async (db: Db, row: TaskRow) =>
	row.state === "backlog" &&
	!row.triagedAt &&
	(await findActor(db, row.createdBy))?.kind === "agent";

export const CHILDREN_SETTLED = "子タスクがすべて片付いた";

/**
 * 子がすべて done か dropped になっていたら、todo か doing の親を review にする文を作る。
 * 子の更新と同じ batch の、子の更新より後に入れる。条件を書き込みの時点の行で確かめるので、
 * 兄弟が同時に片付いても、後から書く側が必ず親を動かす
 */
const parentToReview = (
	db: Db,
	who: Principal,
	at: string,
	parentId: string,
) => {
	const settled = and(
		eq(tasks.id, parentId),
		inArray(tasks.state, ["todo", "doing"]),
		sql`NOT EXISTS (
			SELECT 1 FROM tasks c
			WHERE c.parent_id = ${parentId} AND c.state NOT IN ('done', 'dropped')
		)`,
	);
	const event = (field: string, before: SQL, after: string) =>
		db.insert(events).select(
			db
				.select({
					id: sql<string>`${newId()}`.as("id"),
					entity: sql<string>`'task'`.as("entity"),
					entityId: sql<string>`${tasks.id}`.as("entity_id"),
					actorId: sql<string>`${who.actorId}`.as("actor_id"),
					callerId: sql<string | null>`${who.callerId}`.as("caller_id"),
					at: sql<string>`${at}`.as("at"),
					field: sql<string>`${field}`.as("field"),
					before: sql<string | null>`${before}`.as("before"),
					after: sql<string>`${JSON.stringify(after)}`.as("after"),
				})
				.from(tasks)
				.where(settled),
		);
	return [
		// 親を動かす前の行から before を取るので、events を先に書く
		event("state", sql`json_quote(${tasks.state})`, "review"),
		event("waiting_on", sql`NULL`, CHILDREN_SETTLED),
		db
			.update(tasks)
			.set({
				state: "review",
				waitingOn: CHILDREN_SETTLED,
				revision: sql`${tasks.revision} + 1`,
				updatedAt: at,
			})
			.where(settled),
	];
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
		// backlog で作ってから todo に上げても、起票のときと同じ上限に掛かる
		if (state === "todo" && current.state !== "todo" && current.parentId) {
			const depth = await checkSelfTodoDepth(
				db,
				who,
				current.projectId,
				current.parentId,
				id,
			);
			if (!depth.ok) return depth;
		}
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
		const now = new Date().toISOString();
		// 仕分け待ちのタスクの状態を owner が変えたら、仕分けが済んだとみなす
		const triagedAt =
			state !== current.state &&
			(await isAwaitingTriage(db, current)) &&
			(await isOwner(db, who))
				? now
				: current.triagedAt;
		const title = input.title ?? current.title;
		const body = input.body ?? current.body;
		change("triaged_at", current.triagedAt, triagedAt);
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

		const next: TaskRow = {
			...current,
			triagedAt,
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
			...(current.parentId &&
			state !== current.state &&
			(state === "done" || state === "dropped")
				? parentToReview(db, who, now, current.parentId)
				: []),
		]);
		return ok(toTask(next, nextLabels));
	}, busy);
};

/** backlog のまま残すと決めた仕分け。状態を変える仕分けは updateTask が受ける */
export const triageTask = async (
	db: Db,
	who: Principal,
	id: string,
): Promise<Result<Task>> => {
	const allowed = await requireOwner(db, who);
	if (!allowed.ok) return allowed;

	return retryOnConflict(async () => {
		const current = await findRow(db, id);
		if (!current) return fail(404, "task_not_found", "タスクが無い");
		const names = (await labelsOf(db, [id])).get(id) ?? [];
		if (!(await isAwaitingTriage(db, current))) {
			return current.triagedAt
				? ok(toTask(current, names))
				: fail(400, "not_awaiting_triage", "仕分け待ちのタスクではない");
		}
		const now = new Date().toISOString();
		const next: TaskRow = {
			...current,
			triagedAt: now,
			updatedAt: now,
			revision: current.revision + 1,
		};
		await writeAll(db, [
			db.update(tasks).set(next).where(eq(tasks.id, id)),
			...eventInserts(db, who, now, [
				{ entity: "task", entityId: id, field: "triaged_at", after: now },
			]),
		]);
		return ok(toTask(next, names));
	}, busy);
};

export type NextTask = {
	task: Task | null;
	descendant_states: Record<TaskState, number>;
};

/**
 * 親の子孫のうち、木の順（深さ優先、同じ親の中は order_key の順）で最初の todo を返す。
 * 状態は変えない。todo が無いときに席を解放してよいかを呼ぶ側が決められるよう、子孫の状態の内訳も返す
 */
export const nextTask = async (
	db: Db,
	parentId: string,
): Promise<Result<NextTask>> => {
	if (!(await findRow(db, parentId))) {
		return fail(404, "task_not_found", "タスクが無い");
	}
	const rows = await db.all<{
		id: string;
		parent_id: string;
		state: TaskState;
		order_key: string;
	}>(sql`
		WITH RECURSIVE d(id) AS (
			SELECT id FROM tasks WHERE parent_id = ${parentId}
			UNION ALL
			SELECT t.id FROM tasks t JOIN d ON t.parent_id = d.id
		)
		SELECT t.id, t.parent_id, t.state, t.order_key FROM tasks t JOIN d ON d.id = t.id`);

	const counts = Object.fromEntries(TASK_STATES.map((s) => [s, 0])) as Record<
		TaskState,
		number
	>;
	const children = new Map<string, typeof rows>();
	for (const row of rows) {
		counts[row.state]++;
		children.set(row.parent_id, [...(children.get(row.parent_id) ?? []), row]);
	}
	const firstTodo = (under: string): string | undefined => {
		const siblings = (children.get(under) ?? []).sort((a, b) =>
			a.order_key < b.order_key ? -1 : a.order_key > b.order_key ? 1 : 0,
		);
		for (const row of siblings) {
			const found = row.state === "todo" ? row.id : firstTodo(row.id);
			if (found) return found;
		}
		return undefined;
	};
	const id = firstTodo(parentId);
	const row = id ? await findRow(db, id) : undefined;
	return ok({
		task: row
			? toTask(row, (await labelsOf(db, [row.id])).get(row.id) ?? [])
			: null,
		descendant_states: counts,
	});
};
