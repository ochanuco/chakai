import { TASK_STATES, type TaskState } from "../db/schema.ts";
import type { TaskEvent } from "../history.ts";
import type { Actor, Label } from "../roster.ts";
import type {
	ProjectRow,
	ProjectView,
	ReviewRow,
	StateCounts,
	TaskRow,
	TaskView,
} from "./data.ts";
import { html, Markup } from "./html.ts";

const CSS = `
:root{color-scheme:light dark;--bg:#f7f7f5;--card:#fff;--fg:#1d1d1b;--muted:#6b6b66;--line:#e2e2dc;--link:#2459a6;--alert-bg:#fde4e4;--alert-fg:#8f1d1d;
--backlog-bg:#e8e8e3;--backlog-fg:#4a4a45;--todo-bg:#dbe8fb;--todo-fg:#1d4f91;--doing-bg:#fdecc8;--doing-fg:#855000;--review-bg:#f9d9e3;--review-fg:#9c1f4a;--done-bg:#d9f0dc;--done-fg:#1f6b2a;--dropped-fg:#85857f}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--card:#1e1e1c;--fg:#ecece8;--muted:#a0a09a;--line:#33332f;--link:#8ab4f8;--alert-bg:#4a1c1c;--alert-fg:#ffc9c9;
--backlog-bg:#33332f;--backlog-fg:#c9c9c2;--todo-bg:#1d3557;--todo-fg:#a9cbff;--doing-bg:#4a3410;--doing-fg:#ffcf7a;--review-bg:#55202f;--review-fg:#ffb0c6;--done-bg:#1d3f23;--done-fg:#9bdca3;--dropped-fg:#8f8f88}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 system-ui,-apple-system,"Hiragino Sans",sans-serif;overflow-wrap:anywhere}
a{color:var(--link);text-decoration:none}
a:hover{text-decoration:underline}
header{border-bottom:1px solid var(--line);background:var(--card)}
header nav{max-width:960px;margin:0 auto;padding:10px 16px;display:flex;gap:16px;align-items:baseline}
header .brand{font-weight:700;color:var(--fg)}
main{max-width:960px;margin:0 auto;padding:16px 16px 48px}
h1{font-size:1.3rem;line-height:1.4;margin:8px 0}
h2{font-size:1.05rem;margin:28px 0 8px}
.muted{color:var(--muted);font-size:.875rem}
.crumbs{font-size:.875rem;color:var(--muted)}
.alert{background:var(--alert-bg);color:var(--alert-fg);border-radius:8px;padding:10px 12px;margin:12px 0}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin-top:8px}
.state{display:inline-block;border:0;border-radius:999px;padding:2px 10px;font:inherit;font-size:.8rem;font-weight:600;line-height:1.5;white-space:nowrap}
select.state{appearance:none;-webkit-appearance:none;cursor:pointer;padding-right:22px;background-image:linear-gradient(45deg,transparent 50%,currentColor 50%),linear-gradient(135deg,currentColor 50%,transparent 50%);background-position:calc(100% - 12px) 55%,calc(100% - 8px) 55%;background-size:4px 4px;background-repeat:no-repeat}
.s-backlog{background-color:var(--backlog-bg);color:var(--backlog-fg)}
.s-todo{background-color:var(--todo-bg);color:var(--todo-fg)}
.s-doing{background-color:var(--doing-bg);color:var(--doing-fg)}
.s-review{background-color:var(--review-bg);color:var(--review-fg)}
.s-done{background-color:var(--done-bg);color:var(--done-fg)}
.s-dropped{background-color:transparent;color:var(--dropped-fg);box-shadow:inset 0 0 0 1px var(--line);text-decoration:line-through}
.label{display:inline-block;border:1px solid var(--line);border-radius:6px;padding:0 6px;font-size:.78rem;color:var(--muted);margin-right:4px}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin:12px 0}
.chip{border:1px solid var(--line);border-radius:999px;padding:2px 12px;font-size:.85rem;color:var(--fg);background:var(--card)}
.chip.on{border-color:var(--fg);font-weight:600}
.chip .n{color:var(--muted);font-weight:400;margin-left:4px}
ul.tree,ul.tree ul{list-style:none;margin:0;padding:0}
ul.tree ul{margin-left:14px;padding-left:10px;border-left:2px solid var(--line)}
.row{display:flex;flex-wrap:wrap;align-items:center;gap:4px 8px;padding:8px 0;border-bottom:1px solid var(--line)}
.row .title{flex:1 1 180px;min-width:0;color:var(--fg)}
.row .who{color:var(--muted);font-size:.85rem;white-space:nowrap}
.row .waiting{flex-basis:100%;font-size:.875rem;color:var(--review-fg)}
.row.context{opacity:.55}
.row.closed .title{color:var(--muted)}
.move{display:inline-flex;gap:2px;margin-left:auto}
.move button{width:30px;height:30px;border:1px solid var(--line);border-radius:6px;background:var(--card);color:var(--fg);font:inherit;cursor:pointer}
.move button:disabled{opacity:.3;cursor:default}
.body{white-space:pre-wrap;margin:0;font:inherit}
dl.meta{display:grid;grid-template-columns:max-content 1fr;gap:4px 16px;margin:12px 0}
dl.meta dt{color:var(--muted);font-size:.875rem}
dl.meta dd{margin:0}
form .field{margin:10px 0}
form .field>label,form .field>.name{display:block;font-size:.875rem;color:var(--muted);margin-bottom:2px}
form select,form input[type=text],form textarea{font:inherit;color:var(--fg);background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:6px 8px;max-width:100%}
form textarea,form input[type=text]{width:100%}
form .checks{display:flex;flex-wrap:wrap;gap:4px 14px}
form button[type=submit]{font:inherit;font-weight:600;padding:6px 18px;border-radius:6px;border:1px solid var(--fg);background:var(--fg);color:var(--bg);cursor:pointer}
form button:disabled{opacity:.5}
ol.history{list-style:none;margin:0;padding:0}
ol.history li{padding:8px 0;border-bottom:1px solid var(--line)}
ol.history .when{color:var(--muted);font-size:.85rem}
ol.history details pre{white-space:pre-wrap;margin:4px 0;padding:8px;background:var(--bg);border:1px solid var(--line);border-radius:6px;font:inherit;font-size:.875rem}
.arrow{color:var(--muted);margin:0 4px}
`;

