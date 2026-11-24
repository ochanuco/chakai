import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { renderInbox } from "../src/ui/inbox.ts";
import {
	type As,
	call,
	mac,
	newProject,
	newTask,
	owner,
	seedRoster,
	WORKING,
	working,
} from "./helpers.ts";

const MEMBER_EMAIL = "member@example.com";

beforeAll(async () => {
	await seedRoster();
	await env.DB.prepare(
		`INSERT OR IGNORE INTO actors (id, kind, role, display_name, runtime, email, active)
			VALUES ('helper', 'human', 'member', 'Helper', NULL, '${MEMBER_EMAIL}', 1)`,
	).run();
});

const patch = (id: string, body: unknown, as: As = owner) =>
	call(as, "PATCH", `/v1/tasks/${id}`, body);

const text = async (path: string, as: As | null = owner) => {
	const res = await call(as, "GET", path);
	return { status: res.status, body: await res.text(), res };
};

describe("画面を開ける人", () => {
	const paths = [
		"/",
		"/assets/app.js",
		"/triage",
		"/doing",
		"/more",
		"/projects",
		"/settings",
		"/projects/x",
		"/tasks/x",
		"/nowhere",
	];

	it("owner のログインには返す", async () => {
		const home = await text("/");
		expect(home.status).toBe(200);
		expect(home.res.headers.get("content-type")).toContain("text/html");
		expect(home.res.headers.get("content-security-policy")).toContain(
			"script-src 'self'",
		);
		const script = await text("/assets/app.js");
		expect(script.status).toBe(200);
		expect(script.res.headers.get("content-type")).toContain("javascript");
	});

	it.each([
		["owner を名乗れる service token", mac],
		["AI を名乗る service token", working("yukarin")],
		["owner でない人のログイン", { email: MEMBER_EMAIL }],
	])("%s には、画面も script も返さない", async (_name, as) => {
		for (const path of paths) {
			const res = await call(as, "GET", path);
			expect(res.status).toBe(403);
			expect(await res.json()).toMatchObject({ error: "owner_only" });
		}
	});

	it("JWT が無ければ 401、名簿に無い email は 403", async () => {
		for (const path of paths) {
			expect((await call(null, "GET", path)).status).toBe(401);
			expect(
				(await call({ email: "stranger@example.com" }, "GET", path)).status,
			).toBe(403);
		}
	});

	it("画面の入口は GET だけで、無い道は 404", async () => {
		expect((await call(owner, "POST", "/", {})).status).toBe(404);
		expect((await text("/nowhere")).status).toBe(404);
		expect((await text("/projects/nope")).status).toBe(404);
		expect((await text("/tasks/nope")).status).toBe(404);
		expect((await text("/triage/x")).status).toBe(404);
		expect((await text("/settings/x")).status).toBe(404);
	});
});

const projectWithRepo = async () => {
	const project = await newProject();
	await call(owner, "POST", `/v1/projects/${project.id}/repos`, {
		repo: "example/app",
	});
	return project;
};

const startRun = async (taskId: string, seat: string, as: As) => {
	const res = await call(as, "POST", "/v1/runs", {
		task_id: taskId,
		seat,
		model: "model-x",
	});
	expect(res.status).toBe(201);
	return res.json<{ id: string }>();
};

const relate = (from: string, kind: string, to: string) =>
	call(owner, "POST", `/v1/tasks/${from}/relations`, { kind, to_task: to });

const putSetting = (scope: string, value: number | null) =>
	call(owner, "PUT", `/v1/settings/${scope}`, {
		key: "max_self_todo_depth",
		value,
	});

