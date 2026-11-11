import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeGitHub, type FakePull, TOKEN } from "./github-fake.ts";
import {
	type As,
	appWithGitHub,
	eventsOf,
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

const gh = new FakeGitHub();
const { app, env: tokenEnv, call } = appWithGitHub(gh.fetch, TOKEN);
const withoutToken = appWithGitHub(gh.fetch);

beforeEach(() => {
	gh.calls = [];
	gh.down = null;
});

type LinkJson = {
	id: string;
	owner_type: string;
	owner_id: string;
	role: string;
	kind: string;
	url: string;
	title: string;
	note: string;
	linked_by: string;
	github: {
		repo: string;
		number: number;
		base_branch: string | null;
		draft: boolean | null;
		state: string | null;
		merged_into_default: boolean | null;
		review: string | null;
		checks: string | null;
		synced_at: string | null;
	} | null;
	warnings: string[];
};

type SyncJson = {
	skipped: boolean;
	synced: number;
	linked: { task_id: string; url: string }[];
	done: string[];
	warnings: string[];
};

let seq = 0;

/** repo を 1 つ紐付けたプロジェクト。repo はテストごとに別の名前にして、他のテストの PR と混ざらないようにする */
const setup = async () => {
	const project = await newProject();
	const repo = `example/repo-${++seq}`;
	gh.repo(repo);
	await call(owner, "POST", `/v1/projects/${project.id}/repos`, { repo });
	return { project, repo };
};

const link = (taskId: string, body: Record<string, unknown>, as: As = owner) =>
	call(as, "POST", `/v1/tasks/${taskId}/links`, body);

const deliver = async (
	taskId: string,
	repo: string,
	number: number,
	pull: Partial<FakePull> = {},
	as: As = owner,
) => {
	gh.pull(repo, number, pull);
	const res = await link(
		taskId,
		{ url: `https://github.com/${repo}/pull/${number}`, role: "deliverable" },
		as,
	);
	expect(res.status).toBe(201);
	return res.json<LinkJson>();
};

const sync = async (as: As = mac) => {
	const res = await call(as, "POST", "/v1/sync");
	expect(res.status).toBe(200);
	return res.json<SyncJson>();
};

const read = async (taskId: string) =>
	(await call(owner, "GET", `/v1/tasks/${taskId}`)).json<
		TaskJson & { links: LinkJson[] }
	>();

const MERGED = { state: "MERGED" } as const;

describe("リンクを付ける", () => {
	it("参考リンクは URL から種類を決め、GitHub を呼ばずに貼るだけ", async () => {
		const { project } = await setup();
		const task = await newTask(project.id);
		const cases = [
			[
				"https://github.com/example/app/issues/3#issuecomment-1",
				"github_issue",
			],
			["https://github.com/example/app/pull/4/files", "github_pr"],
			["https://www.notion.so/example/page-123", "notion"],
			["https://x.com/example/status/1", "x"],
			["https://example.com/paper.pdf", "url"],
		];
		for (const [url, kind] of cases) {
			const res = await link(task.id, { url, role: "reference", title: kind });
			expect(res.status).toBe(201);
			expect(await res.json()).toMatchObject({
				kind,
				role: "reference",
				github: null,
				linked_by: "owner",
				warnings: [],
			});
		}
		expect(gh.calls).toEqual([]);
		const got = await read(task.id);
		expect(got.links.map((l) => l.kind)).toEqual(cases.map(([, kind]) => kind));
		expect(got.links[0]?.url).toBe("https://github.com/example/app/issues/3");
		expect(got.links[1]?.url).toBe("https://github.com/example/app/pull/4");
	});

	it("プロジェクトにも参考リンクを付けられ、プロジェクトの読み取りで返る", async () => {
		const { project } = await setup();
		const res = await call(owner, "POST", `/v1/projects/${project.id}/links`, {
			url: "https://example.com/research",
			role: "reference",
			title: "調査メモ",
			note: "repo を作る前の資料",
		});
		expect(res.status).toBe(201);
		const { projects } = await (await call(owner, "GET", "/v1/projects")).json<{
			projects: { id: string; links: LinkJson[] }[];
		}>();
		expect(projects.find((p) => p.id === project.id)?.links).toMatchObject([
			{ title: "調査メモ", note: "repo を作る前の資料", kind: "url" },
		]);
		expect((await eventsOf(project.id)).at(-1)).toMatchObject({
			entity: "project",
			field: "link",
			actor_id: "owner",
		});
	});

	it("成果物にできるのは、タスクに付ける GitHub の PR だけ", async () => {
		const { project, repo } = await setup();
		const task = await newTask(project.id);
		for (const url of [
			`https://github.com/${repo}/issues/1`,
			"https://example.com/",
		]) {
			const res = await link(task.id, { url, role: "deliverable" });
			expect(res.status).toBe(400);
			expect(await res.json()).toMatchObject({
				error: "deliverable_must_be_pull",
			});
		}
		gh.pull(repo, 1);
		const onProject = await call(
			owner,
			"POST",
			`/v1/projects/${project.id}/links`,
			{ url: `https://github.com/${repo}/pull/1`, role: "deliverable" },
		);
		expect(onProject.status).toBe(400);
		const bad = await link(task.id, {
			url: "javascript:alert(1)",
			role: "reference",
		});
		expect(bad.status).toBe(400);
		expect(await bad.json()).toMatchObject({ error: "invalid_url" });
		expect(
			(await link("nope", { url: "https://example.com/", role: "reference" }))
				.status,
		).toBe(404);
	});

	it("AI が成果物の PR を付けると、状態を取り込み、actor のラベルを付け、履歴に残す", async () => {
		const { project, repo } = await setup();
		gh.repos.get(repo)?.labels.add("actor:yukarin");
		const task = await newTask(project.id);
		const created = await deliver(
			task.id,
			repo,
			7,
			{ title: "機能を足す", isDraft: true, reviews: ["APPROVED"] },
			working("yukarin"),
		);
		expect(created).toMatchObject({
			role: "deliverable",
			kind: "github_pr",
			title: "機能を足す",
			linked_by: "yukarin",
			warnings: [],
			github: {
				repo,
				number: 7,
				base_branch: "main",
				draft: true,
				state: "open",
				merged_into_default: false,
				review: "approved",
				checks: "success",
			},
		});
		expect(created.github?.synced_at).toBeTruthy();
		expect(gh.repos.get(repo)?.pulls.get(7)?.labels).toEqual(["actor:yukarin"]);
		expect((await eventsOf(task.id)).at(-1)).toMatchObject({
			entity: "task",
			field: "link",
			actor_id: "yukarin",
			caller_id: WORKING.id,
			before: null,
		});
	});

	it("ラベルが repo に定義されていなければ、作らずに警告を返し、リンクは付ける", async () => {
		const { project, repo } = await setup();
		const task = await newTask(project.id);
		const created = await deliver(task.id, repo, 1, {}, working("akarin"));
		expect(created.warnings).toEqual([
			`${repo} にラベル actor:akarin が定義されていないので、付けていない`,
		]);
		expect(gh.count("POST /repos")).toBe(0);
		expect(gh.repos.get(repo)?.labels.has("actor:akarin")).toBe(false);
		expect((await read(task.id)).links).toHaveLength(1);
	});

	it("owner が付けた PR にはラベルを付けない", async () => {
		const { project, repo } = await setup();
		gh.repos.get(repo)?.labels.add("actor:owner");
		const task = await newTask(project.id);
		const created = await deliver(task.id, repo, 1);
		expect(created.warnings).toEqual([]);
		expect(gh.repos.get(repo)?.pulls.get(1)?.labels).toEqual([]);
		expect(gh.calls).toEqual(["POST /graphql"]);
	});

	it("プロジェクトに紐付いていない repo の PR を付けると、repo をプロジェクトに足して履歴に残す", async () => {
		const { project, repo } = await setup();
		const other = `example/other-${++seq}`;
		gh.repo(other);
		const task = await newTask(project.id);
		await deliver(task.id, other, 2, {}, working("yukarin"));
		const { projects } = await (await call(owner, "GET", "/v1/projects")).json<{
			projects: { id: string; repos: string[] }[];
		}>();
		expect(projects.find((p) => p.id === project.id)?.repos).toEqual(
			[other, repo].sort(),
		);
		expect((await eventsOf(project.id)).at(-1)).toMatchObject({
			field: "repos",
			actor_id: "yukarin",
			after: JSON.stringify(other),
		});
	});

	it("無い PR は付けない。同じ URL は二重に付かず、役割が違えば拒む", async () => {
		const { project, repo } = await setup();
		const task = await newTask(project.id);
		const url = `https://github.com/${repo}/pull/9`;
		const missing = await link(task.id, { url, role: "deliverable" });
		expect(missing.status).toBe(400);
		expect(await missing.json()).toMatchObject({ error: "pull_not_found" });

		const first = await deliver(task.id, repo, 9);
		const again = await link(task.id, {
			url: `${url}/files`,
			role: "deliverable",
		});
		expect((await again.json<LinkJson>()).id).toBe(first.id);
		const other = await link(task.id, { url, role: "reference" });
		expect(other.status).toBe(409);
		expect((await read(task.id)).links).toHaveLength(1);
	});

	it("リンクを消すと、前の値を履歴に残す", async () => {
		const { project, repo } = await setup();
		const task = await newTask(project.id);
		const created = await deliver(task.id, repo, 1);
		const res = await call(mac, "DELETE", `/v1/links/${created.id}`);
		expect(res.status).toBe(200);
		expect((await read(task.id)).links).toEqual([]);
		const last = (await eventsOf(task.id)).at(-1);
		expect(last).toMatchObject({ field: "link", after: null });
		expect(JSON.parse(last?.before ?? "null")).toMatchObject({
			id: created.id,
			github: { number: 1 },
		});
		expect((await call(mac, "DELETE", `/v1/links/${created.id}`)).status).toBe(
			404,
		);
	});
});

describe("token が無いとき", () => {
	it("同期とラベル付けを止めて警告を出し、ほかは動く", async () => {
		const { project, repo } = await setup();
		gh.repos.get(repo)?.labels.add("actor:yukarin");
		gh.pull(repo, 1, MERGED);
		const task = await newTask(project.id, { state: "todo" });
		const res = await withoutToken.call(
			working("yukarin"),
			"POST",
			`/v1/tasks/${task.id}/links`,
			{ url: `https://github.com/${repo}/pull/1`, role: "deliverable" },
		);
		expect(res.status).toBe(201);
		const created = await res.json<LinkJson>();
		expect(created.warnings).toHaveLength(1);
		expect(created.warnings[0]).toContain("token が無い");
		expect(created.github).toMatchObject({
			number: 1,
			state: null,
			synced_at: null,
		});

		const synced = await withoutToken.call(mac, "POST", "/v1/sync");
		expect(await synced.json()).toMatchObject({ skipped: true, done: [] });
		expect(gh.calls).toEqual([]);
		// 状態を取り込めていない PR は、done の条件を満たさない
		expect((await read(task.id)).state).toBe("todo");
		const ref = await withoutToken.call(
			owner,
			"POST",
			`/v1/tasks/${task.id}/links`,
			{
				url: "https://example.com/",
				role: "reference",
			},
		);
		expect(ref.status).toBe(201);
	});
});

describe("同期", () => {
	it("PR の状態を取り込み直すが、履歴には残さない", async () => {
		const { project, repo } = await setup();
		const task = await newTask(project.id, { state: "todo" });
		await deliver(task.id, repo, 1);
		const before = await eventsOf(task.id);
		gh.pull(repo, 1, {
			reviews: ["APPROVED", "CHANGES_REQUESTED"],
			rollup: "FAILURE",
			baseRefName: "feature",
		});
		await sync();
		expect((await read(task.id)).links[0]?.github).toMatchObject({
			state: "open",
			base_branch: "feature",
			review: "changes_requested",
			checks: "failure",
		});
		expect(await eventsOf(task.id)).toEqual(before);
	});

	it("レビューが必須で、まだ無ければ review_required", async () => {
		const { project, repo } = await setup();
		const task = await newTask(project.id);
		const created = await deliver(task.id, repo, 1, {
			reviewDecision: "REVIEW_REQUIRED",
		});
		expect(created.github?.review).toBe("review_required");
	});

	it("statusCheckRollup を読めなければ、workflow run と commit status から CI の結果を決める", async () => {
		const { project, repo } = await setup();
		const fake = gh.repos.get(repo);
		const task = await newTask(project.id);
		const run = (
			workflow_id: number,
			status: string,
			conclusion: string | null,
			created_at: string,
		) => ({
			workflow_id,
			status,
			conclusion,
			created_at,
		});
		const none = { state: "pending", total_count: 0 };
		const check = async (number: number) =>
			(await deliver(task.id, repo, number, { rollup: null })).github?.checks;

		// 流し直して通った workflow は、新しい run だけを見る
		fake?.runs.set("sha-1", [
			run(1, "completed", "failure", "2026-01-01T00:00:00Z"),
			run(1, "completed", "success", "2026-01-01T01:00:00Z"),
			run(2, "completed", "skipped", "2026-01-01T00:00:00Z"),
		]);
		fake?.statuses.set("sha-1", none);
		expect(await check(1)).toBe("success");

		fake?.runs.set("sha-2", [
			run(1, "in_progress", null, "2026-01-01T00:00:00Z"),
		]);
		fake?.statuses.set("sha-2", none);
		expect(await check(2)).toBe("pending");

		fake?.runs.set("sha-3", [
			run(1, "completed", "success", "2026-01-01T00:00:00Z"),
		]);
		fake?.statuses.set("sha-3", { state: "failure", total_count: 1 });
		expect(await check(3)).toBe("failure");

		fake?.runs.set("sha-4", []);
		fake?.statuses.set("sha-4", none);
		expect(await check(4)).toBe("none");
	});

	it("CI の結果を読めない repo でも同期は失敗せず、結果は不明として持つ", async () => {
		const { project, repo } = await setup();
		const task = await newTask(project.id, { state: "todo" });
		const created = await deliver(task.id, repo, 1, { rollup: null });
		expect(created.github).toMatchObject({ state: "open", checks: null });
		gh.pull(repo, 1, MERGED);
		const result = await sync();
		expect(result.done).toContain(task.id);
		expect((await read(task.id)).links[0]?.github).toMatchObject({
			state: "merged",
			checks: null,
		});
	});

	it("GitHub が落ちていても例外にせず、警告を返す", async () => {
		const { project, repo } = await setup();
		const task = await newTask(project.id, { state: "todo" });
		await deliver(task.id, repo, 1);
		gh.down = 503;
		const result = await sync();
		expect(result.skipped).toBe(false);
		expect(result.warnings.join("\n")).toContain("503");
		expect((await read(task.id)).state).toBe("todo");
	});

	it("Cron からも動き、自動の遷移は sync の actor で、呼び出し元なしで残る", async () => {
		const { project, repo } = await setup();
		const task = await newTask(project.id, { state: "todo" });
		await deliver(task.id, repo, 1, MERGED);
		const pending: Promise<unknown>[] = [];
		await app.scheduled({} as ScheduledController, tokenEnv, {
			waitUntil: (p: Promise<unknown>) => pending.push(p),
		} as unknown as ExecutionContext);
		await Promise.all(pending);
		expect((await read(task.id)).state).toBe("done");
		const page = await (await call(owner, "GET", `/tasks/${task.id}`)).text();
		expect(page).toContain("同期・Cron・");
		expect((await eventsOf(task.id)).at(-1)).toMatchObject({
			field: "state",
			actor_id: "sync",
			caller_id: null,
			before: JSON.stringify("todo"),
			after: JSON.stringify("done"),
		});
	});
});

describe("印による自動リンク", () => {
	it("紐付いた repo の PR の本文に印があれば、担当のラベルを付けて成果物にする", async () => {
		const { project, repo } = await setup();
		gh.repos.get(repo)?.labels.add("actor:yukarin");
		const task = await newTask(project.id, {
			state: "todo",
			assignee_id: "yukarin",
		});
		const unassigned = await newTask(project.id, { state: "todo" });
		gh.pull(repo, 1, {
			title: "印つき",
			body: `対応した。\n\nchakai:${task.id}\nchakai:${unassigned.id.toUpperCase()}`,
		});
		gh.pull(repo, 2, { body: "chakai:not-a-task-id" });
		const result = await sync();
		const url = `https://github.com/${repo}/pull/1`;
		expect(result.linked).toEqual(
			expect.arrayContaining([
				{ task_id: task.id, url },
				{ task_id: unassigned.id, url },
			]),
		);
		expect((await read(task.id)).links).toMatchObject([
			{
				role: "deliverable",
				title: "印つき",
				linked_by: "sync",
				github: { repo, number: 1, state: "open" },
			},
		]);
		expect(gh.repos.get(repo)?.pulls.get(1)?.labels).toEqual(["actor:yukarin"]);
		expect((await eventsOf(task.id)).at(-1)).toMatchObject({
			field: "link",
			actor_id: "sync",
		});
		expect((await read(unassigned.id)).links).toHaveLength(1);

		const again = await sync();
		expect(again.linked.filter((l) => l.url === url)).toEqual([]);
		expect((await read(task.id)).links).toHaveLength(1);
	});

	it("担当のラベルが定義されていなければ、リンクは付けて警告を残す", async () => {
		const { project, repo } = await setup();
		const task = await newTask(project.id, { assignee_id: "akarin" });
		gh.pull(repo, 1, { body: `chakai:${task.id}` });
		const result = await sync();
		expect(result.warnings).toContain(
			`${repo} にラベル actor:akarin が定義されていないので、付けていない`,
		);
		expect((await read(task.id)).links).toHaveLength(1);
		expect(gh.repos.get(repo)?.pulls.get(1)?.labels).toEqual([]);
	});

	it("タスクのプロジェクトに紐付いていない repo の PR は拾わない", async () => {
		const a = await setup();
		const b = await setup();
		const task = await newTask(a.project.id);
		gh.pull(b.repo, 1, { body: `chakai:${task.id}` });
		await sync();
		expect((await read(task.id)).links).toEqual([]);
	});

	it("開いている PR と、前回の同期の後に更新された PR を見る", async () => {
		const { project, repo } = await setup();
		const early = await newTask(project.id, { state: "todo" });
		const late = await newTask(project.id, { state: "todo" });
		const old = await newTask(project.id, { state: "todo" });
		await sync();
		const { results } = await env.DB.prepare(
			"SELECT scanned_at FROM project_repos WHERE repo = ?",
		)
			.bind(repo)
			.all<{ scanned_at: string }>();
		const scannedAt = results[0]?.scanned_at ?? "";
		expect(scannedAt).toBeTruthy();

		const before = new Date(Date.parse(scannedAt) - 60_000).toISOString();
		// 前回の同期より前から開いたままの PR
		gh.pull(repo, 1, { body: `chakai:${early.id}`, updatedAt: before });
		// 同期と同期の間に開いて merge された PR
		gh.pull(repo, 2, { ...MERGED, body: `chakai:${late.id}` });
		// 前回の同期より前に閉じた PR は、もう見ない
		gh.pull(repo, 3, {
			...MERGED,
			body: `chakai:${old.id}`,
			updatedAt: before,
		});
		const result = await sync();
		expect((await read(early.id)).links).toHaveLength(1);
		expect((await read(late.id)).links).toHaveLength(1);
		expect((await read(old.id)).links).toEqual([]);
		expect(result.done).toContain(late.id);
	});

	it("読めない repo があっても、ほかの repo は見終え、読めない repo の起点は進めない", async () => {
		const { project, repo } = await setup();
		const gone = `example/gone-${++seq}`;
		await call(owner, "POST", `/v1/projects/${project.id}/repos`, {
			repo: gone,
		});
		const task = await newTask(project.id);
		gh.pull(repo, 1, { body: `chakai:${task.id}` });
		const result = await sync();
		expect(result.warnings).toContain(`${gone} の PR を読み終えられなかった`);
		expect((await read(task.id)).links).toHaveLength(1);
		const { results } = await env.DB.prepare(
			"SELECT repo, scanned_at FROM project_repos WHERE project_id = ? ORDER BY repo",
		)
			.bind(project.id)
			.all<{ repo: string; scanned_at: string | null }>();
		expect(results.find((r) => r.repo === gone)?.scanned_at).toBeNull();
		expect(results.find((r) => r.repo === repo)?.scanned_at).toBeTruthy();
		await env.DB.prepare("DELETE FROM project_repos WHERE repo = ?")
			.bind(gone)
			.run();
	});

	it("開いている PR が 1 ページを超えても、続きを読む", async () => {
		const { project, repo } = await setup();
		const task = await newTask(project.id);
		for (let i = 1; i <= 60; i++) {
			gh.pull(repo, i, {
				updatedAt: new Date(Date.now() + i * 1000).toISOString(),
			});
		}
		gh.pull(repo, 100, {
			body: `chakai:${task.id}`,
			updatedAt: "2020-01-01T00:00:00.000Z",
		});
		await sync();
		expect((await read(task.id)).links).toHaveLength(1);
	});
});

describe("自動で done にする規則", () => {
	it("複数の PR は、すべてがデフォルトブランチに merge されてから done にする", async () => {
		const { project, repo } = await setup();
		const other = `example/second-${++seq}`;
		gh.repo(other, "trunk");
		const task = await newTask(project.id, { state: "todo" });
		await deliver(task.id, repo, 1, MERGED);
		await deliver(task.id, other, 2, { baseRefName: "trunk" });
		expect((await sync()).done).not.toContain(task.id);
		expect((await read(task.id)).state).toBe("todo");

		gh.pull(other, 2, MERGED);
		expect((await sync(mac)).done).toContain(task.id);
		const got = await read(task.id);
		expect(got.state).toBe("done");
		expect(got.links.map((l) => l.github?.merged_into_default)).toEqual([
			true,
			true,
		]);
		// 手動の同期は、呼んだ呼び出し元を残す
		expect((await eventsOf(task.id)).at(-1)).toMatchObject({
			field: "state",
			actor_id: "sync",
			caller_id: "caller-mac",
		});
	});

	it("merge せずに閉じた PR は除いて数える", async () => {
		const { project, repo } = await setup();
		const task = await newTask(project.id, { state: "todo" });
		await deliver(task.id, repo, 1, { state: "CLOSED" });
		await deliver(task.id, repo, 2, MERGED);
		expect((await sync()).done).toContain(task.id);
	});

	it("全部閉じて 1 つも merge していなければ、動かさない", async () => {
		const { project, repo } = await setup();
		const task = await newTask(project.id, { state: "todo" });
		await deliver(task.id, repo, 1, { state: "CLOSED" });
		await deliver(task.id, repo, 2, { state: "CLOSED" });
		expect((await sync()).done).not.toContain(task.id);
		expect((await read(task.id)).state).toBe("todo");
	});

	it("stack の途中で下の PR のブランチに merge された PR は数えない", async () => {
		const { project, repo } = await setup();
		const task = await newTask(project.id, { state: "todo" });
		await deliver(task.id, repo, 1, MERGED);
		await deliver(task.id, repo, 2, { ...MERGED, baseRefName: "feature-1" });
		expect((await sync()).done).not.toContain(task.id);
		const got = await read(task.id);
		expect(got.state).toBe("todo");
		expect(got.links[1]?.github).toMatchObject({
			state: "merged",
			base_branch: "feature-1",
			merged_into_default: false,
		});
	});

	it("子を持つタスクは done にせず、子が done になると親を review にする", async () => {
		const { project, repo } = await setup();
		const parent = await newTask(project.id, { state: "todo" });
		const child = await newTask(project.id, {
			parent_id: parent.id,
			state: "todo",
		});
		await deliver(parent.id, repo, 1, MERGED);
		expect((await sync()).done).toEqual(
			expect.not.arrayContaining([parent.id, child.id]),
		);
		expect((await read(parent.id)).state).toBe("todo");

		await deliver(child.id, repo, 2, MERGED);
		expect((await sync()).done).toContain(child.id);
		expect((await read(child.id)).state).toBe("done");
		expect(await read(parent.id)).toMatchObject({
			state: "review",
			waiting_on: "子タスクがすべて片付いた",
		});
		expect((await eventsOf(parent.id)).slice(-2)).toMatchObject([
			{ field: "state", actor_id: "sync", after: JSON.stringify("review") },
			{ field: "waiting_on", actor_id: "sync" },
		]);
	});

	it("review のタスクは done にして waiting_on を消し、backlog・done・dropped は動かさない", async () => {
		const { project, repo } = await setup();
		const review = await newTask(project.id, { state: "todo" });
		await call(owner, "PATCH", `/v1/tasks/${review.id}`, {
			state: "review",
			waiting_on: "方針を決めてほしい",
		});
		const backlog = await newTask(project.id);
		const dropped = await newTask(project.id);
		await call(owner, "PATCH", `/v1/tasks/${dropped.id}`, { state: "dropped" });
		await deliver(review.id, repo, 1, MERGED);
		await deliver(backlog.id, repo, 2, MERGED);
		await deliver(dropped.id, repo, 3, MERGED);
		expect((await sync()).done).toEqual(
			expect.not.arrayContaining([backlog.id, dropped.id]),
		);
		expect(await read(review.id)).toMatchObject({
			state: "done",
			waiting_on: null,
		});
		expect((await eventsOf(review.id)).slice(-2)).toMatchObject([
			{ field: "state", before: JSON.stringify("review") },
			{
				field: "waiting_on",
				before: JSON.stringify("方針を決めてほしい"),
				after: null,
			},
		]);
		expect((await read(backlog.id)).state).toBe("backlog");
		expect((await read(dropped.id)).state).toBe("dropped");
	});

	it("参考として付けた PR は数えない", async () => {
		const { project, repo } = await setup();
		const task = await newTask(project.id, { state: "todo" });
		gh.pull(repo, 1, MERGED);
		await link(task.id, {
			url: `https://github.com/${repo}/pull/1`,
			role: "reference",
			title: "関連する PR",
		});
		expect((await sync()).done).not.toContain(task.id);
	});
});

describe("画面と MCP", () => {
	it("タスクの画面に成果物の状態と参考リンクを、プロジェクトの画面に参考リンクを出す", async () => {
		const { project, repo } = await setup();
		const task = await newTask(project.id);
		await deliver(task.id, repo, 5, {
			title: "<b>PR</b>",
			reviews: ["APPROVED"],
			rollup: "FAILURE",
		});
		await link(task.id, {
			url: "https://example.com/doc",
			role: "reference",
			title: "参考の資料",
		});
		await call(owner, "POST", `/v1/projects/${project.id}/links`, {
			url: "https://www.notion.so/example/plan",
			role: "reference",
			title: "計画メモ",
		});
		const page = await (await call(owner, "GET", `/tasks/${task.id}`)).text();
		expect(page).toContain("成果物の PR");
		expect(page).toContain("&lt;b&gt;PR&lt;/b&gt;");
		expect(page).toContain(`${repo}#5`);
		expect(page).toContain("レビュー 承認");
		expect(page).toContain("CI 失敗");
		expect(page).toContain("同期 ");
		expect(page).toContain('href="https://example.com/doc"');
		expect(page).toContain("参考の資料");
		expect(page).toContain("成果物の PRを付けた");
		const projectPage = await (
			await call(owner, "GET", `/projects/${project.id}`)
		).text();
		expect(projectPage).toContain("計画メモ");
		expect(projectPage).toContain('href="https://www.notion.so/example/plan"');
	});

	it("MCP の add_link・remove_link・sync は REST と同じ結果を返す", async () => {
		const { project, repo } = await setup();
		const task = await newTask(project.id, { state: "todo" });
		gh.pull(repo, 1, MERGED);
		let id = 0;
		const tool = async (name: string, args: Record<string, unknown>) => {
			const res = await call(mac, "POST", "/mcp", {
				jsonrpc: "2.0",
				id: ++id,
				method: "tools/call",
				params: { name, arguments: args },
			});
			return (
				await res.json<{
					result: {
						structuredContent: Record<string, unknown>;
						isError?: boolean;
					};
				}>()
			).result;
		};
		const url = `https://github.com/${repo}/pull/1`;
		const both = await tool("add_link", {
			task_id: task.id,
			project_id: project.id,
			url,
			role: "reference",
		});
		expect(both.isError).toBe(true);
		const added = await tool("add_link", {
			task_id: task.id,
			url,
			role: "deliverable",
		});
		expect(added.structuredContent).toMatchObject({
			role: "deliverable",
			github: { state: "merged", merged_into_default: true },
		});
		const onProject = await tool("add_link", {
			project_id: project.id,
			url: "https://example.com/",
			role: "reference",
		});
		expect(onProject.structuredContent).toMatchObject({
			owner_type: "project",
		});
		const synced = await tool("sync", {});
		expect(synced.structuredContent.done).toContain(task.id);
		const removed = await tool("remove_link", {
			link_id: added.structuredContent.id,
		});
		expect(removed.isError).toBeUndefined();
		expect((await read(task.id)).links).toEqual([]);

		const init = await call(mac, "POST", "/mcp", {
			jsonrpc: "2.0",
			id: ++id,
			method: "initialize",
			params: {},
		});
		const { result } = await init.json<{ result: { instructions: string } }>();
		expect(result.instructions).toContain("chakai:<タスクの ID>");
		expect(result.instructions).toContain("add_link");
	});
});
