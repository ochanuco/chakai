import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import {
	type As,
	call,
	eventsOf,
	MAC,
	mac,
	newProject,
	newTask,
	owner,
	type RelationJson,
	seedRoster,
	type TaskJson,
	WORKING,
	working,
} from "./helpers.ts";

beforeAll(seedRoster);

const yukarin = working("yukarin");
const akarin = working("akarin");

const patch = (id: string, body: unknown, as: As = owner) =>
	call(as, "PATCH", `/v1/tasks/${id}`, body);

const read = async (id: string) =>
	(await call(owner, "GET", `/v1/tasks/${id}`)).json<
		TaskJson & { relations: RelationJson[] }
	>();

const projectWithRepo = async () => {
	const project = await newProject();
	await call(owner, "POST", `/v1/projects/${project.id}/repos`, {
		repo: "example/app",
	});
	return project;
};

type RunJson = {
	id: string;
	task_id: string;
	actor_id: string;
	seat: string;
	model: string | null;
	hishaku_no: number | null;
	started_at: string;
	ended_at: string | null;
};

const startRun = async (taskId: string, as: As = yukarin) => {
	const res = await call(as, "POST", "/v1/runs", {
		task_id: taskId,
		seat: "seat-1",
		model: "model-x",
		hishaku_no: 1234,
	});
	expect(res.status).toBe(201);
	return res.json<RunJson>();
};

describe("実行記録", () => {
	it("start_run は actor と呼び出し元を認証から取り、end_run で閉じる", async () => {
		const project = await projectWithRepo();
		const parent = await newTask(project.id, { state: "todo" });
		const run = await startRun(parent.id);
		expect(run).toMatchObject({
			task_id: parent.id,
			actor_id: "yukarin",
			seat: "seat-1",
			model: "model-x",
			hishaku_no: 1234,
			ended_at: null,
		});

		const ended = await call(yukarin, "POST", `/v1/runs/${run.id}/end`);
		const closed = await ended.json<RunJson>();
		expect(closed.ended_at).not.toBeNull();
		const again = await call(yukarin, "POST", `/v1/runs/${run.id}/end`);
		expect((await again.json<RunJson>()).ended_at).toBe(closed.ended_at);

		const events = await eventsOf(run.id);
		expect(
			events.map((e) => [e.entity, e.field, e.actor_id, e.caller_id]),
		).toEqual([
			["run", "started", "yukarin", WORKING.id],
			["run", "ended_at", "yukarin", WORKING.id],
		]);
	});

	it("同時に閉じても、履歴は 1 つで、どちらも残った時刻を返す", async () => {
		const project = await projectWithRepo();
		const parent = await newTask(project.id);
		const run = await startRun(parent.id);
		const results = await Promise.all(
			[yukarin, akarin, yukarin, akarin].map(async (as) =>
				(await call(as, "POST", `/v1/runs/${run.id}/end`)).json<RunJson>(),
			),
		);
		const events = (await eventsOf(run.id)).filter(
			(e) => e.field === "ended_at",
		);
		expect(events).toHaveLength(1);
		const endedAt = JSON.parse(events[0]?.after ?? "null");
		expect(results.map((r) => r.ended_at)).toEqual(Array(4).fill(endedAt));
	});

	it("repo の無いプロジェクトのタスクと、無いタスクは渡せない", async () => {
		const project = await newProject();
		const parent = await newTask(project.id);
		const res = await call(yukarin, "POST", "/v1/runs", {
			task_id: parent.id,
			seat: "seat-1",
		});
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({ error: "repo_required" });

		const missing = await call(yukarin, "POST", "/v1/runs", {
			task_id: "no-such-task",
			seat: "seat-1",
		});
		expect(missing.status).toBe(404);
		expect((await call(yukarin, "POST", "/v1/runs/no-such/end")).status).toBe(
			404,
		);
	});

	it("actor を名乗る入力と、4 桁でない hishaku の番号は受けない", async () => {
		const project = await projectWithRepo();
		const parent = await newTask(project.id);
		for (const extra of [{ actor_id: "akarin" }, { hishaku_no: 12 }]) {
			const res = await call(yukarin, "POST", "/v1/runs", {
				task_id: parent.id,
				seat: "seat-1",
				...extra,
			});
			expect(res.status).toBe(400);
		}
	});
});

