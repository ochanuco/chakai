import { listTaskEvents } from "../history.ts";
import type { RestContext } from "../rest.ts";
import { isOwnerLogin, listActors, listLabels } from "../roster.ts";
import { listSyncRuns } from "../sync.ts";
import { CLIENT_JS } from "./client.ts";
import {
	countTriage,
	loadProject,
	loadProjects,
	loadReviews,
	loadSettings,
	loadStateCounts,
	loadTask,
	loadTriage,
} from "./data.ts";
import {
	actorNames,
	parseStates,
	renderHome,
	renderNotFound,
	renderProject,
	renderSettings,
	renderSync,
	renderTask,
	renderTriage,
} from "./pages.ts";

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
	const runs = await listSyncRuns(db);
	const nav = {
		triage: await countTriage(db),
		syncWarnings: runs[0]?.warnings.length ?? 0,
	};
	if (request.method !== "GET" || rest.length > 0) {
		return page(renderNotFound(nav), 404);
	}
	const now = new Date();

	if (section === undefined) {
		const [reviews, projects, counts, actors] = await Promise.all([
			loadReviews(db),
			loadProjects(db),
			loadStateCounts(db),
			listActors(db),
		]);
		return page(
			renderHome(
				{ reviews, projects, counts, names: actorNames(actors), now },
				nav,
			),
		);
	}
	if (section === "triage" && !id) {
		const [rows, projects, actors] = await Promise.all([
			loadTriage(db),
			loadProjects(db),
			listActors(db),
		]);
		// 数えた後に仕分け待ちが増減していても、見出しとナビゲーションの件数が食い違わないようにする
		return page(
			renderTriage(
				{ rows, projects, names: actorNames(actors), now },
				{ ...nav, triage: rows.length },
			),
		);
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
	if (section === "tasks" && id) {
		const view = await loadTask(db, id);
		const history = await listTaskEvents(db, id);
		if (!view || !history.ok) return page(renderNotFound(nav), 404);
		const [actors, labels] = await Promise.all([
			listActors(db),
			listLabels(db),
		]);
		return page(renderTask(view, history.value, actors, labels, now, nav));
	}
	return page(renderNotFound(nav), 404);
};