describe("読み取りの REST", () => {
	it("タスクの履歴を、誰が・どこから・前後の値つきで古い順に返す", async () => {
		const project = await newProject();
		const task = await newTask(project.id, {}, working("yukarin"));
		await patch(task.id, { state: "todo" });
		await patch(task.id, { labels: ["bug"] }, mac);

		const res = await call(
			working("akarin"),
			"GET",
			`/v1/tasks/${task.id}/events`,
		);
		expect(res.status).toBe(200);
		const { events } = await res.json<{
			events: Record<string, unknown>[];
		}>();
		const ids = events.map((e) => e.id);
		expect(ids).toEqual([...ids].sort());
		const of = (field: string) => events.find((e) => e.field === field);
		expect(events[0]).toMatchObject({
			field: "created",
			actor_id: "yukarin",
			caller_id: WORKING.id,
			caller_name: "working",
			before: null,
			after: { id: task.id, state: "backlog" },
		});
		expect(of("state")).toMatchObject({
			actor_id: "owner",
			caller_id: null,
			caller_name: null,
			before: "backlog",
			after: "todo",
		});
		expect(of("labels")).toMatchObject({
			actor_id: "owner",
			caller_name: "mac-agent",
			before: [],
			after: ["bug"],
		});
	});

	it("無いタスクの履歴は 404", async () => {
		const res = await call(owner, "GET", "/v1/tasks/nope/events");
		expect(res.status).toBe(404);
		expect(await res.json()).toMatchObject({ error: "task_not_found" });
	});

	it("タスクの実行記録を、始めた順に返す", async () => {
		const project = await projectWithRepo();
		const task = await newTask(project.id, { state: "todo" });
		const first = await startRun(task.id, "seat-a", working("yukarin"));
		await call(working("yukarin"), "POST", `/v1/runs/${first.id}/end`);
		const second = await startRun(task.id, "seat-b", working("akarin"));

		const res = await call(mac, "GET", `/v1/tasks/${task.id}/runs`);
		expect(res.status).toBe(200);
		const { runs } = await res.json<{ runs: Record<string, unknown>[] }>();
		expect(runs).toMatchObject([
			{
				id: first.id,
				task_id: task.id,
				actor_id: "yukarin",
				seat: "seat-a",
				model: "model-x",
				ended_at: expect.any(String),
			},
			{ id: second.id, actor_id: "akarin", seat: "seat-b", ended_at: null },
		]);

		const other = await newTask(project.id);
		expect(
			await (await call(mac, "GET", `/v1/tasks/${other.id}/runs`)).json(),
		).toEqual({ runs: [] });
		const missing = await call(mac, "GET", "/v1/tasks/nope/runs");
		expect(missing.status).toBe(404);
		expect(await missing.json()).toMatchObject({ error: "task_not_found" });
	});

	it("名簿を返すが、email は載せない", async () => {
		const res = await call(working("yukarin"), "GET", "/v1/actors");
		expect(res.status).toBe(200);
		const raw = await res.text();
		expect(raw).not.toContain("@example.com");
		const { actors } = JSON.parse(raw) as { actors: Record<string, unknown>[] };
		expect(actors.find((a) => a.id === "yukarin")).toEqual({
			id: "yukarin",
			kind: "agent",
			role: "member",
			display_name: "Yukarin",
			runtime: "claude-cli",
			active: true,
		});
		expect(actors.find((a) => a.id === "retired")).toMatchObject({
			active: false,
		});
	});

	it("ラベルを名前の順に返す", async () => {
		const project = await newProject();
		await newTask(project.id, { labels: ["zz-last", "aa-first"] });
		const res = await call(mac, "GET", "/v1/labels");
		const { labels } = await res.json<{ labels: { name: string }[] }>();
		const names = labels.map((l) => l.name);
		expect(names).toEqual([...names].sort());
		expect(names).toEqual(expect.arrayContaining(["aa-first", "zz-last"]));
	});
});

/** 左ペイン（一覧）の HTML */
const sideOf = (body: string) =>
	body.slice(body.indexOf('<aside class="side">'), body.indexOf("<main"));

/** タスクの会話の時系列の HTML */
const timelineOf = (body: string) => {
	const start = body.indexOf('<ol class="timeline">');
	return body.slice(start, body.indexOf("</ol>", start));
};

/** タスクの右の列の HTML */
const metaOf = (body: string) =>
	body.slice(
		body.indexOf('<aside class="meta"'),
		body.indexOf('<details class="edit">'),
	);