describe("next_task", () => {
	const next = async (id: string) => {
		const res = await call(yukarin, "GET", `/v1/tasks/${id}/next`);
		expect(res.status).toBe(200);
		return res.json<{
			task: TaskJson | null;
			descendant_states: Record<string, number>;
		}>();
	};

	it("深さ優先、同じ親の中は order_key の順に todo を返し、状態は変えない", async () => {
		const project = await newProject();
		const parent = await newTask(project.id, { state: "todo" });
		const todo = { parent_id: parent.id, state: "todo" };
		// 起票の順は b、a、c。並びを a、b、c に直す
		const b = await newTask(project.id, todo);
		const a = await newTask(project.id, todo);
		const c = await newTask(project.id, todo);
		await patch(a.id, { order: { before: b.id } });
		// a の孫は、起票が最後でも b より先に来る
		const a1 = await newTask(project.id, { parent_id: a.id, state: "todo" });
		const outside = await newTask(project.id, { state: "todo" });

		const order: string[] = [];
		for (let i = 0; i < 4; i++) {
			const { task } = await next(parent.id);
			expect(task?.state).toBe("todo");
			// 同じものを返し続けるので、呼ぶだけでは進まない
			expect((await next(parent.id)).task?.id).toBe(task?.id);
			order.push(task?.id ?? "");
			await patch(task?.id ?? "", { state: "doing" }, yukarin);
		}
		expect(order).toEqual([a.id, a1.id, b.id, c.id]);
		expect(order).not.toContain(outside.id);
	});

	it("todo が無ければ空を返し、子孫の状態の内訳を返す", async () => {
		const project = await newProject();
		const parent = await newTask(project.id, { state: "todo" });
		const child = await newTask(project.id, { parent_id: parent.id });
		const doing = await newTask(project.id, {
			parent_id: parent.id,
			state: "todo",
		});
		await patch(doing.id, { state: "doing" });
		const grandchild = await newTask(project.id, {
			parent_id: doing.id,
			state: "todo",
		});
		await newTask(project.id, { parent_id: doing.id });
		await patch(grandchild.id, { state: "done" });

		expect(await next(parent.id)).toEqual({
			task: null,
			descendant_states: {
				backlog: 2,
				todo: 0,
				doing: 1,
				review: 0,
				done: 1,
				dropped: 0,
			},
		});
		// doing の子の下に残った todo の孫も拾う
		await patch(child.id, { state: "dropped" });
		const late = await newTask(project.id, {
			parent_id: doing.id,
			state: "todo",
		});
		expect((await next(parent.id)).task?.id).toBe(late.id);
	});

	it("子が無い親は空で、無い親は 404", async () => {
		const project = await newProject();
		const parent = await newTask(project.id);
		const empty = await next(parent.id);
		expect(empty.task).toBeNull();
		expect(Object.values(empty.descendant_states)).toEqual([0, 0, 0, 0, 0, 0]);
		expect((await call(yukarin, "GET", "/v1/tasks/no-such/next")).status).toBe(
			404,
		);
	});
});

