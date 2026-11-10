import * as v from "valibot";
import { RELATION_KINDS, TASK_STATES } from "./db/schema.ts";
import { handleRest, type RestContext } from "./rest.ts";
import { SEARCH_DEFAULT_LIMIT, SEARCH_MAX_LIMIT } from "./tasks.ts";

// 新しい順。相手が求めた版を知っていればそれで、知らなければ先頭の版で答える
export const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];

const SERVER_INFO = { name: "chakai", version: "1.0.0" };

// 手順（いつ、どの順に呼ぶか）はここに、引数の意味と拒まれる条件は道具の description に書く。
// 「起票の前に探す」だけは、instructions を読まないクライアントにも届くよう create_task にも書く。
// 長い instructions を途中で切るクライアントがあるので、短く保つ
export const INSTRUCTIONS = `chakai は owner と複数の AI を区別するタスク台帳。誰として記録されるかは呼び出し元で決まる。

## 起票する
1. list_projects でプロジェクトを決める。合うものが無ければ、owner に確かめてから create_project で作る。repo が決まっていれば link_repo で紐付ける。
2. search_tasks を q 付きで呼び、似たタスクが無いかを確かめる。chakai は重複を判定しない。似たものがあれば、新しく作らずそれを示す。
3. create_task で作る。state は渡さず backlog にする。owner が「すぐやる」と言ったものだけ todo にする。
4. title は、それだけで何をするかが分かる 1 文にする。body には、起きていること、終わったと言える条件、関係するファイルや URL を書く。会話の経緯は書かない。

作業中に、頼まれた範囲の外の課題を見つけたら、その場で直さず、関係するプロジェクトの backlog に起票する。create_task の discovered_from に、作業中のタスクを渡す。

## 状態を動かす
update_task の state を、その時点で変える。あとでまとめて直さない。
- 着手する: doing
- owner の判断が要る: review（waiting_on に仰ぐ内容を一言で）
- 終わった: done
- やめた: dropped（タスクは消せない）
- backlog を todo に上げるのは、owner が着手を認めたときだけ。

## 途中で分ける
- 大きすぎた（範囲は同じ）: create_task の parent_id に今のタスクを渡し、子を todo で作る。今のタスクは doing のまま残す。深さの上限で拒まれたら、backlog で作るか、今のタスクを review にする。
- 途中まで終わり、区切れる: 残りを新しいタスクにし、relate_tasks で新しいタスクから今のタスクへ follows を付けてから、今のタスクを done にする。
- 方針が変わり、作り直す: 新しいタスクを作り、relate_tasks で今のタスクから新しいタスクへ replaced_by を付けてから、今のタスクを dropped にする。

## 探す
- 次にやるもの: search_tasks を project_id と state: ["todo"] で呼ぶ。返る順が並び順なので、先頭が次のタスク。
- owner の番のもの: state: ["review"]。
- 並びを変える: update_task の order。

## 書き方
- labels は渡した一覧に置き換わる。足すときは、get_task で今のラベルを読み、足した一覧を渡す。
- タスクや actor の ID を、owner への報告にそのまま並べない。件名で示す。`;

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

class InvalidArguments extends Error {}

/**
 * パスに埋める ID。REST の入力の検証を通らないので、ここで確かめる。
 * 空や `.` を通すと、パスが別の入口（タスクの一覧など）を指してしまう
 */
const segment = (args: Args, key: string) => {
	const value = args[key];
	if (
		typeof value !== "string" ||
		value.length < 1 ||
		value.length > 64 ||
		value === "." ||
		value === ".."
	) {
		throw new InvalidArguments(`${key}: 1〜64 文字の ID が要る`);
	}
	return encodeURIComponent(value);
};

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