const JST_MS = 9 * 3_600_000;

const formatJst = (iso: string): string => {
	const t = Date.parse(iso);
	if (Number.isNaN(t)) return iso;
	return new Date(t + JST_MS).toISOString().slice(0, 16).replace("T", " ");
};

const ago = (iso: string, now: Date): string => {
	const minutes = Math.floor((now.getTime() - Date.parse(iso)) / 60_000);
	if (Number.isNaN(minutes) || minutes < 1) return "たった今";
	if (minutes < 60) return `${minutes} 分前`;
	if (minutes < 60 * 24) return `${Math.floor(minutes / 60)} 時間前`;
	return `${Math.floor(minutes / (60 * 24))} 日前`;
};

const when = (iso: string, now: Date) =>
	`${formatJst(iso)}（${ago(iso, now)}）`;

export type Names = Map<string, string>;

export const actorNames = (actors: Actor[]): Names =>
	new Map(actors.map((a) => [a.id, a.display_name]));

const nameOf = (names: Names, id: string) => names.get(id) ?? id;

const isState = (value: unknown): value is TaskState =>
	TASK_STATES.includes(value as TaskState);

const badge = (state: TaskState) =>
	html`<span class="state s-${state}">${state}</span>`;

const stateSelect = (task: TaskRow) =>
	html`<select class="state s-${task.state}" data-quick-state="${task.id}" data-current="${task.state}" aria-label="状態">${TASK_STATES.map(
		(s) =>
			html`<option value="${s}"${s === task.state ? html` selected` : ""}>${s}</option>`,
	)}</select>`;

const labelChips = (names: string[]) =>
	names.map((name) => html`<span class="label">${name}</span>`);

const CLOSED: TaskState[] = ["done", "dropped"];

type RowOptions = {
	names: Names;
	now: Date;
	context?: boolean;
	/** 並びを動かす相手。同じ親の、表示している前後のタスク */
	prev?: string;
	next?: string;
	movable?: boolean;
	project?: ProjectRow;
	since?: string;
};

