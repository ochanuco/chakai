import { beforeAll, describe, expect, it } from "vitest";
import {
	call,
	eventsOf,
	MAC,
	mac,
	newProject,
	owner,
	seedRoster,
} from "./helpers.ts";

beforeAll(seedRoster);

type ProjectJson = { id: string; name: string; repos: string[] };

describe("プロジェクト", () => {
	it("repo が無くても作れ、一覧に出る", async () => {
		const res = await call(mac, "POST", "/v1/projects", {
			name: "新しい企画",
			description: "まだ repo は無い",
		});
		expect(res.status).toBe(201);
		const project = await res.json<ProjectJson>();
		expect(project).toMatchObject({ created_by: "owner", repos: [] });
		const list = await call(owner, "GET", "/v1/projects");
		const { projects } = await list.json<{ projects: ProjectJson[] }>();
		expect(projects.find((p) => p.id === project.id)?.name).toBe("新しい企画");
		expect(await eventsOf(project.id)).toMatchObject([
			{ entity: "project", field: "created", caller_id: MAC.id },
		]);
	});

	it("名前が無ければ 400", async () => {
		const res = await call(owner, "POST", "/v1/projects", { name: " " });
		expect(res.status).toBe(400);
	});

	it("repo を紐付け、同じ repo を 2 度紐付けても events は 1 行", async () => {
		const project = await newProject();
		const other = await newProject();
		for (const id of [project.id, project.id, other.id]) {
			const res = await call(owner, "POST", `/v1/projects/${id}/repos`, {
				repo: "example/app",
			});
			expect(res.status).toBe(200);
			expect((await res.json<ProjectJson>()).repos).toEqual(["example/app"]);
		}
		expect((await eventsOf(project.id)).map((e) => [e.field, e.after])).toEqual(
			[
				["created", expect.any(String)],
				["repos", '"example/app"'],
			],
		);
	});

	it("同じ repo を同時に紐付けても、どれも成功し events は 1 行", async () => {
		const project = await newProject();
		const responses = await Promise.all(
			Array.from({ length: 4 }, () =>
				call(owner, "POST", `/v1/projects/${project.id}/repos`, {
					repo: "example/concurrent",
				}),
			),
		);
		for (const res of responses) {
			expect(res.status).toBe(200);
			expect((await res.json<ProjectJson>()).repos).toEqual([
				"example/concurrent",
			]);
		}
		expect(
			(await eventsOf(project.id)).filter((e) => e.field === "repos"),
		).toHaveLength(1);
	});

	it("GitHub の owner/name の形に合わない repo は 400", async () => {
		const project = await newProject();
		const link = (repo: string) =>
			call(owner, "POST", `/v1/projects/${project.id}/repos`, { repo });
		for (const repo of [
			`${"a".repeat(40)}/app`,
			`example/${"a".repeat(101)}`,
			"-example/app",
			"example-/app",
			"exa_mple/app",
			"example/..",
			"example/app/extra",
			"example/",
		]) {
			expect((await link(repo)).status).toBe(400);
		}
		const longest = `${"a".repeat(39)}/${"b".repeat(100)}`;
		for (const repo of [longest, "ex-ample/.github", "example/a_b.c-d"]) {
			expect((await link(repo)).status).toBe(200);
		}
	});

	it("owner/name の形でない repo は 400、無いプロジェクトは 404", async () => {
		const project = await newProject();
		const bad = await call(owner, "POST", `/v1/projects/${project.id}/repos`, {
			repo: "https://github.com/example/app",
		});
		expect(bad.status).toBe(400);
		const missing = await call(owner, "POST", "/v1/projects/nope/repos", {
			repo: "example/app",
		});
		expect(missing.status).toBe(404);
	});
});
