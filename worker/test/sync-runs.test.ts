import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { FakeGitHub, TOKEN } from "./github-fake.ts";
import {
	appWithGitHub,
	mac,
	newProject,
	newTask,
	owner,
	seedRoster,
	WORKING,
	working,
} from "./helpers.ts";

beforeAll(seedRoster);

const gh = new FakeGitHub();
const { app, env: tokenEnv, call } = appWithGitHub(gh.fetch, TOKEN);
const withoutToken = appWithGitHub(gh.fetch);

type RunJson = {
	at: string;
	trigger: string;
	actor_id: string;
	caller_id: string | null;
	skipped: boolean;
	synced: number;
	linked: number;
	done: number;
	warnings: string[];
};

const runs = async () =>
	(await (await call(mac, "GET", "/v1/sync-runs")).json<{ runs: RunJson[] }>())
		.runs;

const cron = async (environment: Env = tokenEnv) => {
	const pending: Promise<unknown>[] = [];
	await app.scheduled({} as ScheduledController, environment, {
		waitUntil: (p: Promise<unknown>) => pending.push(p),
	} as unknown as ExecutionContext);
	await Promise.all(pending);
};

const labelState = async (repo: string) =>
	(
		await env.DB.prepare(
			"SELECT number, actor_label, labeled_at FROM github_links WHERE repo = ? ORDER BY number",
		)
			.bind(repo)
			.all<{
				number: number;
				actor_label: string | null;
				labeled_at: string | null;
			}>()
	).results;

const setup = async (repo: string) => {
	const project = await newProject();
	gh.repo(repo);
	await call(owner, "POST", `/v1/projects/${project.id}/repos`, { repo });
	return project;
};

const page = async (path: string) => (await call(owner, "GET", path)).text();

