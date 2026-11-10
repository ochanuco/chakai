import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import {
	call,
	eventsOf,
	MAC,
	mac,
	newProject,
	newTask,
	owner,
	seedRoster,
	type TaskJson,
	WORKING,
	working,
} from "./helpers.ts";

beforeAll(seedRoster);

const patch = (id: string, body: unknown, as = owner) =>
	call(as, "PATCH", `/v1/tasks/${id}`, body);

const titlesInOrder = async (projectId: string) => {
	const res = await call(owner, "GET", `/v1/tasks?project_id=${projectId}`);
	const { tasks } = await res.json<{ tasks: TaskJson[] }>();
	return tasks.map((t) => t.title);
};

describe("起票", () => {
	it("既定は backlog で、ID は UUID v7、起票した actor を残す", async () => {
		const project = await newProject();
		const task = await newTask(project.id, {}, working("yukarin"));
		expect(task).toMatchObject({
			state: "backlog",
			created_by: "yukarin",
			waiting_on: null,
			parent_id: null,
			labels: [],
		});
		expect(task.id).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
		);
	});

	it("todo でも起票できるが、それ以外の状態では起票できない", async () => {
		const project = await newProject();
		expect((await newTask(project.id, { state: "todo" })).state).toBe("todo");
		for (const state of ["doing", "review", "done", "dropped"]) {
			const res = await call(owner, "POST", "/v1/tasks", {
				project_id: project.id,
				title: "x",
				state,
			});
			expect(res.status).toBe(400);
		}
	});

	it("親は同じプロジェクトのタスクに限る", async () => {
		const project = await newProject();
		const other = await newProject();
		const parent = await newTask(project.id);
		const child = await newTask(project.id, { parent_id: parent.id });
		expect(child.parent_id).toBe(parent.id);
		const res = await call(owner, "POST", "/v1/tasks", {
			project_id: other.id,
			title: "x",
			parent_id: parent.id,
		});
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({ error: "unknown_parent" });
	});

	it("無いプロジェクトは 404、名簿に無い担当は 400", async () => {
		const missing = await call(owner, "POST", "/v1/tasks", {
			project_id: "nope",
			title: "x",
		});
		expect(missing.status).toBe(404);
		const project = await newProject();
		for (const assignee_id of ["nobody", "retired"]) {
			const res = await call(owner, "POST", "/v1/tasks", {
				project_id: project.id,
				title: "x",
				assignee_id,
			});
			expect(res.status).toBe(400);
		}
	});
});

describe("状態", () => {
	it("6 つの状態のどれにも動かせ、知らない状態は 400", async () => {
		const project = await newProject();
		const task = await newTask(project.id);
		for (const state of ["todo", "doing", "done", "dropped", "backlog"]) {
			const res = await patch(task.id, { state });
			expect(res.status).toBe(200);
			expect((await res.json<TaskJson>()).state).toBe(state);
		}
		expect((await patch(task.id, { state: "archived" })).status).toBe(400);
	});

	it("review にするときは waiting_on が要る", async () => {
		const project = await newProject();
		const task = await newTask(project.id);
		for (const body of [
			{ state: "review" },
			{ state: "review", waiting_on: null },
			{ state: "review", waiting_on: "  " },
		]) {
			const res = await patch(task.id, body);
			expect(res.status).toBe(400);
		}
		const res = await patch(task.id, {
			state: "review",
			waiting_on: "方針 A と B のどちらにするか",
		});
		expect(await res.json()).toMatchObject({
			state: "review",
			waiting_on: "方針 A と B のどちらにするか",
		});
	});

	it("review の間は waiting_on を書き換えられるが、空にはできない", async () => {
		const project = await newProject();
		const task = await newTask(project.id);
		await patch(task.id, { state: "review", waiting_on: "一つ目" });
		const res = await patch(task.id, { waiting_on: "二つ目" });
		expect((await res.json<TaskJson>()).waiting_on).toBe("二つ目");
		expect((await patch(task.id, { waiting_on: null })).status).toBe(400);
	});

	it("review を出ると waiting_on が空になり、events に残る", async () => {
		const project = await newProject();
		const task = await newTask(project.id);
		await patch(task.id, { state: "review", waiting_on: "見てほしい" });
		const res = await patch(task.id, { state: "doing" });
		expect(await res.json()).toMatchObject({
			state: "doing",
			waiting_on: null,
		});
		const events = await eventsOf(task.id);
		expect(events.slice(-2).map((e) => [e.field, e.before, e.after])).toEqual([
			["state", '"review"', '"doing"'],
			["waiting_on", '"見てほしい"', null],
		]);
	});

	it("review でないタスクに waiting_on は付けられない", async () => {
		const project = await newProject();
		const task = await newTask(project.id);
		const res = await patch(task.id, { waiting_on: "理由" });
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({
			error: "waiting_on_only_in_review",
		});
	});

	it("タスクを消す入口は無く、DB でも消せない", async () => {
		const project = await newProject();
		const task = await newTask(project.id);
		const res = await call(owner, "DELETE", `/v1/tasks/${task.id}`);
		expect(res.status).toBe(404);
		await expect(
			env.DB.prepare("DELETE FROM tasks WHERE id = ?").bind(task.id).run(),
		).rejects.toThrow(/never deleted/);
		expect((await call(owner, "GET", `/v1/tasks/${task.id}`)).status).toBe(200);
	});
});