const taskRow = (task: TaskRow, o: RowOptions) => {
	const classes = [
		"row",
		o.context ? "context" : "",
		CLOSED.includes(task.state) ? "closed" : "",
	]
		.filter(Boolean)
		.join(" ");
	const move = o.movable
		? html`<span class="move"><button type="button" data-move="${task.id}" data-dir="before" data-anchor="${o.prev ?? ""}" aria-label="上へ" title="上へ"${o.prev ? "" : html` disabled`}>↑</button><button type="button" data-move="${task.id}" data-dir="after" data-anchor="${o.next ?? ""}" aria-label="下へ" title="下へ"${o.next ? "" : html` disabled`}>↓</button></span>`
		: "";
	const waiting =
		task.state === "review"
			? html`<div class="waiting">仰ぐ内容: ${task.waitingOn ?? ""}${o.since ? html` <span class="muted">・${when(o.since, o.now)}から</span>` : ""}</div>`
			: "";
	return html`<div class="${classes}">${stateSelect(task)}<a class="title" href="/tasks/${task.id}">${task.title}</a>${labelChips(task.labels)}${
		task.assigneeId
			? html`<span class="who">担当 ${nameOf(o.names, task.assigneeId)}</span>`
			: ""
	}${o.project ? html`<a class="who" href="/projects/${o.project.id}">${o.project.name}</a>` : ""}${move}${waiting}</div>`;
};

const page = (title: string, content: Markup): string =>
	html`<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} - chakai</title>
<style>${new Markup(CSS)}</style>
</head>
<body>
<header><nav><a class="brand" href="/">chakai</a><a href="/">owner の番</a><a href="/#projects">プロジェクト</a></nav></header>
<main>
<p id="alert" class="alert" role="alert" hidden></p>
${content}
</main>
<script src="/assets/app.js"></script>
</body>
</html>`.value;

export const renderHome = (view: {
	reviews: ReviewRow[];
	projects: ProjectRow[];
	counts: Map<string, StateCounts>;
	names: Names;
	now: Date;
}): string => {
	const projectById = new Map(view.projects.map((p) => [p.id, p]));
	return page(
		"owner の番",
		html`<h1>owner の番 <span class="muted">review ${view.reviews.length} 件</span></h1>
${
	view.reviews.length === 0
		? html`<p class="muted">判断を待っているタスクは無い。</p>`
		: html`<div>${view.reviews.map((t) =>
				taskRow(t, {
					names: view.names,
					now: view.now,
					project: projectById.get(t.projectId),
					since: t.since,
				}),
			)}</div>`
}
<h2 id="projects">プロジェクト</h2>
${
	view.projects.length === 0
		? html`<p class="muted">プロジェクトはまだ無い。</p>`
		: view.projects.map((p) => {
				const counts = view.counts.get(p.id) ?? {};
				return html`<div class="card"><a href="/projects/${p.id}"><strong>${p.name}</strong></a>
<div class="chips">${TASK_STATES.filter((s) => counts[s]).map(
					(s) =>
						html`<a class="state s-${s}" href="/projects/${p.id}?state=${s}">${s} ${counts[s]}</a>`,
				)}${Object.keys(counts).length === 0 ? html`<span class="muted">タスクなし</span>` : ""}</div></div>`;
			})
}`,
	);
};

export const ACTIVE_STATES: TaskState[] = [
	"backlog",
	"todo",
	"doing",
	"review",
];

/** state の絞り込み。無ければ進行中の 4 つ、all ならすべて */
export const parseStates = (param: string | null): TaskState[] => {
	if (param === null) return ACTIVE_STATES;
	if (param === "all") return [...TASK_STATES];
	const picked = TASK_STATES.filter((s) => param.split(",").includes(s));
	return picked.length > 0 ? picked : ACTIVE_STATES;
};

const sameStates = (a: TaskState[], b: TaskState[]) =>
	a.length === b.length && a.every((s) => b.includes(s));

const stateHref = (projectId: string, states: TaskState[]) => {
	if (sameStates(states, ACTIVE_STATES)) return `/projects/${projectId}`;
	if (states.length === TASK_STATES.length) {
		return `/projects/${projectId}?state=all`;
	}
	return `/projects/${projectId}?state=${TASK_STATES.filter((s) => states.includes(s)).join(",")}`;
};

