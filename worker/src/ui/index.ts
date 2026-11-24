import { eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { tasks } from "../db/schema.ts";
import { listTaskEvents } from "../history.ts";
import type { RestContext } from "../rest.ts";
import { isOwnerLogin, listActors, listLabels } from "../roster.ts";
import { listSyncRuns } from "../sync.ts";
import { CLIENT_JS } from "./client.ts";
import {
	loadCounts,
	loadDoing,
	loadProject,
	loadProjects,
	loadRecent,
	loadReviews,
	loadSettings,
	loadStateCounts,
	loadTask,
	loadTodo,
	loadTriage,
	type TriageRow,
} from "./data.ts";
import {
	type Detail,
	type ListKind,
	type ListRows,
	listPane,
	nextHref,
	type Order,
	renderInbox,
} from "./inbox.ts";
import {
	actorNames,
	parseStates,
	renderMore,
	renderNotFound,
	renderProject,
	renderProjects,
	renderSettings,
	renderSync,
} from "./pages.ts";
import type { Nav } from "./shell.ts";

const HEADERS = {
	"cache-control": "no-store",
	"content-security-policy":
		"default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
	"x-content-type-options": "nosniff",
};

const page = (body: string, status = 200) =>
	new Response(body, {
		status,
		headers: { ...HEADERS, "content-type": "text/html; charset=utf-8" },
	});

const LIST_KINDS: ListKind[] = ["review", "triage", "todo", "doing", "recent"];

const loadList = async (
	db: Db,
	kind: ListKind,
	q: string | null,
): Promise<ListRows> => {
	switch (kind) {
		case "review":
			return { kind, rows: await loadReviews(db) };
		case "triage":
			return { kind, rows: await loadTriage(db) };
		case "todo":
			return { kind, rows: await loadTodo(db) };
		case "doing":
			return { kind, rows: await loadDoing(db) };
		case "recent":
			return { kind, rows: await loadRecent(db, q), q };
	}
};

/** 一覧から開いていないときは、タスクの今の状態から一覧を選ぶ */
const listOfTask = (
	param: string | null,
	state: string,
	awaitingTriage: boolean,
): ListKind => {
	if (LIST_KINDS.includes(param as ListKind)) return param as ListKind;
	if (awaitingTriage) return "triage";
	if (state === "review" || state === "todo" || state === "doing") return state;
	// backlog・done・dropped はどの一覧にも入らないので、Recent から開く
	return "recent";
};

const loadDetail = async (
	db: Db,
	taskId: string,
	list: ListRows,
	order: Order,
	now: Date,
	triageIds: Set<string>,
): Promise<Detail | null> => {
	const [view, history, actors, labels] = await Promise.all([
		loadTask(db, taskId),
		listTaskEvents(db, taskId),
		listActors(db),
		listLabels(db),
	]);
	if (!view || !history.ok) return null;
	return {
		view,
		history: history.value,
		actors,
		labels,
		now,
		from: list.kind,
		order,
		next: nextHref(list, taskId),
		awaitingTriage: triageIds.has(taskId),
	};
};

/** owner の画面。読み取りは REST と同じ関数で行い、書き込みは script が REST を呼ぶ */
export const handleUi = async (
	request: Request,
	{ db, who }: RestContext,
): Promise<Response> => {
	if (!(await isOwnerLogin(db, who))) {
		return Response.json(
			{ error: "owner_only", message: "画面は owner のログインでだけ開ける" },
			{ status: 403 },
		);
	}
	const url = new URL(request.url);
	const [section, id, ...rest] = url.pathname.split("/").filter(Boolean);
	if (
		request.method === "GET" &&
		section === "assets" &&
		id === "app.js" &&
		rest.length === 0
	) {
		return new Response(CLIENT_JS, {
			headers: {
				...HEADERS,
				"content-type": "text/javascript; charset=utf-8",
			},
		});
	}
	const [runs, counts] = await Promise.all([listSyncRuns(db), loadCounts(db)]);
	const nav: Nav = { ...counts, syncWarnings: runs[0]?.warnings.length ?? 0 };
	if (request.method !== "GET" || rest.length > 0) {
		return page(renderNotFound(nav), 404);
	}
	const now = new Date();
	const order: Order = url.searchParams.get("order") === "asc" ? "asc" : "desc";

	const inbox = async (
		kind: ListKind,
		taskId?: string,
		loadedTriage?: TriageRow[],
	) => {
		const [list, projects, actors, triage] = await Promise.all([
			loadList(db, kind, url.searchParams.get("q")?.trim() || null),
			loadProjects(db),
			listActors(db),
			kind === "triage" ? null : (loadedTriage ?? loadTriage(db)),
		]);
		const triageIds = new Set(
			(list.kind === "triage" ? list.rows : (triage ?? [])).map((r) => r.id),
		);
		// 数えた後に一覧が増減していても、切り替えの件数と一覧の件数が食い違わないようにする
		const shown: Nav = { ...nav, [kind]: list.rows.length };
		const selected = taskId ?? list.rows[0]?.id;
		const detail = selected
			? await loadDetail(db, selected, list, order, now, triageIds)
			: null;
		if (taskId && !detail) return page(renderNotFound(shown), 404);
		return page(
			renderInbox({
				list,
				projects,
				names: actorNames(actors),
				now,
				nav: shown,
				detail,
				// Triage は 1 件ずつ捌くので、スマホでも先頭のタスクから見せる
				pane: taskId || (kind === "triage" && detail) ? "detail" : "list",
			}),
		);
	};

	if (section === undefined) return inbox("review");
	if (
		(section === "triage" ||
			section === "todo" ||
			section === "doing" ||
			section === "recent") &&
		!id
	) {
		return inbox(section);
	}
	if (section === "tasks" && id) {
		const [[task], triage] = await Promise.all([
			db
				.select({ state: tasks.state })
				.from(tasks)
				.where(eq(tasks.id, id))
				.limit(1),
			loadTriage(db),
		]);
		if (!task) return page(renderNotFound(nav), 404);
		return inbox(
			listOfTask(
				url.searchParams.get("from"),
				task.state,
				triage.some((t) => t.id === id),
			),
			id,
			triage,
		);
	}
	// 一覧の画面でなくても、左ペインには Review の一覧を出し、画面ごとに形を変えない
	const [reviews, allProjects, actors] = await Promise.all([
		loadReviews(db),
		loadProjects(db),
		listActors(db),
	]);
	nav.side = listPane(
		{ kind: "review", rows: reviews },
		new Map(allProjects.map((p) => [p.id, p])),
		actorNames(actors),
		now,
		null,
	);
	if (section === "more" && !id) return page(renderMore(nav));
	if (section === "projects" && !id) {
		const [projects, stateCounts] = await Promise.all([
			loadProjects(db),
			loadStateCounts(db),
		]);
		return page(renderProjects({ projects, counts: stateCounts }, nav));
	}
	if (section === "sync" && !id) {
		return page(renderSync(runs, actorNames(await listActors(db)), now, nav));
	}
	if (section === "settings" && !id) {
		return page(renderSettings(await loadSettings(db), nav));
	}
	if (section === "projects" && id) {
		const view = await loadProject(db, id);
		if (!view) return page(renderNotFound(nav), 404);
		return page(
			renderProject(
				view,
				parseStates(url.searchParams.get("state")),
				actorNames(await listActors(db)),
				now,
				nav,
			),
		);
	}
	return page(renderNotFound(nav), 404);
};
