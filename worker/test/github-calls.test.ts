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
});