/** 道具は REST の入口への写しだけを持つ。パスに埋める ID のほかは、入力の検証も処理も REST 側にある */
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
			path: `/v1/projects/${segment(args, "project_id")}/repos`,
			body: without(args, "project_id"),
		}),
	},
	{
		name: "search_tasks",
		title: "タスクを探す",
		description:
			"条件に合うタスクを、プロジェクト内の並び（order_key）の順に返す。q は件名と本文に含む語。",
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
				awaiting_triage: {
					type: "boolean",
					description:
						"true なら仕分け待ち（AI が起票し、owner がまだ扱いを決めていない backlog）だけ",
				},
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
		description:
			"ID のタスクを、ラベルと、他のタスクとの関係（relations。このタスクが from か to のもの）と一緒に返す。",
		inputSchema: {
			type: "object",
			properties: { task_id: id },
			required: ["task_id"],
			additionalProperties: false,
		},
		annotations: READ,
		rest: (args) => ({
			method: "GET",
			path: `/v1/tasks/${segment(args, "task_id")}`,
		}),
	},
	{
		name: "create_task",
		title: "タスクを起票する",
		description:
			"タスクを起票する。起票の前に search_tasks で似たタスクを探す。state の既定は backlog。並びはプロジェクトの末尾に入る。AI が親の下に todo で作れる深さには上限があり、超えると拒まれる（backlog では作れるが、AI が todo に上げるときにも同じ上限が掛かる）。",
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
				discovered_from: {
					type: "object",
					description:
						"このタスクを見つけたときに作業していたタスク。席の run が分かれば run_id も渡す",
					properties: { task_id: id, run_id: id },
					required: ["task_id"],
					additionalProperties: false,
				},
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
			"タスクの件名、本文、状態、並び、ラベル、担当、waiting_on を変える。渡した項目だけが変わる。review（owner の番）にするときは waiting_on が要り、review を出ると waiting_on は空になる。",
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
			path: `/v1/tasks/${segment(args, "task_id")}`,
			body: without(args, "task_id"),
		}),
	},
	{
		name: "relate_tasks",
		title: "タスク同士をつなぐ",
		description:
			"「from_task が kind で to_task」と読める向きに関係を付ける。discovered_from は見つけたタスクから作業していたタスクへ、follows は続きのタスクから区切ったタスクへ、replaced_by はやめたタスクから作り直したタスクへ。run_id は discovered_from にだけ付けられる。",
		inputSchema: {
			type: "object",
			properties: {
				from_task: id,
				kind: { type: "string", enum: RELATION_KINDS },
				to_task: id,
				run_id: id,
			},
			required: ["from_task", "kind", "to_task"],
			additionalProperties: false,
		},
		annotations: { ...WRITE, idempotentHint: true },
		rest: (args) => ({
			method: "POST",
			path: `/v1/tasks/${segment(args, "from_task")}/relations`,
			body: without(args, "from_task"),
		}),
	},
	{
		name: "next_task",
		title: "親タスクの次の todo を返す",
		description:
			"席を回す側のコードが呼ぶ。親タスクの子孫のうち、木の順（深さ優先、同じ親の中は並び順）で最初の todo を task に返す。無ければ task は null。descendant_states は子孫の状態ごとの数。状態は変えない。",
		inputSchema: {
			type: "object",
			properties: { task_id: { ...id, description: "席に渡した親タスク" } },
			required: ["task_id"],
			additionalProperties: false,
		},
		annotations: READ,
		rest: (args) => ({
			method: "GET",
			path: `/v1/tasks/${segment(args, "task_id")}/next`,
		}),
	},
	{
		name: "start_run",
		title: "席の実行記録を始める",
		description:
			"席を回す側のコードが呼ぶ。親タスクを席に渡した記録を作る。actor は呼び出し元の名乗りで決まる。repo の無いプロジェクトのタスクは拒む。",
		inputSchema: {
			type: "object",
			properties: {
				task_id: { ...id, description: "席に渡す親タスク" },
				seat: { type: "string", minLength: 1, maxLength: 100 },
				model: { type: "string", minLength: 1, maxLength: 100 },
				hishaku_no: {
					type: "integer",
					minimum: 1000,
					maximum: 9999,
					description: "hishaku に預けたセッションの番号",
				},
			},
			required: ["task_id", "seat"],
			additionalProperties: false,
		},
		annotations: WRITE,
		rest: (args) => ({ method: "POST", path: "/v1/runs", body: args }),
	},
	{
		name: "end_run",
		title: "席の実行記録を閉じる",
		description:
			"席を回す側のコードが呼ぶ。席を解放したときに run を閉じる。閉じた run をもう一度閉じても変わらない。",
		inputSchema: {
			type: "object",
			properties: { run_id: id },
			required: ["run_id"],
			additionalProperties: false,
		},
		annotations: { ...WRITE, idempotentHint: true },
		rest: (args) => ({
			method: "POST",
			path: `/v1/runs/${segment(args, "run_id")}/end`,
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
	const toolResult = (
		structured: Record<string, unknown>,
		isError: boolean,
	) => ({
		result: {
			content: [{ type: "text", text: JSON.stringify(structured, null, 2) }],
			structuredContent: structured,
			...(isError ? { isError: true } : {}),
		},
	});
	let call: RestCall;
	try {
		call = tool.rest(args as Args);
	} catch (e) {
		if (!(e instanceof InvalidArguments)) throw e;
		// REST が入力を拒んだときと同じ形で返す
		return toolResult({ error: "invalid_input", message: e.message }, true);
	}
	const response = await handleRest(
		new Request(new URL(call.path, request.url), {
			method: call.method,
			body: call.body === undefined ? undefined : JSON.stringify(call.body),
		}),
		context,
	);
	return toolResult(
		await response.json<Record<string, unknown>>(),
		!response.ok,
	);
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
					instructions: INSTRUCTIONS,
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