export const renderProject = (
	view: ProjectView,
	states: TaskState[],
	names: Names,
	now: Date,
): string => {
	const { project, tasks } = view;
	const byId = new Map(tasks.map((t) => [t.id, t]));
	const matched = new Set(
		tasks.filter((t) => states.includes(t.state)).map((t) => t.id),
	);
	// 絞り込みに合う子が親を失わないよう、合わない親も文脈として残す
	const visible = new Set(matched);
	for (const id of matched) {
		let parentId = byId.get(id)?.parentId;
		while (parentId && byId.has(parentId) && !visible.has(parentId)) {
			visible.add(parentId);
			parentId = byId.get(parentId)?.parentId;
		}
	}
	const childrenOf = new Map<string, TaskRow[]>();
	const roots: TaskRow[] = [];
	for (const t of tasks) {
		if (!visible.has(t.id)) continue;
		if (t.parentId && byId.has(t.parentId)) {
			childrenOf.set(t.parentId, [...(childrenOf.get(t.parentId) ?? []), t]);
		} else {
			roots.push(t);
		}
	}
	const branch = (siblings: TaskRow[], top: boolean): Markup =>
		html`<ul${top ? html` class="tree"` : ""}>${siblings.map((t, i) => {
			const children = childrenOf.get(t.id) ?? [];
			return html`<li>${taskRow(t, {
				names,
				now,
				context: !matched.has(t.id),
				movable: true,
				prev: siblings[i - 1]?.id,
				next: siblings[i + 1]?.id,
			})}${children.length > 0 ? branch(children, false) : ""}</li>`;
		})}</ul>`;

	const counts: StateCounts = {};
	for (const t of tasks) counts[t.state] = (counts[t.state] ?? 0) + 1;
	const chip = (label: string, target: TaskState[], n?: number) =>
		html`<a class="chip${sameStates(states, target) ? " on" : ""}" href="${stateHref(project.id, target)}">${label}${n === undefined ? "" : html`<span class="n">${n}</span>`}</a>`;
	const toggle = (s: TaskState) => {
		const on = states.includes(s);
		const target = on ? states.filter((x) => x !== s) : [...states, s];
		return html`<a class="chip${on ? " on" : ""}" href="${stateHref(project.id, target.length > 0 ? target : ACTIVE_STATES)}" aria-pressed="${on ? "true" : "false"}">${on ? "✓ " : ""}${s}<span class="n">${counts[s] ?? 0}</span></a>`;
	};

	return page(
		project.name,
		html`<h1>${project.name}</h1>
${project.description ? html`<p class="body muted">${project.description}</p>` : ""}
${view.repos.length > 0 ? html`<p class="muted">repo: ${view.repos.join("、")}</p>` : ""}
<div class="chips">${chip("進行中", ACTIVE_STATES)}${chip("すべて", [...TASK_STATES], tasks.length)}</div>
<div class="chips">${TASK_STATES.map(toggle)}</div>
${roots.length > 0 ? branch(roots, true) : html`<p class="muted">当てはまるタスクは無い。</p>`}`,
	);
};

const FIELD_NAMES: Record<string, string> = {
	title: "件名",
	body: "本文",
	state: "状態",
	waiting_on: "仰ぐ内容",
	assignee_id: "担当",
	labels: "ラベル",
};

const plain = (value: unknown): Markup => {
	if (value === null || value === undefined || value === "") {
		return html`<span class="muted">なし</span>`;
	}
	return html`${typeof value === "string" ? value : JSON.stringify(value)}`;
};

const change = (event: TaskEvent, names: Names): Markup => {
	const { field, before, after } = event;
	const fromTo = (show: (value: unknown) => Markup) =>
		html`${FIELD_NAMES[field] ?? field}: ${show(before)}<span class="arrow">→</span>${show(after)}`;
	switch (field) {
		case "created": {
			const state = (after as { state?: unknown } | null)?.state;
			return html`起票 ${isState(state) ? badge(state) : ""}`;
		}
		case "order_key":
			return html`並びを変更`;
		case "state":
			return fromTo((v) => (isState(v) ? badge(v) : plain(v)));
		case "assignee_id":
			return fromTo((v) =>
				typeof v === "string" ? html`${nameOf(names, v)}` : plain(v),
			);
		case "labels":
			return fromTo((v) =>
				Array.isArray(v) && v.length > 0
					? html`${labelChips(v.map(String))}`
					: plain(null),
			);
		case "body":
			return html`<details><summary>本文を変更</summary><div class="muted">前</div><pre>${plain(before)}</pre><div class="muted">後</div><pre>${plain(after)}</pre></details>`;
	}
	return fromTo(plain);
};