describe("同期の結果を残す", () => {
	it("きっかけ、呼んだ人、数、警告を新しい順に返し、警告があれば画面で目に付く", async () => {
		const repo = "example/runs-0";
		const project = await setup(repo);
		const task = await newTask(project.id, { state: "todo" });
		gh.pull(repo, 1, { state: "MERGED", body: `chakai:${task.id}` });
		await cron();
		expect((await runs())[0]).toMatchObject({
			trigger: "cron",
			actor_id: "sync",
			caller_id: null,
			skipped: false,
			synced: 0,
			linked: 1,
			done: 1,
			warnings: [],
		});
		expect(await page("/")).toContain('<a href="/sync">同期</a>');
		expect(await page("/sync")).toContain(
			"印から付けたリンク 1・done にしたタスク 1",
		);

		gh.down = 503;
		await call(working("yukarin"), "POST", "/v1/sync");
		gh.down = null;
		const [latest, previous] = await runs();
		expect(latest).toMatchObject({
			trigger: "manual",
			actor_id: "yukarin",
			caller_id: WORKING.id,
		});
		expect(latest?.warnings.join("\n")).toContain("503");
		expect(previous?.trigger).toBe("cron");
		expect(await page("/")).toContain(
			`<a href="/sync">同期 <span class="n some">警告 ${latest?.warnings.length}</span></a>`,
		);
		const list = await page("/sync");
		expect(list).toContain("手動（Yukarin）");
		expect(list).toContain('<p class="alert">');
		expect(list).toContain("503");
	});

	it("token が無くて同期しなかった回と、例外で終わった回も残す", async () => {
		await withoutToken.call(mac, "POST", "/v1/sync");
		expect((await runs())[0]).toMatchObject({
			trigger: "manual",
			skipped: true,
		});
		expect((await runs())[0]?.warnings[0]).toContain("token が無い");

		const real = tokenEnv.DB;
		let calls = 0;
		// 最初の読み取りだけ失敗させ、結果を残す書き込みは通す
		const flaky = new Proxy(real, {
			get: (target, key) => {
				if (key === "prepare" && calls++ === 0) {
					return () => {
						throw new Error("D1 が落ちた");
					};
				}
				const value = Reflect.get(target, key);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		await cron({ ...tokenEnv, DB: flaky });
		const [failed] = await runs();
		expect(failed).toMatchObject({ trigger: "cron", synced: 0 });
		expect(failed?.warnings[0]).toContain("同期が例外で終わった");
	});

	it("残すのは新しい方から 50 件まで", async () => {
		for (let i = 0; i < 53; i++)
			await withoutToken.call(mac, "POST", "/v1/sync");
		const kept = await env.DB.prepare(
			"SELECT count(*) AS n FROM sync_runs",
		).first<{
			n: number;
		}>();
		expect(kept?.n).toBe(50);
		expect(await runs()).toHaveLength(50);
	});
});

describe("ラベルの付け直し", () => {
	it("権限が無くて付かなかったラベルを、直った後の同期で merge 済みの PR にも付け、付いた後は呼ばない", async () => {
		const repo = "example/labels-0";
		const project = await setup(repo);
		gh.repos.get(repo)?.labels.add("actor:yukarin");
		const explicit = await newTask(project.id);
		const marked = await newTask(project.id, { assignee_id: "yukarin" });
		const byOwner = await newTask(project.id);
		gh.pull(repo, 1, { state: "MERGED" });
		gh.pull(repo, 2, { state: "MERGED", body: `chakai:${marked.id}` });
		gh.pull(repo, 3);
		gh.labelForbidden = true;
		const res = await call(
			working("yukarin"),
			"POST",
			`/v1/tasks/${explicit.id}/links`,
			{
				url: `https://github.com/${repo}/pull/1`,
				role: "deliverable",
			},
		);
		expect((await res.json<{ warnings: string[] }>()).warnings[0]).toContain(
			"403",
		);
		await call(owner, "POST", `/v1/tasks/${byOwner.id}/links`, {
			url: `https://github.com/${repo}/pull/3`,
			role: "deliverable",
		});
		await cron();
		expect(await labelState(repo)).toMatchObject([
			{ number: 1, actor_label: "actor:yukarin", labeled_at: null },
			{ number: 2, actor_label: "actor:yukarin", labeled_at: null },
			{ number: 3, actor_label: null, labeled_at: null },
		]);
		expect((await runs())[0]?.warnings.join("\n")).toContain(
			`https://github.com/${repo}/pull/1 にラベル actor:yukarin を付けられなかった`,
		);

		gh.labelForbidden = false;
		await cron();
		expect(gh.repos.get(repo)?.pulls.get(1)?.labels).toEqual(["actor:yukarin"]);
		expect(gh.repos.get(repo)?.pulls.get(2)?.labels).toEqual(["actor:yukarin"]);
		expect(gh.repos.get(repo)?.pulls.get(3)?.labels).toEqual([]);
		const state = await labelState(repo);
		expect(state[0]?.labeled_at).toBeTruthy();
		expect(state[1]?.labeled_at).toBeTruthy();
		expect((await runs())[0]?.warnings).toEqual([]);

		// 付いた後の同期は、開いている 3 番の状態を読むだけ
		gh.calls = [];
		await cron();
		expect(gh.count("POST /repos")).toBe(0);
		expect(gh.count("POST /graphql")).toBe(2);
	});

	it("定義が無くて付かなかったラベルも、定義された後の同期で付く。GitHub で先に付いていれば呼ばない", async () => {
		const repo = "example/labels-1";
		const project = await setup(repo);
		const task = await newTask(project.id);
		gh.pull(repo, 1);
		gh.pull(repo, 2);
		for (const n of [1, 2]) {
			await call(working("akarin"), "POST", `/v1/tasks/${task.id}/links`, {
				url: `https://github.com/${repo}/pull/${n}`,
				role: "deliverable",
			});
		}
		await cron();
		expect((await runs())[0]?.warnings).toEqual([
			`${repo} にラベル actor:akarin が定義されていないので、付けていない`,
		]);
		gh.repos.get(repo)?.labels.add("actor:akarin");
		gh.pull(repo, 2, { labels: ["actor:akarin"] });
		gh.calls = [];
		await cron();
		expect(gh.count("POST /repos")).toBe(1);
		expect((await labelState(repo)).every((r) => r.labeled_at)).toBe(true);
	});

	it("1 回の同期で付け直すのは 30 本までで、残りは次の回に回す", async () => {
		const repo = "example/labels-2";
		const project = await setup(repo);
		const task = await newTask(project.id);
		gh.labelForbidden = true;
		for (let n = 1; n <= 35; n++) {
			gh.pull(repo, n, { state: "MERGED" });
			await call(working("yukarin"), "POST", `/v1/tasks/${task.id}/links`, {
				url: `https://github.com/${repo}/pull/${n}`,
				role: "deliverable",
			});
		}
		gh.labelForbidden = false;
		gh.repos.get(repo)?.labels.add("actor:yukarin");
		gh.calls = [];
		await cron();
		expect(gh.count("POST /repos")).toBe(30);
		expect((await runs())[0]?.warnings).toContain(
			"ラベルを付けていない PR が 35 本ある。1 回の同期で付け直すのは 30 本まで",
		);
		await cron();
		expect((await labelState(repo)).every((r) => r.labeled_at)).toBe(true);
		expect((await runs())[0]?.warnings).toEqual([]);
	});

	it("migration は、これまでのリンクに付けるべきラベルを入れる（同期が付けたものは担当、agent だけ）", async () => {
		const repo = "example/labels-3";
		const project = await setup(repo);
		const assigned = await newTask(project.id, { assignee_id: "akarin" });
		const unassigned = await newTask(project.id);
		gh.pull(repo, 1, { body: `chakai:${assigned.id} chakai:${unassigned.id}` });
		gh.pull(repo, 2);
		gh.pull(repo, 3);
		await cron();
		for (const [n, as] of [
			[2, working("yukarin")],
			[3, owner],
		] as const) {
			await call(as, "POST", `/v1/tasks/${unassigned.id}/links`, {
				url: `https://github.com/${repo}/pull/${n}`,
				role: "deliverable",
			});
		}
		await env.DB.prepare(
			"UPDATE github_links SET actor_label = NULL WHERE repo = ?",
		)
			.bind(repo)
			.run();
		const backfill = env.TEST_MIGRATIONS.find((m) =>
			m.name.includes("actor_label_backfill"),
		);
		for (const query of backfill?.queries ?? [])
			await env.DB.prepare(query).run();
		const rows = await env.DB.prepare(
			"SELECT g.number, l.owner_id, g.actor_label FROM github_links g JOIN links l ON l.id = g.link_id WHERE g.repo = ? ORDER BY g.number, g.actor_label",
		)
			.bind(repo)
			.all<{ number: number; owner_id: string; actor_label: string | null }>();
		expect(rows.results).toEqual([
			{ number: 1, owner_id: unassigned.id, actor_label: null },
			{ number: 1, owner_id: assigned.id, actor_label: "actor:akarin" },
			{ number: 2, owner_id: unassigned.id, actor_label: "actor:yukarin" },
			{ number: 3, owner_id: unassigned.id, actor_label: null },
		]);
	});
});
