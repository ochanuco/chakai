import { listTaskEvents } from "../history.ts";
import type { RestContext } from "../rest.ts";
import { isOwnerLogin, listActors, listLabels } from "../roster.ts";
import { CLIENT_JS } from "./client.ts";
import {
	loadProject,
	loadProjects,
	loadReviews,
	loadStateCounts,
	loadTask,
} from "./data.ts";
import {
	actorNames,
	parseStates,
	renderHome,
	renderNotFound,
	renderProject,
	renderTask,
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
	if (request.method !== "GET" || rest.length > 0) {
		return page(renderNotFound(), 404);
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
			renderHome({ reviews, projects, counts, names: actorNames(actors), now }),
		);
	}
	if (section === "assets" && id === "app.js") {
		return new Response(CLIENT_JS, {
			headers: {
				...HEADERS,
				"content-type": "text/javascript; charset=utf-8",
			},
		});
	}
	if (section === "projects" && id) {
		const view = await loadProject(db, id);
		if (!view) return page(renderNotFound(), 404);
		return page(
			renderProject(
				view,
				parseStates(url.searchParams.get("state")),
				actorNames(await listActors(db)),
				now,
			),
		);
	}
	if (section === "tasks" && id) {
		const view = await loadTask(db, id);
		const history = await listTaskEvents(db, id);
		if (!view || !history.ok) return page(renderNotFound(), 404);
		const [actors, labels] = await Promise.all([
			listActors(db),
			listLabels(db),
		]);
		return page(renderTask(view, history.value, actors, labels, now));
	}
	return page(renderNotFound(), 404);
};