describe("events", () => {
	it("起票を、actor と呼び出し元と一緒に 1 行で残す", async () => {
		const project = await newProject();
		const task = await newTask(project.id, {}, working("yukarin"));
		const events = await eventsOf(task.id);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			entity: "task",
			actor_id: "yukarin",
			caller_id: WORKING.id,
			field: "created",
			before: null,
		});
		expect(JSON.parse(events[0]?.after ?? "")).toMatchObject({
			id: task.id,
			state: "backlog",
		});
	});

	it("変えた項目ごとに before と after を残し、誰が変えたかを分ける", async () => {
		const project = await newProject();
		const task = await newTask(project.id);
		await patch(task.id, { state: "todo", assignee_id: "akarin" }, mac);
		await patch(task.id, { state: "doing" }, working("akarin"));
		const events = (await eventsOf(task.id)).slice(1);
		expect(
			events.map((e) => [e.field, e.before, e.after, e.actor_id, e.caller_id]),
		).toEqual([
			["state", '"backlog"', '"todo"', "owner", MAC.id],
			["assignee_id", null, '"akarin"', "owner", MAC.id],
			["state", '"todo"', '"doing"', "akarin", WORKING.id],
		]);
	});

	it("何も変わらない更新は events を足さない", async () => {
		const project = await newProject();
		const task = await newTask(project.id, { labels: ["b", "a"] });
		const res = await patch(task.id, { state: "backlog", labels: ["a", "b"] });
		expect(res.status).toBe(200);
		expect(await eventsOf(task.id)).toHaveLength(1);
	});

	it("ラベルの付け替えと、新しいラベルができたことを残す", async () => {
		const project = await newProject();
		const name = `label-${crypto.randomUUID()}`;
		const task = await newTask(project.id, { labels: ["keep"] });
		const res = await patch(task.id, { labels: [name, "keep"] });
		expect((await res.json<TaskJson>()).labels).toEqual([name, "keep"].sort());
		const last = (await eventsOf(task.id)).at(-1);
		expect(last).toMatchObject({ field: "labels", before: '["keep"]' });
		expect(JSON.parse(last?.after ?? "")).toEqual([name, "keep"].sort());
		const created = await env.DB.prepare(
			"SELECT e.actor_id FROM events e JOIN labels l ON l.id = e.entity_id WHERE e.entity = 'label' AND e.field = 'created' AND l.name = ?",
		)
			.bind(name)
			.all();
		expect(created.results).toEqual([{ actor_id: "owner" }]);
	});

	it("失敗した更新は、タスクも events も変えない", async () => {
		const project = await newProject();
		const task = await newTask(project.id);
		const res = await patch(task.id, {
			assignee_id: "akarin",
			state: "review",
		});
		expect(res.status).toBe(400);
		const after = await call(owner, "GET", `/v1/tasks/${task.id}`);
		expect((await after.json<TaskJson>()).assignee_id).toBeNull();
		expect(await eventsOf(task.id)).toHaveLength(1);
	});

	it("events は書き換えも削除もできない", async () => {
		const project = await newProject();
		const task = await newTask(project.id);
		await expect(
			env.DB.prepare("UPDATE events SET after = NULL WHERE entity_id = ?")
				.bind(task.id)
				.run(),
		).rejects.toThrow(/append-only/);
		await expect(
			env.DB.prepare("DELETE FROM events WHERE entity_id = ?")
				.bind(task.id)
				.run(),
		).rejects.toThrow(/append-only/);
		expect(await eventsOf(task.id)).toHaveLength(1);
	});
});

