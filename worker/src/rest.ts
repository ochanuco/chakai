import * as v from "valibot";
import type { Principal } from "./auth.ts";
import type { Db } from "./db/client.ts";
import { TASK_STATES } from "./db/schema.ts";
import { createProject, linkRepo, listProjects } from "./projects.ts";
import { type Failure, fail, type Result } from "./result.ts";
import {
	createTask,
	getTask,
	SEARCH_DEFAULT_LIMIT,
	SEARCH_MAX_LIMIT,
	searchTasks,
	updateTask,
} from "./tasks.ts";

export type RestContext = { db: Db; who: Principal };

const Text = (max: number) =>
	v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(max));
const Id = v.pipe(v.string(), v.minLength(1), v.maxLength(64));
// 制御文字（改行など）の入った名前は、一覧や履歴で別の名前と見分けられなくなる
const LabelName = v.pipe(Text(64), v.regex(/^\P{Cc}+$/u));
const State = v.picklist(TASK_STATES);

const ProjectInput = v.strictObject({
	name: Text(200),
	description: v.optional(v.pipe(v.string(), v.maxLength(10000)), ""),
});

const RepoInput = v.strictObject({
	// GitHub の owner（39 文字まで、英数字とハイフン）と repo の名前（100 文字まで）の形
	repo: v.pipe(
		v.string(),
		v.maxLength(140),
		v.regex(
			/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/,
		),
	),
});

const TaskInput = v.strictObject({
	project_id: Id,
	title: Text(500),
	body: v.optional(v.pipe(v.string(), v.maxLength(100000)), ""),
	parent_id: v.optional(Id),
	state: v.optional(v.picklist(["backlog", "todo"]), "backlog"),
	assignee_id: v.optional(Id),
	labels: v.optional(v.pipe(v.array(LabelName), v.maxLength(20)), []),
});

const TaskPatch = v.strictObject({
	title: v.optional(Text(500)),
	body: v.optional(v.pipe(v.string(), v.maxLength(100000))),
	state: v.optional(State),
	waiting_on: v.optional(v.nullable(Text(1000))),
	assignee_id: v.optional(v.nullable(Id)),
	labels: v.optional(v.pipe(v.array(LabelName), v.maxLength(20))),
	order: v.optional(
		v.union([v.strictObject({ before: Id }), v.strictObject({ after: Id })]),
	),
});

const TaskQuery = v.strictObject({
	project_id: v.optional(Id),
	q: v.optional(Text(200)),
	state: v.optional(
		v.pipe(
			v.string(),
			v.maxLength(200),
			v.transform((s) => [...new Set(s.split(","))]),
			v.array(State),
		),
	),
	assignee_id: v.optional(Id),
	parent_id: v.optional(Id),
	label: v.optional(LabelName),
	limit: v.optional(
		v.pipe(
			v.string(),
			v.regex(/^\d+$/),
			v.transform(Number),
			v.minValue(1),
			v.maxValue(SEARCH_MAX_LIMIT),
		),
		String(SEARCH_DEFAULT_LIMIT),
	),
});

const failure = (error: Failure) =>
	Response.json(
		{ error: error.code, message: error.message },
		{ status: error.status },
	);

const respond = <T>(result: Result<T>, status = 200) =>
	result.ok ? Response.json(result.value, { status }) : failure(result.error);

const parse = <S extends v.GenericSchema>(
	schema: S,
	input: unknown,
): Result<v.InferOutput<S>> => {
	const parsed = v.safeParse(schema, input);
	if (parsed.success) return { ok: true, value: parsed.output };
	return fail(
		400,
		"invalid_input",
		parsed.issues
			.map((i) => `${v.getDotPath(i) ?? "input"}: ${i.message}`)
			.join("; "),
	);
};

const body = async <S extends v.GenericSchema>(
	request: Request,
	schema: S,
): Promise<Result<v.InferOutput<S>>> => {
	let json: unknown;
	try {
		json = await request.json();
	} catch {
		return fail(400, "invalid_json", "JSON として読めない");
	}
	return parse(schema, json);
};

/** 機能の正。MCP もここを通るので、events に残る内容は入口によらず同じになる */
export const handleRest = async (
	request: Request,
	{ db, who }: RestContext,
): Promise<Response> => {
	const url = new URL(request.url);
	const segments = url.pathname.split("/").filter(Boolean).slice(1);
	const route = `${request.method} ${segments
		.map((s, i) => (i % 2 === 1 ? ":id" : s))
		.join("/")}`;
	const id = segments[1] ?? "";

	switch (route) {
		case "GET projects":
			return Response.json({ projects: await listProjects(db) });
		case "POST projects": {
			const input = await body(request, ProjectInput);
			if (!input.ok) return failure(input.error);
			return Response.json(await createProject(db, who, input.value), {
				status: 201,
			});
		}
		case "POST projects/:id/repos": {
			const input = await body(request, RepoInput);
			if (!input.ok) return failure(input.error);
			return respond(await linkRepo(db, who, id, input.value.repo));
		}
		case "GET tasks": {
			const query = parse(TaskQuery, Object.fromEntries(url.searchParams));
			if (!query.ok) return failure(query.error);
			return Response.json({ tasks: await searchTasks(db, query.value) });
		}
		case "POST tasks": {
			const input = await body(request, TaskInput);
			if (!input.ok) return failure(input.error);
			return respond(await createTask(db, who, input.value), 201);
		}
		case "GET tasks/:id":
			return respond(await getTask(db, id));
		case "PATCH tasks/:id": {
			const input = await body(request, TaskPatch);
			if (!input.ok) return failure(input.error);
			return respond(await updateTask(db, who, id, input.value));
		}
	}
	return failure({ status: 404, code: "not_found", message: "入口が無い" });
};