export const renderTask = (
	view: TaskView,
	history: TaskEvent[],
	actors: Actor[],
	labels: Label[],
	now: Date,
): string => {
	const { task, project } = view;
	const names = actorNames(actors);
	const assignable = actors.filter((a) => a.active || a.id === task.assigneeId);
	return page(
		task.title,
		html`<p class="crumbs"><a href="/projects/${project.id}">${project.name}</a>${view.ancestors.map(
			(a) => html` › <a href="/tasks/${a.id}">${a.title}</a>`,
		)}</p>
<h1>${task.title}</h1>
<p>${badge(task.state)} ${labelChips(task.labels)}</p>
${
	task.state === "review"
		? html`<div class="card"><strong>仰ぐ内容</strong>: ${task.waitingOn ?? ""}${view.reviewSince ? html`<div class="muted">${when(view.reviewSince, now)}から review</div>` : ""}</div>`
		: ""
}
<dl class="meta">
<dt>担当</dt><dd>${task.assigneeId ? nameOf(names, task.assigneeId) : html`<span class="muted">なし</span>`}</dd>
<dt>起票</dt><dd>${nameOf(names, task.createdBy)} <span class="muted">${when(task.createdAt, now)}</span></dd>
<dt>更新</dt><dd><span class="muted">${when(task.updatedAt, now)}</span></dd>
</dl>
<h2>本文</h2>
${task.body ? html`<div class="card"><p class="body">${task.body}</p></div>` : html`<p class="muted">本文は無い。</p>`}
${
	view.children.length > 0
		? html`<h2>子タスク</h2><div>${view.children.map((c, i) =>
				taskRow(c, {
					names,
					now,
					movable: true,
					prev: view.children[i - 1]?.id,
					next: view.children[i + 1]?.id,
				}),
			)}</div>`
		: ""
}
<h2>変更</h2>
<form id="edit" class="card" data-task="${task.id}">
<div class="field"><label for="f-state">状態</label><select id="f-state" name="state">${TASK_STATES.map(
			(s) =>
				html`<option value="${s}"${s === task.state ? html` selected` : ""}>${s}</option>`,
		)}</select></div>
<div class="field" id="waiting-row"><label for="f-waiting">owner に仰ぐ内容（review にするときに要る）</label><textarea id="f-waiting" name="waiting_on" rows="2" maxlength="1000">${task.waitingOn ?? ""}</textarea></div>
<div class="field"><label for="f-assignee">担当</label><select id="f-assignee" name="assignee_id"><option value="">なし</option>${assignable.map(
			(a) =>
				html`<option value="${a.id}"${a.id === task.assigneeId ? html` selected` : ""}>${a.display_name}</option>`,
		)}</select></div>
<div class="field"><span class="name">ラベル</span><div class="checks">${labels.map(
			(l) =>
				html`<label><input type="checkbox" name="label" value="${l.name}"${task.labels.includes(l.name) ? html` checked` : ""}> ${l.name}</label>`,
		)}</div></div>
<div class="field"><label for="f-new-labels">新しいラベル（カンマで区切る）</label><input id="f-new-labels" type="text" name="new_labels" autocomplete="off"></div>
<button type="submit">保存</button>
</form>
<h2>履歴</h2>
<ol class="history">${[...history]
			.reverse()
			.map(
				(e) =>
					html`<li><div>${change(e, names)}</div><div class="when">${nameOf(names, e.actor_id)}・${e.caller_id === null ? "ブラウザ" : (e.caller_name ?? "不明な呼び出し元")}・${when(e.at, now)}</div></li>`,
			)}</ol>`,
	);
};

export const renderNotFound = (): string =>
	page(
		"見つからない",
		html`<h1>見つからない</h1><p><a href="/">owner の番へ戻る</a></p>`,
	);