describe("画面", () => {
	it("Review の一覧に、プロジェクトをまたいで review を、最後に動いた新しい順に並べる", async () => {
		const a = await newProject();
		const b = await newProject();
		const first = await newTask(a.id, { title: "先に仰いだ" });
		const second = await newTask(b.id, { title: "後に仰いだ" });
		await patch(first.id, { state: "review", waiting_on: "案 A でよいか" });
		await patch(
			second.id,
			{ state: "review", waiting_on: "案 B でよいか" },
			working("yukarin"),
		);
		await newTask(a.id, { title: "仰いでいない" });

		const list = sideOf((await text("/")).body);
		expect(list).toContain("案 A でよいか");
		expect(list).toContain("案 B でよいか");
		expect(list.indexOf("案 B でよいか")).toBeLessThan(
			list.indexOf("案 A でよいか"),
		);
		expect(list).not.toContain("仰いでいない");
		expect(list).toContain(`href="/tasks/${first.id}?from=review"`);
		// 行には、担当や起票者ではなく、review にした actor を出す
		expect(pieceOf(list, '<a class="item"', "案 B でよいか")).toContain(
			"<span>Yukarin</span>",
		);
		expect(pieceOf(list, '<a class="item"', "案 A でよいか")).toContain(
			"<span>Owner</span>",
		);
		expect(list).toMatch(
			/<time datetime="[^"]+" title="\d{4}-\d{2}-\d{2} \d{2}:\d{2}">たった今<\/time>/,
		);

		// note だけの更新はタスクの行を変えないが、動いたとして上に来る
		await patch(first.id, { note: "見直した" });
		const after = sideOf((await text("/")).body);
		expect(after.indexOf("案 A でよいか")).toBeLessThan(
			after.indexOf("案 B でよいか"),
		);
		const detail = (await text(`/tasks/${second.id}`)).body;
		expect(detail).toContain(`href="/projects/${b.id}"`);
	});
	it("Reply は review の前の状態に戻し、Done と Drop も選べ、送った後は一覧の次のタスクを開く", async () => {
		const project = await newProject();
		const fromDoing = await newTask(project.id, { state: "todo" });
		await patch(fromDoing.id, { state: "doing" });
		await patch(fromDoing.id, {
			state: "review",
			waiting_on: "作業中に仰いだ",
		});
		const fromBacklog = await newTask(project.id);
		await patch(fromBacklog.id, {
			state: "review",
			waiting_on: "起票直後に仰いだ",
		});

		const doing = (await text(`/tasks/${fromDoing.id}?from=review`)).body;
		expect(doing).toContain(
			'name="to" value="doing" class="primary" data-default>Reply</button>',
		);
		// backlog に戻すと誰も拾わないので、作業の状態でなければ todo にする
		const backlog = (await text(`/tasks/${fromBacklog.id}`)).body;
		expect(backlog).toContain(
			'name="to" value="todo" class="primary" data-default>Reply</button>',
		);
		expect(backlog).toContain(
			'name="to" value="done" class="outline">Done</button>',
		);
		expect(backlog).toContain(
			'name="to" value="dropped" class="quiet">Drop</button>',
		);
		// 新しい順の一覧で、fromBacklog の次は fromDoing
		expect(backlog).toContain(
			`data-reply="${fromBacklog.id}" data-next="/tasks/${fromDoing.id}?from=review"`,
		);
	});
	it("タスクの画面では、review のときだけ返事の欄を出す", async () => {
		const project = await newProject();
		const task = await newTask(project.id, { state: "todo" });
		expect((await text(`/tasks/${task.id}`)).body).not.toContain("data-reply=");
		await patch(task.id, { state: "review", waiting_on: "見てほしい" });
		const { body } = await text(`/tasks/${task.id}`);
		expect(body).toContain(`data-reply="${task.id}"`);
		expect(body).toContain('value="todo" class="primary" data-default>Reply');
		expect(body).toContain('<p class="ask">見てほしい</p>');
	});
	it("プロジェクトの一覧では、タスクの無いプロジェクトを札にせず、畳んだ一覧に名前だけ出す", async () => {
		const busy = await newProject();
		const idle = await newProject();
		await newTask(busy.id);
		const { body } = await text("/projects");
		const [cards, folded = ""] = body.split("<details>");
		expect(cards).toContain(`<div class="card"><a href="/projects/${busy.id}"`);
		expect(cards).not.toContain(`href="/projects/${idle.id}"`);
		expect(folded).toContain(`href="/projects/${idle.id}"`);
		expect(folded).toContain("タスクの無いプロジェクト");
	});
	it("設定では、上書きの無いプロジェクトを畳む", async () => {
		const own = await newProject();
		const plain = await newProject();
		expect((await putSetting(own.id, 2)).status).toBe(200);
		const { body } = await text("/settings");
		const [open, folded = ""] = body.split("<details>");
		expect(open).toContain(`data-setting-scope="${own.id}"`);
		expect(folded).toContain(`data-setting-scope="${plain.id}"`);
		expect((await putSetting(own.id, null)).status).toBe(200);
	});

	it("AI が書いた件名や本文を、HTML として解釈させない", async () => {
		const project = await newProject();
		const task = await newTask(
			project.id,
			{
				title: "<script>alert(1)</script>",
				body: "<img src=x onerror=alert(2)>",
				labels: ['"><b>'],
			},
			working("yukarin"),
		);
		const safe = (body: string) => {
			expect(body).not.toContain("<script>alert(1)");
			expect(body).not.toContain("<img src=x");
			expect(body).not.toContain('"><b>');
			expect(body).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
		};
		for (const path of [
			`/projects/${project.id}`,
			`/tasks/${task.id}`,
			"/triage",
		]) {
			safe((await text(path)).body);
		}
		await patch(
			task.id,
			{ state: "review", waiting_on: "<img src=x onerror=alert(3)>" },
			working("yukarin"),
		);
		for (const path of ["/", `/tasks/${task.id}`]) {
			safe((await text(path)).body);
		}
	});
	it("ツリーを並び順で出し、絞り込みに合わない親は文脈として残す", async () => {
		const project = await newProject();
		const parent = await newTask(project.id, { title: "親のタスク" });
		const child = await newTask(project.id, {
			title: "子のタスク",
			parent_id: parent.id,
		});
		await newTask(project.id, { title: "別の根" });
		await patch(child.id, { state: "todo" });

		const all = (await text(`/projects/${project.id}`)).body;
		expect(all.indexOf("親のタスク")).toBeLessThan(all.indexOf("子のタスク"));
		expect(all).toContain("別の根");

		const todo = (await text(`/projects/${project.id}?state=todo`)).body;
		expect(todo).toContain("子のタスク");
		expect(todo).toMatch(/class="row context">[^\n]*親のタスク/);
		expect(todo).not.toContain("別の根");

		const done = (await text(`/projects/${project.id}?state=done`)).body;
		expect(done).toContain("当てはまるタスクは無い");
	});

	it("既定では done と dropped を出さず、all ですべて出す", async () => {
		const project = await newProject();
		const closed = await newTask(project.id, { title: "片付いたもの" });
		await patch(closed.id, { state: "done" });
		expect((await text(`/projects/${project.id}`)).body).not.toContain(
			"片付いたもの",
		);
		expect((await text(`/projects/${project.id}?state=all`)).body).toContain(
			"片付いたもの",
		);
	});

	it("並びを動かす相手は、同じ親の前後のタスクにする", async () => {
		const project = await newProject();
		const one = await newTask(project.id);
		const two = await newTask(project.id);
		const { body } = await text(`/projects/${project.id}`);
		expect(body).toContain(
			`data-move="${two.id}" data-dir="before" data-anchor="${one.id}"`,
		);
		expect(body).toContain(
			`data-move="${one.id}" data-dir="after" data-anchor="${two.id}"`,
		);
	});

	it("件数が多いプロジェクトでも、ツリーを途中で切らない", async () => {
		const project = await newProject();
		const at = new Date().toISOString();
		const rows = Array.from({ length: 120 }, (_, i) => ({
			id: `bulk-${project.id}-${i}`,
			key: `b${String(i).padStart(3, "0")}`,
		}));
		await env.DB.batch(
			rows.map((r) =>
				env.DB.prepare(
					"INSERT INTO tasks (id, project_id, title, order_key, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, 'owner', ?, ?)",
				).bind(r.id, project.id, `量産 ${r.key}`, r.key, at, at),
			),
		);
		const { body } = await text(`/projects/${project.id}`);
		expect(body.match(/class="title"/g)).toHaveLength(120);
	});

	it("子を持つタスクに、子孫の末端の進み具合をバーで出す", async () => {
		const project = await newProject();
		const parent = await newTask(project.id, { title: "進む親" });
		const done = await newTask(project.id, { parent_id: parent.id });
		await newTask(project.id, { parent_id: parent.id });
		const dropped = await newTask(project.id, { parent_id: parent.id });
		await patch(done.id, { state: "done" });
		await patch(dropped.id, { state: "dropped" });

		const bar =
			'<progress value="1" max="2"></progress><span class="who">1 / 2</span>';
		expect((await text(`/projects/${project.id}`)).body).toContain(bar);
		expect((await text(`/tasks/${parent.id}`)).body).toContain(bar);
		expect((await text(`/tasks/${done.id}`)).body).not.toContain("<progress");
	});

	it("タスクの画面に、本文・親子・変える欄・会話を出す", async () => {
		const project = await newProject();
		const parent = await newTask(project.id, { title: "親の件名" });
		const task = await newTask(
			project.id,
			{
				title: "見るタスク",
				body: "本文の 1 行目\n2 行目",
				parent_id: parent.id,
			},
			working("yukarin"),
		);
		await newTask(project.id, { title: "孫の件名", parent_id: task.id });
		await patch(task.id, { assignee_id: "akarin", labels: ["infra"] }, mac);
		await patch(task.id, {
			state: "review",
			waiting_on: "進めてよいか",
			note: "<b>方針</b>を決めた",
		});
		await patch(task.id, { order: { before: parent.id } });

		const { status, body } = await text(`/tasks/${task.id}`);
		expect(status).toBe(200);
		expect(body).toContain("本文の 1 行目\n2 行目");
		expect(body).toContain(`<a href="/tasks/${parent.id}">親の件名</a>`);
		expect(body).toContain("孫の件名");
		expect(body).toContain(
			`data-task="${task.id}" data-state="review" data-assignee="akarin" data-labels="[&quot;infra&quot;]" data-waiting="進めてよいか"`,
		);
		expect(body).toContain('<option value="akarin" selected>Akarin</option>');
		expect(body).not.toContain('<option value="retired"');
		expect(body).toMatch(/value="infra" checked/);
		// 起票は本文のカードに、呼び出し元つきで出す
		expect(body).toMatch(
			/<b>Yukarin<\/b> が起票した<\/span><span class="when"><time [^>]+>[^<]+<\/time><span class="via">working<\/span>/,
		);

		const timeline = timelineOf(body);
		const entry = (title: string) => pieceOf(timeline, '<li class="ev', title);
		expect(entry("担当を")).toContain("<b>Owner</b> が担当を Akarin にした");
		expect(entry("担当を")).toContain('<span class="via">mac-agent</span>');
		expect(entry("担当を")).toContain('<span class="label">infra</span>');
		const question = entry("review にした");
		expect(question).toContain('<span class="via">ブラウザ</span>');
		expect(question).toContain('<p class="bt">進めてよいか</p>');
		expect(question).toContain(
			'<p class="bt note">&lt;b&gt;方針&lt;/b&gt;を決めた</p>',
		);
		// 新しいものを上に出し、order=asc で古い順にする
		expect(timeline.indexOf("並びを変えた")).toBeLessThan(
			timeline.indexOf("review にした"),
		);
		const asc = timelineOf((await text(`/tasks/${task.id}?order=asc`)).body);
		expect(asc.indexOf("review にした")).toBeLessThan(
			asc.indexOf("並びを変えた"),
		);
		// ID や order_key をそのまま並べない
		expect(timeline).not.toContain("akarin<");
		expect(timeline).not.toContain("order_key");
	});
	/** 件名を含む 1 件ぶんの HTML。区切りは、その画面で 1 件を包む開始タグ */
	const pieceOf = (body: string, open: string, title: string) =>
		body.split(open).find((piece) => piece.includes(title)) ?? "";

	it("Triage に、AI が起票した未仕分けの backlog をプロジェクトをまたいで出し、先頭から 1 件ずつ捌く", async () => {
		const a = await projectWithRepo();
		const b = await newProject();
		const origin = await newTask(a.id, { title: "仕分けの元の作業" });
		const run = await startRun(origin.id, "seat-triage", working("yukarin"));
		const found = await newTask(
			b.id,
			{
				title: "作業中に見つけた課題",
				labels: ["found"],
				discovered_from: { task_id: origin.id, run_id: run.id },
			},
			working("yukarin"),
		);
		const plain = await newTask(
			a.id,
			{ title: "関係の無い AI の起票" },
			working("akarin"),
		);
		await newTask(a.id, { title: "owner が起票した backlog" });
		const raised = await newTask(
			a.id,
			{ title: "もう todo に上げた" },
			working("yukarin"),
		);
		await patch(raised.id, { state: "todo" });
		const kept = await newTask(
			a.id,
			{ title: "backlog に残すと決めた" },
			working("yukarin"),
		);
		expect(
			(await call(owner, "POST", `/v1/tasks/${kept.id}/triage`)).status,
		).toBe(200);

		const { status, body } = await text("/triage");
		expect(status).toBe(200);
		const list = sideOf(body);
		expect(list).not.toContain("owner が起票した backlog");
		expect(list).not.toContain("もう todo に上げた");
		expect(list).not.toContain("backlog に残すと決めた");

		const item = pieceOf(list, '<a class="item"', "作業中に見つけた課題");
		expect(item).toContain(`href="/tasks/${found.id}?from=triage"`);
		expect(item).toContain("<span>Yukarin</span>");
		expect(item).toContain("「仕分けの元の作業」の作業中に見つけた");
		const other = pieceOf(list, '<a class="item"', "関係の無い AI の起票");
		expect(other).toContain("<span>Akarin</span>");
		expect(other).not.toContain("の作業中に見つけた");
		expect(list.indexOf(found.id)).toBeLessThan(list.indexOf(plain.id));

		// 一覧の先頭のタスクを、仕分けのボタンつきで開いておく
		const firstId = list.match(/href="\/tasks\/([^?]+)\?from=triage"/)?.[1];
		for (const action of ["todo", "dropped", "keep"]) {
			expect(body).toContain(
				`data-triage="${firstId}" data-action="${action}"`,
			);
		}
		expect(body).toContain('<body class="pane-detail">');

		const opened = (await text(`/tasks/${found.id}?from=triage`)).body;
		expect(opened).toMatch(
			new RegExp(
				`data-triage="${found.id}" data-action="todo" data-next="/(tasks/[^"]+\\?from=triage|triage)"`,
			),
		);
		const meta = metaOf(opened);
		expect(meta).toContain(
			`見つけた元: <a href="/tasks/${origin.id}">仕分けの元の作業</a>`,
		);
		expect(meta).toContain("席 seat-triage");
		expect(meta).toContain('<span class="label">found</span>');

		// 件数は、一覧の行と切り替えで一致し、他の画面にも出る
		const count = list.match(/<a class="item"/g)?.length ?? 0;
		expect(list).toContain(`<span>${count} 件</span>`);
		expect(body).toContain(
			`<a href="/triage" aria-current="page">Triage<span class="count">${count}</span></a>`,
		);
		const tab = `<a href="/triage">Triage<span class="count">${count}</span></a>`;
		expect((await text("/")).body).toContain(tab);
		expect((await text("/settings")).body).toContain(tab);
		expect((await text("/nowhere")).body).toContain(tab);

		await patch(found.id, { state: "dropped" });
		const after = (await text("/triage")).body;
		expect(sideOf(after)).not.toContain("作業中に見つけた課題");
		expect(after).toContain(`Triage<span class="count">${count - 1}</span>`);
	});
	it("Triage が 0 件でも、画面を出す", () => {
		const body = renderInbox({
			list: { kind: "triage", rows: [] },
			projects: [],
			names: new Map(),
			now: new Date(),
			nav: { review: 0, triage: 0, doing: 0, syncWarnings: 0 },
			detail: null,
			pane: "list",
		});
		expect(body).toContain("仕分けを待っているタスクは無い");
		expect(body).toContain("<span>0 件</span>");
		expect(body).toContain(
			'<a href="/triage" aria-current="page">Triage<span class="count">0</span></a>',
		);
		expect(body).not.toContain("data-triage");
	});
	it("設定に、効いている値と出どころを出し、自分の値がある scope にだけ戻すボタンを出す", async () => {
		const project = await newProject();
		const form = async (scope: string) =>
			pieceOf(
				(await text("/settings")).body,
				"<form ",
				`data-setting-scope="${scope}"`,
			).split("</form>")[0] ?? "";

		expect((await putSetting("global", null)).status).toBe(200);
		let global = await form("global");
		expect(global).toContain(
			'効いている値 <strong>3</strong></span><span class="label">既定</span>',
		);
		expect(global).toContain('data-key="max_self_todo_depth"');
		expect(global).not.toContain("data-setting-reset");
		expect(global).not.toContain(" value=");

		await putSetting("global", 5);
		global = await form("global");
		expect(global).toContain(
			'効いている値 <strong>5</strong></span><span class="label">全体</span>',
		);
		expect(global).toContain('required value="5"');
		expect(global).toContain("data-setting-reset>既定に戻す</button>");
		let own = await form(project.id);
		expect(own).toContain(
			'効いている値 <strong>5</strong></span><span class="label">全体</span>',
		);
		expect(own).not.toContain("data-setting-reset");
		expect(own).not.toContain(" value=");

		await putSetting(project.id, 0);
		own = await form(project.id);
		expect(own).toContain(
			'効いている値 <strong>0</strong></span><span class="label">プロジェクト</span>',
		);
		expect(own).toContain('required value="0"');
		expect(own).toContain("data-setting-reset>上書きを消す</button>");

		await putSetting(project.id, null);
		expect(await form(project.id)).toContain('<span class="label">全体</span>');
		await putSetting("global", null);
		expect(await form(project.id)).toContain('<span class="label">既定</span>');
	});

	it("タスクの画面に、関係を両方の向きから、実行記録を席と actor つきで出す", async () => {
		const project = await projectWithRepo();
		const base = await newTask(project.id, { title: "席に渡したタスク" });
		const run = await startRun(base.id, "seat-view", working("yukarin"));
		const found = await newTask(
			project.id,
			{
				title: "見つけた課題のタスク",
				discovered_from: { task_id: base.id, run_id: run.id },
			},
			working("yukarin"),
		);
		const next = await newTask(project.id, { title: "続きのタスク" });
		const redo = await newTask(project.id, { title: "作り直したタスク" });
		expect((await relate(next.id, "follows", base.id)).status).toBe(200);
		expect((await relate(base.id, "replaced_by", redo.id)).status).toBe(200);

		const row = async (taskId: string, title: string) =>
			pieceOf(
				metaOf((await text(`/tasks/${taskId}`)).body),
				'<div class="rel">',
				title,
			);

		const seen = await row(base.id, "見つけた課題のタスク");
		expect(seen).toContain("ここで見つけた: ");
		expect(seen).toContain("席 seat-view");
		expect(await row(base.id, "続きのタスク")).toContain("続き: ");
		expect(await row(base.id, "作り直したタスク")).toContain("作り直した先: ");
		const origin = await row(found.id, "席に渡したタスク");
		expect(origin).toContain("見つけた元: ");
		expect(origin).toContain(`href="/tasks/${base.id}"`);
		expect(origin).toContain("席 seat-view");
		expect(await row(next.id, "席に渡したタスク")).toContain("区切った元: ");
		expect(await row(redo.id, "席に渡したタスク")).toContain("作り直す前: ");

		const runs = async () => {
			const meta = metaOf((await text(`/tasks/${base.id}`)).body);
			return meta.slice(meta.indexOf('<span class="mlabel">実行記録</span>'));
		};
		const open = await runs();
		expect(open).toContain("席 seat-view の Yukarin");
		expect(open).toContain("model-x");
		expect(open).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2} から 実行中/);
		await call(working("yukarin"), "POST", `/v1/runs/${run.id}/end`);
		expect(await runs()).toMatch(
			/\d{4}-\d{2}-\d{2} \d{2}:\d{2} から \d{4}-\d{2}-\d{2} \d{2}:\d{2} まで/,
		);

		const none = (await text(`/tasks/${redo.id}`)).body;
		expect(none).not.toContain('<span class="mlabel">実行記録</span>');
	});

	it("Doing の一覧に、閉じていない run の席か、席に渡していないことと、子タスクの進み具合を出す", async () => {
		const project = await projectWithRepo();
		const seated = await newTask(project.id, {
			title: "席で作業中",
			state: "todo",
		});
		await patch(seated.id, { state: "doing" });
		await startRun(seated.id, "seat-doing", working("yukarin"));
		const parent = await newTask(project.id, {
			title: "子を持つ作業中",
			state: "todo",
		});
		await patch(parent.id, { state: "doing" });
		const child = await newTask(project.id, {
			title: "済んだ子",
			parent_id: parent.id,
		});
		// 子がすべて片付くと親が review に移るので、残る子を先に作る
		await newTask(project.id, { title: "残る子", parent_id: parent.id });
		await patch(child.id, { state: "done" });

		const { body } = await text("/doing");
		const list = sideOf(body);
		expect(pieceOf(list, '<a class="item"', "席で作業中")).toContain(
			"席 seat-doing の Yukarin",
		);
		const item = pieceOf(list, '<a class="item"', "子を持つ作業中");
		expect(item).toContain("席に渡していない");
		expect(item).toContain("子タスク 1 / 2 済み");
		expect(body).toContain('<body class="pane-list">');
	});
});
