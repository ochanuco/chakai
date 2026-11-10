import * as v from "valibot";
import { TASK_STATES } from "./db/schema.ts";
import { handleRest, type RestContext } from "./rest.ts";
import { SEARCH_DEFAULT_LIMIT, SEARCH_MAX_LIMIT } from "./tasks.ts";

// 新しい順。相手が求めた版を知っていればそれで、知らなければ先頭の版で答える
export const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];

const SERVER_INFO = { name: "chakai", version: "1.0.0" };

const Message = v.object({
	jsonrpc: v.literal("2.0"),
	id: v.optional(v.nullable(v.union([v.string(), v.number()]))),
	method: v.optional(v.string()),
	params: v.optional(v.record(v.string(), v.unknown())),
});

type Args = Record<string, unknown>;
type RestCall = { method: string; path: string; body?: unknown };

const READ = {
	readOnlyHint: true,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: false,
};
const WRITE = {
	readOnlyHint: false,
	destructiveHint: false,
	idempotentHint: false,
	openWorldHint: false,
};

const id = { type: "string", minLength: 1, maxLength: 64 };
const labels = {
	type: "array",
	items: { type: "string", minLength: 1, maxLength: 64 },
	maxItems: 20,
};

const segment = (value: unknown) => encodeURIComponent(String(value ?? ""));

const without = (args: Args, key: string) => {
	const { [key]: _, ...rest } = args;
	return rest;
};

const query = (args: Args) => {
	const params = new URLSearchParams();
	for (const [key, value] of Object.entries(args)) {
		if (value === undefined || value === null) continue;
		params.set(key, Array.isArray(value) ? value.join(",") : String(value));
	}
	const text = params.toString();
	return text ? `?${text}` : "";
};

/** 道具は REST の入口への写しだけを持つ。入力の検証と処理は REST 側にある */
export const TOOLS: {
	name: string;
	title: string;
	description: string;
	inputSchema: Record<string, unknown>;
	annotations: typeof READ;
	rest: (args: Args) => RestCall;
}[] = [
	{
		name: "list_projects",
		title: "プロジェクトの一覧",
		description: "プロジェクトと、それぞれに紐付いた repo を返す。",
		inputSchema: {
			type: "object",
			properties: {},
			additionalProperties: false,
		},
		annotations: READ,
		rest: () => ({ method: "GET", path: "/v1/projects" }),
	},
	{
		name: "create_project",
		title: "プロジェクトを作る",
		description: "プロジェクトを作る。repo が無い段階でも作れる。",
		inputSchema: {
			type: "object",
			properties: {
				name: { type: "string", minLength: 1, maxLength: 200 },
				description: { type: "string", maxLength: 10000 },
			},
			required: ["name"],
			additionalProperties: false,
		},
		annotations: WRITE,
		rest: (args) => ({ method: "POST", path: "/v1/projects", body: args }),
	},
	{
		name: "link_repo",
		title: "プロジェクトに repo を紐付ける",
		description:
			"プロジェクトに GitHub の repo（owner/name）を紐付ける。1 つの repo を複数のプロジェクトに紐付けてよい。",
		inputSchema: {
			type: "object",
			properties: {
				project_id: id,
				repo: { type: "string", description: "owner/name の形" },
			},
			required: ["project_id", "repo"],
			additionalProperties: false,
		},
		annotations: { ...WRITE, idempotentHint: true },
		rest: (args) => ({
			method: "POST",
			path: `/v1/projects/${segment(args.project_id)}/repos`,
			body: without(args, "project_id"),
		}),
	},
	{
		name: "search_tasks",
		title: "タスクを探す",
		description:
			"条件に合うタスクを、プロジェクト内の並び（order_key）の順に返す。q は件名と本文に含む語。起票の前に、似たタスクが無いかをこれで探す。",
		inputSchema: {
			type: "object",
			properties: {
				project_id: id,
				q: { type: "string", minLength: 1, maxLength: 200 },
				state: {
					type: "array",
					items: { type: "string", enum: TASK_STATES },
					uniqueItems: true,
					maxItems: TASK_STATES.length,
					description: "どれかに当たる状態",
				},
				assignee_id: id,
				parent_id: { ...id, description: "この親の直下の子だけ" },
				label: { type: "string", minLength: 1, maxLength: 64 },
				limit: {
					type: "integer",
					minimum: 1,
					maximum: SEARCH_MAX_LIMIT,
					default: SEARCH_DEFAULT_LIMIT,
				},
			},
			additionalProperties: false,
		},
		annotations: READ,
		rest: (args) => ({ method: "GET", path: `/v1/tasks${query(args)}` }),
	},
	{
		name: "get_task",
		title: "タスクを読む",
		description: "ID のタスクを、ラベルと一緒に返す。",
		inputSchema: {
			type: "object",
			properties: { task_id: id },
			required: ["task_id"],
			additionalProperties: false,
		},
		annotations: READ,
		rest: (args) => ({
			method: "GET",
			path: `/v1/tasks/${segment(args.task_id)}`,
		}),
	},
	{
		name: "create_task",
		title: "タスクを起票する",
		description:
			"タスクを起票する。起票の前に search_tasks で似たタスクを探す（chakai は重複を判定しない）。state の既定は backlog で、着手してよいと決まっているものだけ todo にする。並びはプロジェクトの末尾に入る。",
		inputSchema: {
			type: "object",
			properties: {
				project_id: id,
				title: { type: "string", minLength: 1, maxLength: 500 },
				body: { type: "string", maxLength: 100000 },
				parent_id: { ...id, description: "同じプロジェクトの親タスク" },
				state: {
					type: "string",
					enum: ["backlog", "todo"],
					default: "backlog",
				},
				assignee_id: { ...id, description: "担当の actor の ID" },
				labels,
			},
			required: ["project_id", "title"],
			additionalProperties: false,
		},
		annotations: WRITE,
		rest: (args) => ({ method: "POST", path: "/v1/tasks", body: args }),
	},
	{
		name: "update_task",
		title: "タスクを更新する",
		description:
			"タスクの件名、本文、状態、並び、ラベル、担当、waiting_on を変える。渡した項目だけが変わる。review（owner の番）にするときは、waiting_on に owner へ仰ぐ内容を一言で書く。review を出ると waiting_on は空になる。やめたタスクは消さずに dropped にする。labels は渡した一覧に置き換わる。",
		inputSchema: {
			type: "object",
			properties: {
				task_id: id,
				title: { type: "string", minLength: 1, maxLength: 500 },
				body: { type: "string", maxLength: 100000 },
				state: { type: "string", enum: TASK_STATES },
				waiting_on: { type: ["string", "null"], maxLength: 1000 },
				assignee_id: { type: ["string", "null"], maxLength: 64 },
				labels,
				order: {
					type: "object",
					description:
						"同じプロジェクトのタスクの直前（before）か直後（after）に動かす",
					oneOf: [
						{
							type: "object",
							properties: { before: id },
							required: ["before"],
							additionalProperties: false,
						},
						{
							type: "object",
							properties: { after: id },
							required: ["after"],
							additionalProperties: false,
						},
					],
				},
			},
			required: ["task_id"],
			additionalProperties: false,
		},
		annotations: WRITE,
		rest: (args) => ({
			method: "PATCH",
			path: `/v1/tasks/${segment(args.task_id)}`,
			body: without(args, "task_id"),
		}),
	},
];