describe("タスク同士の関係", () => {
	const relate = (from: string, body: unknown, as: As = yukarin) =>
		call(as, "POST", `/v1/tasks/${from}/relations`, body);

	it("3 種類の関係を付け、get_task が両側のタスクに返す", async () => {
		const project = await newProject();
		const old = await newTask(project.id);
		const rest = await newTask(project.id);
		const redo = await newTask(project.id);
		expect(
			(await relate(rest.id, { kind: "follows", to_task: old.id })).status,
		).toBe(200);
		expect(
			(await relate(old.id, { kind: "replaced_by", to_task: redo.id })).status,
		).toBe(200);

		const seen = (await read(old.id)).relations;
		expect(seen).toMatchObject([
			{ from_task: rest.id, kind: "follows", to_task: old.id },
			{ from_task: old.id, kind: "replaced_by", to_task: redo.id },
		]);
		expect(seen[0]).toMatchObject({ created_by: "yukarin", run_id: null });
		expect((await read(redo.id)).relations).toHaveLength(1);

		const events = (await eventsOf(rest.id)).filter(
			(e) => e.field === "relation",
		);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			actor_id: "yukarin",
			caller_id: WORKING.id,
		});
		expect(JSON.parse(events[0]?.after ?? "")).toEqual({
			kind: "follows",
			to_task: old.id,
			run_id: null,
		});
	});

	it("同じ関係をもう一度付けても増えない", async () => {
		const project = await newProject();
		const a = await newTask(project.id);
		const b = await newTask(project.id);
		await relate(a.id, { kind: "follows", to_task: b.id });
		expect(
			(await relate(a.id, { kind: "follows", to_task: b.id }, akarin)).status,
		).toBe(200);
		const { relations } = await read(a.id);
		expect(relations).toHaveLength(1);
		expect(relations[0]?.created_by).toBe("yukarin");
	});

	it("同じ関係を同時に付けても、どれも通り、行も履歴も 1 つ", async () => {
		const project = await newProject();
		const a = await newTask(project.id);
		const b = await newTask(project.id);
		const responses = await Promise.all(
			[yukarin, akarin, yukarin, akarin].map((as) =>
				relate(a.id, { kind: "follows", to_task: b.id }, as),
			),
		);
		expect(responses.map((r) => r.status)).toEqual([200, 200, 200, 200]);
		const creators = await Promise.all(
			responses.map(async (r) => (await r.json<RelationJson>()).created_by),
		);
		expect(new Set(creators).size).toBe(1);
		expect((await read(a.id)).relations).toHaveLength(1);
		expect(
			(await eventsOf(a.id)).filter((e) => e.field === "relation"),
		).toHaveLength(1);
	});

	it("discovered_from の run は、相手のタスクかその祖先を回した run に限る", async () => {
		const project = await projectWithRepo();
		const parent = await newTask(project.id, { state: "todo" });
		const child = await newTask(project.id, { parent_id: parent.id });
		const grandchild = await newTask(project.id, { parent_id: child.id });
		const unrelated = await newTask(project.id);
		const run = await startRun(parent.id);
		const childRun = await startRun(child.id);
		const found = await newTask(project.id, {}, yukarin);

		for (const to of [parent.id, grandchild.id]) {
			const res = await relate(found.id, {
				kind: "discovered_from",
				to_task: to,
				run_id: run.id,
			});
			expect(res.status).toBe(200);
		}
		// 子孫を回した run と、関係の無いタスクは通さない
		const cases: [string, string][] = [
			[parent.id, childRun.id],
			[unrelated.id, run.id],
		];
		for (const [to, runId] of cases) {
			const res = await relate(found.id, {
				kind: "discovered_from",
				to_task: to,
				run_id: runId,
			});
			expect(res.status).toBe(400);
			expect(await res.json()).toMatchObject({ error: "run_not_for_task" });
		}
		const res = await call(yukarin, "POST", "/v1/tasks", {
			project_id: project.id,
			title: "x",
			discovered_from: { task_id: unrelated.id, run_id: run.id },
		});
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({ error: "run_not_for_task" });
	});

	it("create_task で discovered_from を一緒に付けられる（別のプロジェクトでもよい）", async () => {
		const project = await projectWithRepo();
		const other = await newProject();
		const parent = await newTask(project.id, { state: "todo" });
		const run = await startRun(parent.id);
		const found = await newTask(
			other.id,
			{ discovered_from: { task_id: parent.id, run_id: run.id } },
			yukarin,
		);
		expect((await read(found.id)).relations).toMatchObject([
			{
				from_task: found.id,
				kind: "discovered_from",
				to_task: parent.id,
				run_id: run.id,
				created_by: "yukarin",
			},
		]);
		expect((await eventsOf(found.id)).map((e) => e.field)).toEqual([
			"created",
			"relation",
		]);
	});

	it("無い相手、自分自身、無い run、discovered_from 以外の run は拒む", async () => {
		const project = await projectWithRepo();
		const a = await newTask(project.id);
		const b = await newTask(project.id);
		const run = await startRun(a.id);
		const cases: [string, unknown, number, string][] = [
			[a.id, { kind: "follows", to_task: "no-such" }, 400, "unknown_task"],
			[a.id, { kind: "follows", to_task: a.id }, 400, "self_relation"],
			["no-such", { kind: "follows", to_task: a.id }, 404, "task_not_found"],
			[
				a.id,
				{ kind: "discovered_from", to_task: b.id, run_id: "no-such" },
				400,
				"unknown_run",
			],
			[
				a.id,
				{ kind: "follows", to_task: b.id, run_id: run.id },
				400,
				"run_only_with_discovered_from",
			],
			[a.id, { kind: "blocks", to_task: b.id }, 400, "invalid_input"],
		];
		for (const [from, body, status, error] of cases) {
			const res = await relate(from, body);
			expect(res.status).toBe(status);
			expect(await res.json()).toMatchObject({ error });
		}
		const res = await call(yukarin, "POST", "/v1/tasks", {
			project_id: project.id,
			title: "x",
			discovered_from: { task_id: "no-such" },
		});
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({ error: "unknown_task" });
	});
});

