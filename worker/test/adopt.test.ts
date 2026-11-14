import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeGitHub, TOKEN } from "./github-fake.ts";
import {
	appWithGitHub,
	eventsOf,
	newProject,
	newTask,
	owner,
	seedRoster,
} from "./helpers.ts";

beforeAll(seedRoster);

const gh = new FakeGitHub();
const { app, env: tokenEnv, call } = appWithGitHub(gh.fetch, TOKEN);

beforeEach(() => {
	gh.calls = [];
	gh.owned = [];
	gh.ownedDown = null;
});

const cron = async () => {
	const pending: Promise<unknown>[] = [];
	await app.scheduled({} as ScheduledController, tokenEnv, {
		waitUntil: (p: Promise<unknown>) => pending.push(p),
	} as unknown as ExecutionContext);
	await Promise.all(pending);
};

type ProjectJson = {
	id: string;
	name: string;
	created_by: string;
	repos: string[];
};

const projects = async () =>
	(
		await (
			await call(owner, "GET", "/v1/projects")
		).json<{
			projects: ProjectJson[];
		}>()
	).projects;

const holding = async (repo: string) =>
	(await projects()).filter((p) => p.repos.includes(repo));

const linkedUrls = async (taskId: string) =>
	(
		await env.DB.prepare("SELECT url FROM links WHERE owner_id = ?")
			.bind(taskId)
			.all<{ url: string }>()
	).results.map((r) => r.url);

describe("token のアカウントの repo を拾う", () => {
	it("Cron の同期が、紐付いていない repo ごとに repo 名のプロジェクトを作り、2 度目は何もしない", async () => {
		const linked = await newProject();
		await call(owner, "POST", `/v1/projects/${linked.id}/repos`, {
			repo: "example/known",
		});
		gh.repo("example/known");
		gh.repo("example/fresh");
		gh.owned = [
			{ repo: "example/fresh" },
			{ repo: "Example/Known" },
			{ repo: "example/old", archived: true },
			{ repo: "example/forked", fork: true },
		];

		await cron();
		const [fresh, ...rest] = await holding("example/fresh");
		expect(rest).toEqual([]);
		expect(fresh).toMatchObject({
			name: "fresh",
			created_by: "sync",
			repos: ["example/fresh"],
		});
		expect(
			(await eventsOf(fresh?.id ?? "")).map((e) => [e.field, e.actor_id]),
		).toEqual([
			["created", "sync"],
			["repos", "sync"],
		]);
		expect(await holding("Example/Known")).toEqual([]);
		expect(await holding("example/old")).toEqual([]);
		expect(await holding("example/forked")).toEqual([]);

		const count = (await projects()).length;
		await cron();
		expect((await projects()).length).toBe(count);
	});

	it("同じ名前で repo の無いプロジェクトがあれば、作らずにそこへ紐付ける", async () => {
		const res = await call(owner, "POST", "/v1/projects", { name: "Waiting" });
		const waiting = await res.json<ProjectJson>();
		gh.repo("example/waiting");
		gh.owned = [{ repo: "example/waiting" }];
		await cron();
		expect((await holding("example/waiting")).map((p) => p.id)).toEqual([
			waiting.id,
		]);
	});

	it("手動の同期はプロジェクトを作らない", async () => {
		gh.owned = [{ repo: "example/manual" }];
		const res = await call(owner, "POST", "/v1/sync");
		expect(await res.json()).toMatchObject({ warnings: [] });
		expect(await holding("example/manual")).toEqual([]);
	});

	it("アーカイブされた repo は、紐付いていても印を探さない", async () => {
		const project = await newProject();
		await call(owner, "POST", `/v1/projects/${project.id}/repos`, {
			repo: "example/archived",
		});
		const task = await newTask(project.id);
		gh.pull("example/archived", 1, { body: `chakai:${task.id}` });
		gh.owned = [{ repo: "example/archived", archived: true }];
		await call(owner, "POST", "/v1/sync");
		expect(await linkedUrls(task.id)).toEqual([]);

		gh.owned = [{ repo: "example/archived" }];
		await call(owner, "POST", "/v1/sync");
		expect(await linkedUrls(task.id)).toEqual([
			"https://github.com/example/archived/pull/1",
		]);
	});

	it("一覧を読めなければ警告にし、プロジェクトは作らず、残りの同期は続ける", async () => {
		const project = await newProject();
		await call(owner, "POST", `/v1/projects/${project.id}/repos`, {
			repo: "example/listing",
		});
		const task = await newTask(project.id);
		gh.pull("example/listing", 1, { body: `chakai:${task.id}` });
		gh.owned = [{ repo: "example/unlisted" }];
		gh.ownedDown = 502;

		await cron();
		expect(await holding("example/unlisted")).toEqual([]);
		expect(await linkedUrls(task.id)).toEqual([
			"https://github.com/example/listing/pull/1",
		]);
		const { runs } = await (await call(owner, "GET", "/v1/sync-runs")).json<{
			runs: { warnings: string[] }[];
		}>();
		expect(runs[0]?.warnings).toEqual(["GitHub POST /graphql: 502"]);
	});
});