type RpcError = { code: number; message: string };
type Outcome = { result: unknown } | { error: RpcError };

const callTool = async (
	params: Record<string, unknown>,
	request: Request,
	context: RestContext,
): Promise<Outcome> => {
	const tool = TOOLS.find((t) => t.name === params.name);
	if (!tool) {
		return {
			error: { code: -32602, message: `知らない道具: ${String(params.name)}` },
		};
	}
	const args = params.arguments ?? {};
	if (typeof args !== "object" || args === null || Array.isArray(args)) {
		return { error: { code: -32602, message: "arguments が object ではない" } };
	}
	const call = tool.rest(args as Args);
	const response = await handleRest(
		new Request(new URL(call.path, request.url), {
			method: call.method,
			body: call.body === undefined ? undefined : JSON.stringify(call.body),
		}),
		context,
	);
	const structured = await response.json<Record<string, unknown>>();
	return {
		result: {
			content: [{ type: "text", text: JSON.stringify(structured, null, 2) }],
			structuredContent: structured,
			...(response.ok ? {} : { isError: true }),
		},
	};
};

const dispatch = async (
	method: string,
	params: Record<string, unknown>,
	request: Request,
	context: RestContext,
): Promise<Outcome> => {
	switch (method) {
		case "initialize": {
			const requested = params.protocolVersion;
			const version =
				typeof requested === "string" && PROTOCOL_VERSIONS.includes(requested)
					? requested
					: PROTOCOL_VERSIONS[0];
			return {
				result: {
					protocolVersion: version,
					capabilities: { tools: { listChanged: false } },
					serverInfo: SERVER_INFO,
					instructions:
						"chakai は owner と AI を区別するタスク台帳。起票の前に search_tasks で似たタスクを探し、着手と完了で update_task を使って状態を動かす。",
				},
			};
		}
		case "ping":
			return { result: {} };
		case "tools/list":
			return {
				result: { tools: TOOLS.map(({ rest: _, ...tool }) => tool) },
			};
		case "tools/call":
			return callTool(params, request, context);
	}
	return { error: { code: -32601, message: `知らないメソッド: ${method}` } };
};

const rpcError = (id: string | number | null, error: RpcError, status = 200) =>
	Response.json({ jsonrpc: "2.0", id, error }, { status });

/**
 * MCP の Streamable HTTP を、状態を持たない形で受ける。
 * サーバーから送りたいものが無いので、SSE の流れもセッションも持たない。
 */
export const handleMcp = async (
	request: Request,
	context: RestContext,
): Promise<Response> => {
	if (request.method !== "POST") {
		return new Response(null, { status: 405, headers: { Allow: "POST" } });
	}
	// Access を通っていても、ブラウザから別のサイト経由で叩かれないよう Origin を見る
	const origin = request.headers.get("origin");
	if (
		origin !== null &&
		URL.parse(origin)?.host !== new URL(request.url).host
	) {
		return rpcError(null, { code: -32600, message: "Origin が違う" }, 403);
	}
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return rpcError(
			null,
			{ code: -32700, message: "JSON として読めない" },
			400,
		);
	}
	const parsed = v.safeParse(Message, body);
	if (!parsed.success) {
		return rpcError(
			null,
			{ code: -32600, message: "JSON-RPC 2.0 のメッセージではない" },
			400,
		);
	}
	const { id, method, params } = parsed.output;
	// 通知と、こちらが出していない要求への応答は、受け取ったとだけ返す
	if (id === undefined || id === null || method === undefined) {
		return new Response(null, { status: 202 });
	}
	const outcome = await dispatch(method, params ?? {}, request, context);
	return "error" in outcome
		? rpcError(id, outcome.error)
		: Response.json({ jsonrpc: "2.0", id, result: outcome.result });
};