describe("AI が自分で作る todo の深さの上限", () => {
	const create = (
		projectId: string,
		parentId: string,
		as: As,
		state = "todo",
	) =>
		call(as, "POST", "/v1/tasks", {
			project_id: projectId,
			title: "x",
			parent_id: parentId,
			state,
		});

	/** 親の下に、agent が todo の子を n 段つなげる。最後のタスクの ID を返す */
	const chain = async (projectId: string, parentId: string, n: number) => {
		let id = parentId;
		for (let i = 0; i < n; i++) {
			const res = await create(projectId, id, yukarin);
			expect(res.status).toBe(201);
			id = (await res.json<TaskJson>()).id;
		}
		return id;
	};

	const setDepth = (scope: string, value: number | null, as: As = owner) =>
		call(as, "PUT", `/v1/settings/${scope}`, {
			key: "max_self_todo_depth",
			value,
		});

	it("人が作った親の下に、既定では 3 段まで作れて、4 段目は拒む", async () => {
		const project = await newProject();
		const parent = await newTask(project.id, { state: "todo" });
		const third = await chain(project.id, parent.id, 3);

		const res = await create(project.id, third, akarin);
		expect(res.status).toBe(400);
		const error = await res.json<{ error: string; message: string }>();
		expect(error.error).toBe("todo_depth_exceeded");
		expect(error.message).toContain("backlog で作る");
		expect(error.message).toContain("親を review に");

		// backlog では作れる。人は上限に掛からない
		expect((await create(project.id, third, akarin, "backlog")).status).toBe(
			201,
		);
		expect((await create(project.id, third, owner)).status).toBe(201);
		expect((await create(project.id, third, mac)).status).toBe(201);
	});

	it("人が作ったタスクで数え直す", async () => {
		const project = await newProject();
		const parent = await newTask(project.id, { state: "todo" });
		const third = await chain(project.id, parent.id, 3);
		const byOwner = await (
			await create(project.id, third, owner)
		).json<TaskJson>();
		const again = await chain(project.id, byOwner.id, 3);
		expect((await create(project.id, again, yukarin)).status).toBe(400);
	});

	it("席に渡したことのない agent 製の親は、その親も数える", async () => {
		const project = await newProject();
		const parent = await newTask(project.id, {}, yukarin);
		const second = await chain(project.id, parent.id, 2);
		expect((await create(project.id, second, yukarin)).status).toBe(400);
	});

	it("席に渡した親が agent 製でも、渡した親を 0 として数え直す", async () => {
		const project = await projectWithRepo();
		const parent = await newTask(project.id, {}, yukarin);
		await startRun(parent.id);
		const third = await chain(project.id, parent.id, 3);
		expect((await create(project.id, third, yukarin)).status).toBe(400);

		// 途中のタスクを席に渡すと、そこから数え直す。run を閉じた後も変わらない
		const run = await startRun(third);
		await call(yukarin, "POST", `/v1/runs/${run.id}/end`);
		const again = await chain(project.id, third, 3);
		expect((await create(project.id, again, yukarin)).status).toBe(400);
	});

	it("agent が backlog で作って todo に上げても、上限に掛かる。owner が上げるのは通す", async () => {
		const project = await newProject();
		const parent = await newTask(project.id, { state: "todo" });
		const third = await chain(project.id, parent.id, 3);
		const res = await create(project.id, third, yukarin, "backlog");
		const deep = await res.json<TaskJson>();

		const denied = await patch(deep.id, { state: "todo" }, akarin);
		expect(denied.status).toBe(400);
		expect(await denied.json()).toMatchObject({ error: "todo_depth_exceeded" });
		// todo に上げる以外の更新は通る
		expect((await patch(deep.id, { title: "件名" }, akarin)).status).toBe(200);
		expect((await patch(deep.id, { state: "doing" }, akarin)).status).toBe(200);
		expect((await patch(deep.id, { state: "todo" }, akarin)).status).toBe(400);

		expect((await patch(deep.id, { state: "todo" }, owner)).status).toBe(200);
		// もう todo のタスクの、状態を変えない更新は拒まない
		expect((await patch(deep.id, { title: "t" }, akarin)).status).toBe(200);
	});

	it("上限の内側と、親の無いタスク、人が作ったタスクは、agent が todo に上げられる", async () => {
		const project = await newProject();
		const parent = await newTask(project.id, { state: "todo" });
		const second = await chain(project.id, parent.id, 2);
		const inside = await (
			await create(project.id, second, yukarin, "backlog")
		).json<TaskJson>();
		expect((await patch(inside.id, { state: "todo" }, yukarin)).status).toBe(
			200,
		);

		const top = await newTask(project.id, {}, yukarin);
		expect((await patch(top.id, { state: "todo" }, yukarin)).status).toBe(200);

		const third = await chain(project.id, parent.id, 3);
		const byOwner = await (
			await create(project.id, third, owner, "backlog")
		).json<TaskJson>();
		expect((await patch(byOwner.id, { state: "todo" }, yukarin)).status).toBe(
			200,
		);
	});

	it("プロジェクトの上書きが global より先に効き、消すと global に戻る", async () => {
		const project = await newProject();
		const other = await newProject();
		expect((await setDepth("global", 2)).status).toBe(200);
		expect((await setDepth(project.id, 1)).status).toBe(200);

		const parent = await newTask(project.id, { state: "todo" });
		const first = await chain(project.id, parent.id, 1);
		expect((await create(project.id, first, yukarin)).status).toBe(400);
		// 上書きの無いプロジェクトには global が効く
		const elsewhere = await newTask(other.id, { state: "todo" });
		const second = await chain(other.id, elsewhere.id, 2);
		expect((await create(other.id, second, yukarin)).status).toBe(400);

		expect((await setDepth(project.id, null)).status).toBe(200);
		expect((await create(project.id, first, yukarin)).status).toBe(201);
		expect((await setDepth("global", null)).status).toBe(200);
	});
});

