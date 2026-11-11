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
} from "./helpers.ts";

beforeAll(seedRoster);

describe("1 回の同期で GitHub を呼ぶ回数", () => {
	it("repo は 10 個ずつ、PR は 30 本ずつ 1 回の問い合わせにまとめる", async () => {
		const gh = new FakeGitHub();
		const { call } = appWithGitHub(gh.fetch, TOKEN);
		const project = await newProject();
		const task = await newTask(project.id, { state: "todo" });
		for (let r = 0; r < 12; r++) {
			const repo = `example/calls-${r}`;
			gh.repo(repo);
			await call(owner, "POST", `/v1/projects/${project.id}/repos`, { repo });
		}
		for (let n = 1; n <= 35; n++) {
			gh.pull("example/calls-0", n, { rollup: n === 1 ? null : "SUCCESS" });
			const res = await call(owner, "POST", `/v1/tasks/${task.id}/links`, {
				url: `https://github.com/example/calls-0/pull/${n}`,
				role: "deliverable",
			});
			expect(res.status).toBe(201);
		}
		gh.repos.get("example/calls-0")?.runs.set("sha-1", []);
		gh.repos
			.get("example/calls-0")
			?.statuses.set("sha-1", { state: "pending", total_count: 0 });
		gh.calls = [];
		const res = await call(mac, "POST", "/v1/sync");
		expect(await res.json()).toMatchObject({ synced: 35, warnings: [] });
		// 印を探す 2 回（12 repo）と、状態を取り込む 2 回（35 本）
		expect(gh.count("POST /graphql")).toBe(4);
		// statusCheckRollup を読めなかった 1 本だけ、workflow run と commit status を読む
		expect(gh.calls.filter((c) => c.startsWith("GET "))).toEqual([
			"GET /repos/example/calls-0/actions/runs",
			"GET /repos/example/calls-0/commits/sha-1/status",
		]);
	});

	it("CI を REST で読むのは 1 回の同期で 20 本まで、同時に 4 本までで、残りは不明のままにする", async () => {
		const gh = new FakeGitHub();
		const { call } = appWithGitHub(gh.fetch, TOKEN);
		const project = await newProject();
		const task = await newTask(project.id, { state: "todo" });
		const name = "example/budget-0";
		const repo = gh.repo(name);
		for (let n = 1; n <= 25; n++) {
			gh.pull(name, n, { rollup: null });
			repo.runs.set(`sha-${n}`, []);
			repo.statuses.set(`sha-${n}`, { state: "pending", total_count: 0 });
			await call(owner, "POST", `/v1/tasks/${task.id}/links`, {
				url: `https://github.com/${name}/pull/${n}`,
				role: "deliverable",
			});
		}
		gh.calls = [];
		gh.maxInFlight = 0;
		const res = await call(mac, "POST", "/v1/sync");
		expect(await res.json()).toMatchObject({ synced: 25 });
		expect(gh.calls.filter((c) => c.startsWith("GET "))).toHaveLength(40);
		expect(gh.maxInFlight).toBeLessThanOrEqual(4);
		expect(gh.maxInFlight).toBeGreaterThan(1);
		const unknown = await env.DB.prepare(
			"SELECT count(*) AS n FROM github_links WHERE repo = ? AND checks IS NULL",
		)
			.bind(name)
			.first<{ n: number }>();
		expect(unknown?.n).toBe(5);
	});
});
