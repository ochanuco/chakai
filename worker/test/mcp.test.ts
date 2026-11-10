import { beforeAll, describe, expect, it } from "vitest";
import {
	type As,
	BASE,
	call,
	eventsOf,
	mac,
	newProject,
	newTask,
	seedRoster,
	type TaskJson,
	WORKING,
	working,
} from "./helpers.ts";

beforeAll(seedRoster);

type RpcResponse = {
	result?: Record<string, unknown>;
	error?: { code: number; message: string };
};

type ToolResult<T> = {
	content: { type: "text"; text: string }[];
	structuredContent: T;
	isError?: boolean;
};

let seq = 0;
const rpc = async (
	method: string,
	params?: Record<string, unknown>,
	as: As = mac,
) => {
	const res = await call(as, "POST", "/mcp", {
		jsonrpc: "2.0",
		id: ++seq,
		method,
		params,
	});
	expect(res.status).toBe(200);
	return res.json<RpcResponse>();
};

const tool = async <T>(
	name: string,
	args: Record<string, unknown>,
	as: As = mac,
) => {
	const res = await rpc("tools/call", { name, arguments: args }, as);
	return res.result as ToolResult<T>;
};

describe("POST /mcp", () => {
	it("initialize で版と道具の能力を返す", async () => {
		const res = await rpc("initialize", { protocolVersion: "2025-06-18" });
		expect(res.result).toMatchObject({
			protocolVersion: "2025-06-18",
			capabilities: { tools: {} },
			serverInfo: { name: "chakai" },
		});
		const unknown = await rpc("initialize", { protocolVersion: "1999-01-01" });
		expect(unknown.result?.protocolVersion).toBe("2025-11-25");
	});

	it("tools/list は 7 つの道具を返し、create_task は先に探すよう書いてある", async () => {
		const res = await rpc("tools/list");
		const tools = res.result?.tools as {
			name: string;
			description: string;
			annotations: { readOnlyHint: boolean };
		}[];
		expect(tools.map((t) => t.name)).toEqual([
			"list_projects",
			"create_project",
			"link_repo",
			"search_tasks",
			"get_task",
			"create_task",
			"update_task",
		]);
		expect(tools.find((t) => t.name === "create_task")?.description).toContain(
			"起票の前に search_tasks で似たタスクを探す",
		);
		expect(
			tools.filter((t) => t.annotations.readOnlyHint).map((t) => t.name),
		).toEqual(["list_projects", "search_tasks", "get_task"]);
		expect(tools[0]).not.toHaveProperty("rest");
	});

	it("通知は 202、GET は 405、壊れた JSON は 400、別の Origin は 403", async () => {
		const note = await call(mac, "POST", "/mcp", {
			jsonrpc: "2.0",
			method: "notifications/initialized",
		});
		expect(note.status).toBe(202);
		expect((await call(mac, "GET", "/mcp")).status).toBe(405);
		const broken = await call(mac, "POST", "/mcp", undefined, {}, "{");
		expect(broken.status).toBe(400);
		expect((await broken.json<RpcResponse>()).error?.code).toBe(-32700);
		const cross = await call(
			mac,
			"POST",
			"/mcp",
			{ jsonrpc: "2.0", id: 1, method: "ping" },
			{ Origin: "https://evil.example.net" },
		);
		expect(cross.status).toBe(403);
		const same = await call(
			mac,
			"POST",
			"/mcp",
			{ jsonrpc: "2.0", id: 1, method: "ping" },
			{ Origin: BASE },
		);
		expect(same.status).toBe(200);
	});

	it("知らないメソッドと道具は JSON-RPC のエラーで返す", async () => {
		expect((await rpc("resources/list")).error?.code).toBe(-32601);
		const res = await rpc("tools/call", { name: "delete_task", arguments: {} });
		expect(res.error?.code).toBe(-32602);
	});
});

describe("道具", () => {
	it("プロジェクトを作り、repo を紐付け、一覧で読める", async () => {
		const created = await tool<{ id: string }>("create_project", {
			name: "mcp から",
		});
		const id = created.structuredContent.id;
		const linked = await tool<{ repos: string[] }>("link_repo", {
			project_id: id,
			repo: "example/app",
		});
		expect(linked.structuredContent.repos).toEqual(["example/app"]);
		const list = await tool<{ projects: { id: string; repos: string[] }[] }>(
			"list_projects",
			{},
		);
		expect(list.structuredContent.projects.find((p) => p.id === id)).toEqual(
			expect.objectContaining({ repos: ["example/app"] }),
		);
		expect(JSON.parse(list.content[0]?.text ?? "")).toEqual(
			list.structuredContent,
		);
	});

	it("起票・検索・取得・更新が REST と同じ台帳に届く", async () => {
		const project = await newProject();
		const anchor = await newTask(project.id, { title: "先にあるタスク" });
		const created = await tool<TaskJson>(
			"create_task",
			{ project_id: project.id, title: "mcp で起票", labels: ["mcp"] },
			working("yukarin"),
		);
		const task = created.structuredContent;
		expect(task).toMatchObject({ state: "backlog", created_by: "yukarin" });

		const found = await tool<{ tasks: TaskJson[] }>("search_tasks", {
			project_id: project.id,
			q: "mcp で",
			state: ["backlog", "todo"],
			limit: 10,
		});
		expect(found.structuredContent.tasks.map((t) => t.id)).toEqual([task.id]);

		const updated = await tool<TaskJson>(
			"update_task",
			{
				task_id: task.id,
				title: "mcp で直した件名",
				state: "review",
				waiting_on: "進め方を決めてほしい",
				order: { before: anchor.id },
			},
			working("yukarin"),
		);
		expect(updated.isError).toBeUndefined();
		const got = await tool<TaskJson>("get_task", { task_id: task.id });
		expect(got.structuredContent).toMatchObject({
			title: "mcp で直した件名",
			state: "review",
			waiting_on: "進め方を決めてほしい",
			labels: ["mcp"],
		});
		expect(got.structuredContent.order_key < anchor.order_key).toBe(true);

		const events = await eventsOf(task.id);
		expect(events.map((e) => e.field)).toEqual([
			"created",
			"title",
			"state",
			"waiting_on",
			"order_key",
		]);
		for (const e of events) {
			expect(e).toMatchObject({ actor_id: "yukarin", caller_id: WORKING.id });
		}
	});

	it("REST が拒んだ操作は isError で返す", async () => {
		const project = await newProject();
		const task = await newTask(project.id);
		const noReason = await tool<{ error: string }>("update_task", {
			task_id: task.id,
			state: "review",
		});
		expect(noReason.isError).toBe(true);
		expect(noReason.structuredContent.error).toBe("waiting_on_required");
		const missing = await tool<{ error: string }>("get_task", {
			task_id: "nope",
		});
		expect(missing).toMatchObject({
			isError: true,
			structuredContent: { error: "task_not_found" },
		});
		const invalid = await tool<{ error: string }>("create_task", {
			project_id: project.id,
		});
		expect(invalid.structuredContent.error).toBe("invalid_input");
	});

	it("許可されない名乗りは、道具に届く前に 403", async () => {
		const res = await call(working("owner"), "POST", "/mcp", {
			jsonrpc: "2.0",
			id: 1,
			method: "tools/list",
		});
		expect(res.status).toBe(403);
	});
});