describe("settings", () => {
	type SettingsJson = {
		scope: string;
		settings: { max_self_todo_depth: { value: number; source: string } };
	};
	const put = (scope: string, value: unknown, as: As = owner) =>
		call(as, "PUT", `/v1/settings/${scope}`, {
			key: "max_self_todo_depth",
			value,
		});
	const depth = async (scope: string, as: As = yukarin) =>
		(
			await (
				await call(as, "GET", `/v1/settings/${scope}`)
			).json<SettingsJson>()
		).settings.max_self_todo_depth;

	it("既定、global、プロジェクトの順に上書きし、どこから来た値かを返す", async () => {
		const project = await newProject();
		expect(await depth(project.id)).toEqual({ value: 3, source: "default" });

		expect((await put("global", 5)).status).toBe(200);
		expect(await depth("global")).toEqual({ value: 5, source: "global" });
		expect(await depth(project.id)).toEqual({ value: 5, source: "global" });

		const res = await put(project.id, 2, mac);
		expect(await res.json()).toEqual({
			scope: project.id,
			settings: { max_self_todo_depth: { value: 2, source: "project" } },
		});

		expect((await put("global", null)).status).toBe(200);
		expect(await depth("global")).toEqual({ value: 3, source: "default" });
		expect(await depth(project.id)).toEqual({ value: 2, source: "project" });

		const events = await eventsOf(project.id);
		expect(events.filter((e) => e.entity === "setting")).toEqual([
			{
				entity: "setting",
				entity_id: project.id,
				actor_id: "owner",
				caller_id: MAC.id,
				field: "max_self_todo_depth",
				before: null,
				after: "2",
			},
		]);
	});

	it("同時に書いても、履歴の before と after がつながる", async () => {
		const project = await newProject();
		const responses = await Promise.all(
			[4, 5, 6, 7, null].map((value) => put(project.id, value, mac)),
		);
		expect(responses.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);

		const events = (await eventsOf(project.id)).filter(
			(e) => e.entity === "setting",
		);
		expect(events.length).toBeGreaterThanOrEqual(4);
		expect(events[0]?.before).toBeNull();
		for (let i = 1; i < events.length; i++) {
			expect(events[i]?.before).toBe(events[i - 1]?.after);
		}
		const last = JSON.parse(events.at(-1)?.after ?? "null");
		expect(await depth(project.id)).toEqual(
			last === null
				? { value: 3, source: "default" }
				: { value: last, source: "project" },
		);
	});

	it("読んだ後に他の書き込みが入った更新と、行の削除を D1 が拒む", async () => {
		const project = await newProject();
		await put(project.id, 4);
		const update = (revision: number) =>
			env.DB.prepare(
				"UPDATE settings SET value = '9', revision = ? WHERE scope = ?",
			)
				.bind(revision, project.id)
				.run();
		await expect(update(3)).rejects.toThrow(/setting changed since read/);
		await update(1);
		await expect(
			env.DB.prepare("DELETE FROM settings WHERE scope = ?")
				.bind(project.id)
				.run(),
		).rejects.toThrow(/settings are never deleted/);
	});

	it("書けるのは owner だけ", async () => {
		const project = await newProject();
		const res = await put(project.id, 9, yukarin);
		expect(res.status).toBe(403);
		expect(await res.json()).toMatchObject({ error: "owner_only" });
		expect((await depth(project.id)).source).not.toBe("project");
	});

	it("知らない key、範囲外の値、無い scope は拒む", async () => {
		const project = await newProject();
		for (const body of [
			{ key: "unknown", value: 1 },
			{ key: "max_self_todo_depth", value: -1 },
			{ key: "max_self_todo_depth", value: 1.5 },
			{ key: "max_self_todo_depth", value: "3" },
		]) {
			const res = await call(owner, "PUT", `/v1/settings/${project.id}`, body);
			expect(res.status).toBe(400);
		}
		expect((await put("no-such-project", 1)).status).toBe(404);
		expect((await call(owner, "GET", "/v1/settings/no-such")).status).toBe(404);
	});
});