describe("並び（order_key）", () => {
	it("起票した順にプロジェクトの末尾へ入る", async () => {
		const project = await newProject();
		const other = await newProject();
		const a = await newTask(project.id, { title: "a" });
		await newTask(other.id, { title: "x" });
		const b = await newTask(project.id, { title: "b" });
		const c = await newTask(project.id, { title: "c" });
		expect(a.order_key < b.order_key && b.order_key < c.order_key).toBe(true);
		expect(await titlesInOrder(project.id)).toEqual(["a", "b", "c"]);
	});

	it("相手の直前・直後に動かせる", async () => {
		const project = await newProject();
		const a = await newTask(project.id, { title: "a" });
		const b = await newTask(project.id, { title: "b" });
		const c = await newTask(project.id, { title: "c" });
		const d = await newTask(project.id, { title: "d" });
		await patch(d.id, { order: { before: a.id } });
		expect(await titlesInOrder(project.id)).toEqual(["d", "a", "b", "c"]);
		await patch(d.id, { order: { after: b.id } });
		expect(await titlesInOrder(project.id)).toEqual(["a", "b", "d", "c"]);
		await patch(a.id, { order: { after: c.id } });
		expect(await titlesInOrder(project.id)).toEqual(["b", "d", "c", "a"]);
		// すでに隣にいる相手を指しても並びは変わらない
		await patch(d.id, { order: { after: b.id } });
		expect(await titlesInOrder(project.id)).toEqual(["b", "d", "c", "a"]);
	});

	it("同じ隙間に何度入れても、並びが保たれる", async () => {
		const project = await newProject();
		const first = await newTask(project.id, { title: "first" });
		await newTask(project.id, { title: "last" });
		const expected = ["first"];
		for (let i = 0; i < 12; i++) {
			const task = await newTask(project.id, { title: `m${i}` });
			await patch(task.id, { order: { after: first.id } });
			expected.splice(1, 0, `m${i}`);
		}
		expect(await titlesInOrder(project.id)).toEqual([...expected, "last"]);
	});

	it("同時に起票しても order_key が重ならない", async () => {
		const project = await newProject();
		const created = await Promise.all(
			Array.from({ length: 3 }, () => newTask(project.id)),
		);
		expect(new Set(created.map((t) => t.order_key)).size).toBe(3);
	});

	it("並べ替えを events に残す", async () => {
		const project = await newProject();
		const a = await newTask(project.id);
		const b = await newTask(project.id);
		const res = await patch(b.id, { order: { before: a.id } });
		const moved = await res.json<TaskJson>();
		expect((await eventsOf(b.id)).at(-1)).toMatchObject({
			field: "order_key",
			before: JSON.stringify(b.order_key),
			after: JSON.stringify(moved.order_key),
		});
	});

	it("自分自身と、別のプロジェクトのタスクは相手にできない", async () => {
		const project = await newProject();
		const other = await newProject();
		const a = await newTask(project.id);
		const x = await newTask(other.id);
		for (const anchor of [a.id, x.id, "nope"]) {
			const res = await patch(a.id, { order: { after: anchor } });
			expect(res.status).toBe(400);
		}
	});
});

describe("探す", () => {
	it("語・状態・ラベル・担当・親で絞り込む", async () => {
		const project = await newProject();
		const word = `語${crypto.randomUUID()}`;
		const parent = await newTask(project.id, { title: `親 ${word}` });
		const child = await newTask(project.id, {
			title: "子",
			body: `本文に ${word}`,
			parent_id: parent.id,
			state: "todo",
			assignee_id: "yukarin",
			labels: ["infra"],
		});
		await newTask(project.id, { title: "関係ない" });
		const ids = async (query: string) => {
			const res = await call(
				owner,
				"GET",
				`/v1/tasks?project_id=${project.id}&${query}`,
			);
			expect(res.status).toBe(200);
			return (await res.json<{ tasks: TaskJson[] }>()).tasks.map((t) => t.id);
		};
		expect(await ids(`q=${encodeURIComponent(word)}`)).toEqual([
			parent.id,
			child.id,
		]);
		expect(await ids("state=todo,doing")).toEqual([child.id]);
		expect(await ids("label=infra")).toEqual([child.id]);
		expect(await ids("assignee_id=yukarin")).toEqual([child.id]);
		expect(await ids(`parent_id=${parent.id}`)).toEqual([child.id]);
		expect(await ids("limit=1")).toEqual([parent.id]);
	});

	it("_ と % を含む語を、そのままの文字として探す", async () => {
		const project = await newProject();
		const under = await newTask(project.id, { title: "order_key を直す" });
		await newTask(project.id, { title: "orderXkey を直す" });
		const percent = await newTask(project.id, { title: "進捗 100% にする" });
		await newTask(project.id, { title: "進捗 1000 にする" });
		const ids = async (q: string) => {
			const res = await call(
				owner,
				"GET",
				`/v1/tasks?project_id=${project.id}&q=${encodeURIComponent(q)}`,
			);
			return (await res.json<{ tasks: TaskJson[] }>()).tasks.map((t) => t.id);
		};
		expect(await ids("order_key")).toEqual([under.id]);
		expect(await ids("100%")).toEqual([percent.id]);
	});

	it("知らない条件は 400", async () => {
		const res = await call(owner, "GET", "/v1/tasks?state=archived");
		expect(res.status).toBe(400);
	});
});
