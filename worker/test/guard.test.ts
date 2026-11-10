import { beforeAll, describe, expect, it } from "vitest";
import {
	BASE,
	call,
	eventsOf,
	mac,
	newProject,
	newTask,
	owner,
	seedRoster,
	type TaskJson,
	working,
} from "./helpers.ts";

beforeAll(seedRoster);

const stateOf = async (id: string) =>
	(await (await call(owner, "GET", `/v1/tasks/${id}`)).json<TaskJson>()).state;

describe("ログインで来た書き込みの Origin", () => {
	it.each([
		["Origin が無い", null],
		["別のサイト", "https://evil.example.net"],
		["scheme が違う", BASE.replace("https:", "http:")],
		["port が違う", `${BASE}:8443`],
		["不透明な Origin", "null"],
	])("%s なら 403 で、何も書かない", async (_name, origin) => {
		const project = await newProject();
		const task = await newTask(project.id);
		const res = await call(
			owner,
			"PATCH",
			`/v1/tasks/${task.id}`,
			{ state: "done" },
			{ origin },
		);
		expect(res.status).toBe(403);
		expect(await res.json()).toMatchObject({ error: "origin_mismatch" });
		expect(await stateOf(task.id)).toBe("backlog");
		expect((await eventsOf(task.id)).map((e) => e.field)).toEqual(["created"]);
	});

	it("自分の Origin なら通す", async () => {
		const project = await newProject();
		const task = await newTask(project.id);
		const res = await call(
			owner,
			"PATCH",
			`/v1/tasks/${task.id}`,
			{ state: "todo" },
			{ origin: BASE },
		);
		expect(res.status).toBe(200);
		expect(await stateOf(task.id)).toBe("todo");
	});

	it("書き込みの method なら、どの経路でも確かめる", async () => {
		const project = await newProject();
		const task = await newTask(project.id);
		for (const [method, path] of [
			["POST", "/v1/projects"],
			["POST", `/v1/projects/${project.id}/repos`],
			["POST", "/v1/tasks"],
			["PATCH", `/v1/tasks/${task.id}`],
			["PUT", `/v1/tasks/${task.id}`],
			["DELETE", `/v1/tasks/${task.id}`],
			["POST", "/v1/nowhere"],
		] as const) {
			const res = await call(owner, method, path, {}, { origin: null });
			expect([method, path, res.status]).toEqual([method, path, 403]);
		}
	});

	it("読み取りには Origin が要らない", async () => {
		const res = await call(owner, "GET", "/v1/projects", undefined, {
			origin: null,
		});
		expect(res.status).toBe(200);
	});

	it("service token の書き込みは、Origin が無くても違っても通す", async () => {
		const project = await newProject();
		for (const origin of [null, "https://evil.example.net"]) {
			for (const as of [mac, working("yukarin")]) {
				const res = await call(
					as,
					"POST",
					"/v1/tasks",
					{ project_id: project.id, title: "x" },
					{ origin },
				);
				expect(res.status).toBe(201);
			}
		}
	});
});

describe("書き込みの Content-Type", () => {
	it.each([
		["無い", null],
		["text/plain", "text/plain"],
		["form", "application/x-www-form-urlencoded"],
		["multipart", "multipart/form-data; boundary=x"],
		["json に似た別の型", "application/jsonp"],
	])("%s なら、ログインでも service token でも 415", async (_name, type) => {
		const project = await newProject();
		for (const as of [owner, mac, working("akarin")]) {
			const res = await call(
				as,
				"POST",
				"/v1/tasks",
				{ project_id: project.id, title: "x" },
				{ "content-type": type },
			);
			expect(res.status).toBe(415);
			expect(await res.json()).toMatchObject({
				error: "unsupported_media_type",
			});
		}
		const listed = await call(
			owner,
			"GET",
			`/v1/tasks?project_id=${project.id}`,
		);
		expect((await listed.json<{ tasks: unknown[] }>()).tasks).toEqual([]);
	});

	it("charset 付きや大文字の application/json は受ける", async () => {
		const project = await newProject();
		for (const type of [
			"application/json; charset=utf-8",
			"Application/JSON",
		]) {
			const res = await call(
				mac,
				"POST",
				"/v1/tasks",
				{ project_id: project.id, title: "x" },
				{ "content-type": type },
			);
			expect(res.status).toBe(201);
		}
	});
});

describe("MCP から REST への書き込み", () => {
	const createProject = (as: Parameters<typeof call>[0]) =>
		call(as, "POST", "/mcp", {
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: { name: "create_project", arguments: { name: "via mcp" } },
		});

	it("service token でも、ログインでも、今までどおり通る", async () => {
		for (const as of [mac, working("yukarin"), owner]) {
			const res = await createProject(as);
			expect(res.status).toBe(200);
			const { result } = await res.json<{
				result: { isError?: boolean; structuredContent: { id?: string } };
			}>();
			expect(result.isError).toBeUndefined();
			expect(result.structuredContent.id).toBeTruthy();
		}
	});
});