describe("仕分け", () => {
	const awaiting = async (projectId: string) => {
		const res = await call(
			owner,
			"GET",
			`/v1/tasks?project_id=${projectId}&awaiting_triage=true`,
		);
		expect(res.status).toBe(200);
		return (await res.json<{ tasks: TaskJson[] }>()).tasks.map((t) => t.id);
	};
	const triage = (id: string, as: As = owner) =>
		call(as, "POST", `/v1/tasks/${id}/triage`);

	it("仕分け待ちは、agent が起票した backlog で triaged_at が空のもの", async () => {
		const project = await newProject();
		const byAgent = await newTask(project.id, {}, yukarin);
		await newTask(project.id, {}, owner);
		await newTask(project.id, {}, mac);
		await newTask(project.id, { state: "todo" }, yukarin);
		expect(byAgent.triaged_at).toBeNull();
		expect(await awaiting(project.id)).toEqual([byAgent.id]);
	});

	it("owner が状態を変えると仕分け済みになり、agent が変えてもならない", async () => {
		const project = await newProject();
		const up = await newTask(project.id, {}, yukarin);
		const drop = await newTask(project.id, {}, yukarin);
		const self = await newTask(project.id, {}, yukarin);
		const edited = await newTask(project.id, {}, yukarin);

		const res = await patch(up.id, { state: "todo" });
		expect((await res.json<TaskJson>()).triaged_at).not.toBeNull();
		await patch(drop.id, { state: "dropped" }, mac);
		await patch(self.id, { state: "todo" }, yukarin);
		// 状態を変えない編集は、仕分けに数えない
		await patch(edited.id, { title: "直した件名" });

		expect((await read(drop.id)).triaged_at).not.toBeNull();
		expect((await read(self.id)).triaged_at).toBeNull();
		expect(await awaiting(project.id)).toEqual([edited.id]);
		// agent が上げたものを backlog に戻すと、また仕分け待ちになる
		await patch(self.id, { state: "backlog" }, yukarin);
		expect(await awaiting(project.id)).toEqual([self.id, edited.id]);

		const events = (await eventsOf(up.id)).filter(
			(e) => e.field === "triaged_at",
		);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ actor_id: "owner", before: null });
	});

	it("backlog のまま残す操作は owner だけができ、履歴に残る", async () => {
		const project = await newProject();
		const task = await newTask(project.id, {}, yukarin);
		const denied = await triage(task.id, yukarin);
		expect(denied.status).toBe(403);

		const res = await triage(task.id);
		expect(res.status).toBe(200);
		const kept = await res.json<TaskJson>();
		expect(kept.state).toBe("backlog");
		expect(kept.triaged_at).not.toBeNull();
		expect(await awaiting(project.id)).toEqual([]);

		const again = await triage(task.id);
		expect((await again.json<TaskJson>()).triaged_at).toBe(kept.triaged_at);
		expect(
			(await eventsOf(task.id)).filter((e) => e.field === "triaged_at"),
		).toHaveLength(1);
		// 仕分けの後も、他の更新が通る（revision が合っている）
		expect((await patch(task.id, { title: "t" })).status).toBe(200);
	});

	it("仕分け待ちでないタスクと、無いタスクは受けない", async () => {
		const project = await newProject();
		const byOwner = await newTask(project.id);
		const res = await triage(byOwner.id);
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({ error: "not_awaiting_triage" });
		expect((await triage("no-such")).status).toBe(404);
	});
});

describe("親を review にする", () => {
	const SETTLED = "子タスクがすべて片付いた";
	const family = async (parentState: string, children = 2) => {
		const project = await newProject();
		const parent = await newTask(project.id, { state: "todo" });
		const kids: TaskJson[] = [];
		for (let i = 0; i < children; i++) {
			kids.push(
				await newTask(project.id, { parent_id: parent.id, state: "todo" }),
			);
		}
		if (parentState !== "todo") {
			const body =
				parentState === "review"
					? { state: "review", waiting_on: "見てほしい" }
					: { state: parentState };
			await patch(parent.id, body);
		}
		return { project, parent, kids };
	};

	it("最後の子が done か dropped になると、todo か doing の親が review になる", async () => {
		for (const parentState of ["todo", "doing"]) {
			const { parent, kids } = await family(parentState);
			await patch(kids[0]?.id ?? "", { state: "done" }, yukarin);
			expect((await read(parent.id)).state).toBe(parentState);

			await patch(kids[1]?.id ?? "", { state: "dropped" }, yukarin);
			expect(await read(parent.id)).toMatchObject({
				state: "review",
				waiting_on: SETTLED,
			});

			const events = (await eventsOf(parent.id)).slice(-2);
			expect(events).toEqual([
				{
					entity: "task",
					entity_id: parent.id,
					actor_id: "yukarin",
					caller_id: WORKING.id,
					field: "state",
					before: JSON.stringify(parentState),
					after: '"review"',
				},
				{
					entity: "task",
					entity_id: parent.id,
					actor_id: "yukarin",
					caller_id: WORKING.id,
					field: "waiting_on",
					before: null,
					after: JSON.stringify(SETTLED),
				},
			]);
			// 自動で動かした後も、親の更新が通る（revision が合っている）
			expect((await patch(parent.id, { state: "done" })).status).toBe(200);
		}
	});

	it("親が backlog、review、done、dropped なら動かさず、履歴も残さない", async () => {
		for (const parentState of ["backlog", "review", "done", "dropped"]) {
			const { parent, kids } = await family(parentState, 1);
			const before = await read(parent.id);
			const count = (await eventsOf(parent.id)).length;
			await patch(kids[0]?.id ?? "", { state: "done" }, yukarin);
			const after = await read(parent.id);
			expect(after.state).toBe(parentState);
			expect(after.waiting_on).toBe(before.waiting_on);
			expect(await eventsOf(parent.id)).toHaveLength(count);
		}
	});

	it("子が無いタスクと、親の無いタスクは、done にしても何も起きない", async () => {
		const project = await newProject();
		const alone = await newTask(project.id, { state: "todo" });
		const res = await patch(alone.id, { state: "done" });
		expect((await res.json<TaskJson>()).state).toBe("done");
		expect((await eventsOf(alone.id)).map((e) => e.field)).toEqual([
			"created",
			"state",
		]);
	});

	it("孫が残っていても、直下の子がすべて片付けば親は review になる。孫の親は別に数える", async () => {
		const { project, parent, kids } = await family("doing", 1);
		const child = kids[0]?.id ?? "";
		const g1 = await newTask(project.id, { parent_id: child, state: "todo" });
		const g2 = await newTask(project.id, { parent_id: child, state: "todo" });

		// 孫の 1 つが片付いても、子も親も動かない
		await patch(g1.id, { state: "done" }, yukarin);
		expect((await read(child)).state).toBe("todo");
		expect((await read(parent.id)).state).toBe("doing");

		// 孫がすべて片付くと、子だけが review になる。親は、子が done か dropped になるまで動かない
		await patch(g2.id, { state: "done" }, yukarin);
		expect((await read(child)).state).toBe("review");
		expect((await read(parent.id)).state).toBe("doing");

		const g3 = await newTask(project.id, { parent_id: child, state: "todo" });
		await patch(child, { state: "done" });
		expect((await read(g3.id)).state).toBe("todo");
		expect(await read(parent.id)).toMatchObject({
			state: "review",
			waiting_on: SETTLED,
		});
	});

	it("done や dropped 以外への変更と、状態を変えない更新では動かさない", async () => {
		const { parent, kids } = await family("doing", 2);
		await patch(kids[0]?.id ?? "", { state: "done" });
		await patch(kids[1]?.id ?? "", { state: "doing" });
		await patch(kids[0]?.id ?? "", { title: "件名だけ" });
		expect((await read(parent.id)).state).toBe("doing");
	});

	it("片付いた子の件名を直しても、review を出た親を戻さない", async () => {
		const { parent, kids } = await family("doing", 1);
		await patch(kids[0]?.id ?? "", { state: "done" });
		await patch(parent.id, { state: "doing" });
		await patch(kids[0]?.id ?? "", { title: "件名だけ" });
		expect((await read(parent.id)).state).toBe("doing");
	});

	it("兄弟が同時に片付いても、親は review になる", async () => {
		const { parent, kids } = await family("doing", 4);
		await Promise.all(kids.map((k) => patch(k.id, { state: "done" }, yukarin)));
		expect((await read(parent.id)).state).toBe("review");
		expect(
			(await eventsOf(parent.id)).filter((e) => e.after === '"review"'),
		).toHaveLength(1);
	});
});
