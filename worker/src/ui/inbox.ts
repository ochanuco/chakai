import { TASK_STATES, type TaskState } from "../db/schema.ts";
import type { TaskEvent } from "../history.ts";
import type { Link } from "../links.ts";
import type { Actor, Label } from "../roster.ts";
import { SYNC_ACTOR_ID } from "../sync.ts";
import type {
	DoingRow,
	ProjectRow,
	ReviewRow,
	TaskView,
	TriageRow,
} from "./data.ts";
import { html, type Markup } from "./html.ts";
import {
	ago,
	badge,
	CHECKS_PILLS,
	FIELD_NAMES,
	formatJst,
	isState,
	labelChips,
	linkTitle,
	type Names,
	nameOf,
	pill,
	plain,
	progressBar,
	RELATION_NAMES,
	REVIEW_PILLS,
	resumeState,
} from "./pages.ts";
import { type Nav, page } from "./shell.ts";

export type ListKind = "review" | "triage" | "doing";

export const LIST_HREF: Record<ListKind, string> = {
	review: "/",
	triage: "/triage",
	doing: "/doing",
};

export const taskHref = (id: string, from: ListKind) =>
	`/tasks/${id}?from=${from}`;

const LIST_TITLE: Record<ListKind, string> = {
	review: "Review",
	triage: "Triage",
	doing: "Doing",
};

const LIST_ORDER: Record<ListKind, string> = {
	review: "動きの新しい順",
	triage: "起票の古い順",
	doing: "動きの新しい順",
};

const timeAgo = (iso: string, now: Date) =>
	html`<time datetime="${iso}" title="${formatJst(iso)}">${ago(iso, now)}</time>`;

/** 一覧の 1 行。lead は太字の 1 行目、sub は小さく切る 2 行目 */
type Item = {
	id: string;
	project: string;
	who: string;
	at: string;
	lead: string;
	sub: Markup | string;
};

const PULL_STATE: Record<string, string> = {
	open: "open",
	closed: "closed",
	merged: "merged",
};

const pullSummary = (link: Link) => {
	const g = link.github;
	if (!g) return link.title || link.url;
	const state = g.state ? PULL_STATE[g.state] : "未取得";
	const [checks] = CHECKS_PILLS[g.checks ?? ""] ?? ["CI 不明"];
	return `${g.repo.split("/")[1] ?? g.repo} #${g.number} ${state}、${checks}`;
};

export type ListRows =
	| { kind: "review"; rows: ReviewRow[] }
	| { kind: "triage"; rows: TriageRow[] }
	| { kind: "doing"; rows: DoingRow[] };

const itemsOf = (
	list: ListRows,
	projects: Map<string, ProjectRow>,
	names: Names,
): Item[] => {
	const projectName = (id: string) => projects.get(id)?.name ?? "";
	switch (list.kind) {
		case "review":
			return list.rows.map((r) => ({
				id: r.id,
				project: projectName(r.projectId),
				who: nameOf(names, r.askedBy),
				at: r.activity,
				lead: r.waitingOn ?? r.title,
				sub: r.title,
			}));
		case "triage":
			return list.rows.map((r) => ({
				id: r.id,
				project: projectName(r.projectId),
				who: nameOf(names, r.createdBy),
				at: r.createdAt,
				lead: r.title,
				sub: r.discoveredFrom[0]
					? `「${r.discoveredFrom[0].title}」の作業中に見つけた`
					: "",
			}));
		case "doing":
			return list.rows.map((r) => ({
				id: r.id,
				project: projectName(r.projectId),
				who: r.openRun
					? `席 ${r.openRun.seat} の ${nameOf(names, r.openRun.actorId)}`
					: "席に渡していない",
				at: r.activity,
				lead: r.title,
				sub:
					r.pulls.length > 0
						? r.pulls.map(pullSummary).join(" / ")
						: r.children && r.children.total > 0
							? `子タスク ${r.children.done} / ${r.children.total} 済み`
							: "",
			}));
	}
};

const EMPTY_LIST: Record<ListKind, string> = {
	review: "判断を待っているタスクは無い。",
	triage: "仕分けを待っているタスクは無い。",
	doing: "作業中のタスクは無い。",
};

export const listPane = (
	list: ListRows,
	projects: Map<string, ProjectRow>,
	names: Names,
	now: Date,
	selected: string | null,
) => {
	const items = itemsOf(list, projects, names);
	return html`<h1 class="ltitle phone">${LIST_TITLE[list.kind]} <span class="muted">${items.length}</span></h1><div class="listbar"><span>${items.length} 件</span><span>${LIST_ORDER[list.kind]}</span></div>
<div class="list">${
		items.length === 0
			? html`<p class="empty">${EMPTY_LIST[list.kind]}</p>`
			: items.map(
					(i) =>
						html`<a class="item" href="${taskHref(i.id, list.kind)}" data-row${i.id === selected ? html` aria-current="true"` : ""}><span class="top"><span class="project">${i.project}</span><span>${i.who}</span>${timeAgo(i.at, now)}</span><span class="lead">${i.lead}</span>${i.sub ? html`<span class="sub">${i.sub}</span>` : ""}</a>`,
				)
	}</div>`;
};

/** 一覧での次の行。返事や仕分けの後に開く。無ければ一覧へ戻る */
export const nextHref = (list: ListRows, current: string) => {
	const ids = list.rows.map((r) => r.id);
	const i = ids.indexOf(current);
	const next = i < 0 ? ids[0] : (ids[i + 1] ?? ids[i - 1]);
	return next && next !== current
		? taskHref(next, list.kind)
		: LIST_HREF[list.kind];
};

// --- タスクの会話 ---

const avatar = (name: string) =>
	html`<span class="avatar" aria-hidden="true">${[...name][0]?.toUpperCase() ?? "?"}</span>`;

const via = (e: TaskEvent) =>
	e.caller_id === null
		? e.actor_id === SYNC_ACTOR_ID
			? "Cron"
			: "ブラウザ"
		: (e.caller_name ?? "不明な呼び出し元");

/** 同じ書き込みで残した行（同じ時刻・同じ actor）を 1 つの出来事にまとめる */
const groupEvents = (history: TaskEvent[]) => {
	const groups: TaskEvent[][] = [];
	for (const e of history) {
		const last = groups.at(-1);
		const head = last?.[0];
		if (last && head && head.at === e.at && head.actor_id === e.actor_id) {
			last.push(e);
		} else {
			groups.push([e]);
		}
	}
	return groups;
};

type Entry = {
	at: string;
	actor: string;
	via: string;
	kind: "line" | "say" | "question" | "answer";
	what: Markup;
	text: string | null;
	/** 問いと一緒に残した一言 */
	note?: string | null;
	detail?: Markup;
};

const describe = (e: TaskEvent, names: Names): Markup | null => {
	const { field, before, after } = e;
	switch (field) {
		case "order_key":
			return html`並びを変えた`;
		case "triaged_at":
			return html`仕分けて backlog に残した`;
		case "relation": {
			const kind = (after as { kind?: unknown } | null)?.kind;
			return html`関係を付けた${typeof kind === "string" ? html`（${kind}）` : ""}`;
		}
		case "link": {
			const link = (after ?? before) as {
				url?: unknown;
				role?: unknown;
			} | null;
			const role = link?.role === "deliverable" ? "成果物の PR" : "参考リンク";
			return html`${role}を${after ? "付けた" : "消した"}`;
		}
		case "assignee_id":
			return typeof after === "string"
				? html`担当を ${nameOf(names, after)} にした`
				: html`担当を外した`;
		case "labels":
			return Array.isArray(after) && after.length > 0
				? html`ラベルを ${labelChips(after.map(String))} にした`
				: html`ラベルを外した`;
		case "title":
			return html`件名を変えた`;
		case "body":
			return html`本文を変えた`;
		case "parent_id":
			return html`親を変えた`;
	}
	return html`${FIELD_NAMES[field] ?? field}を ${plain(after)} にした`;
};

const entryOf = (group: TaskEvent[], names: Names): Entry | null => {
	const head = group[0];
	if (!head || group.some((e) => e.field === "created")) return null;
	const of = (field: string) => group.find((e) => e.field === field);
	const state = of("state");
	const note = of("note");
	const waiting = of("waiting_on");
	const noteText = typeof note?.after === "string" ? note.after : null;
	const base = {
		at: head.at,
		actor: nameOf(names, head.actor_id),
		via: via(head),
	};
	const rest = group
		.filter((e) => !["state", "note", "waiting_on"].includes(e.field))
		.map((e) => describe(e, names))
		.filter((m): m is Markup => m !== null);
	const bodyChange = of("body");
	const detail = bodyChange
		? html`<details><summary>本文の差分</summary><div class="muted">前</div><pre>${plain(bodyChange.before)}</pre><div class="muted">後</div><pre>${plain(bodyChange.after)}</pre></details>`
		: undefined;
	const joined = (parts: (Markup | string)[]) =>
		html`${parts.map((p, i) => html`${i > 0 ? "、" : ""}${p}`)}`;

	if (state && state.after === "review") {
		return {
			...base,
			kind: "question",
			what: joined([html` review にした`, ...rest]),
			text: typeof waiting?.after === "string" ? waiting.after : null,
			note: noteText,
			detail,
		};
	}
	if (state && state.before === "review") {
		const to = isState(state.after) ? state.after : "";
		return {
			...base,
			kind: "answer",
			what: joined([html`返事をして ${to} にした`, ...rest]),
			text: noteText,
			detail,
		};
	}
	const parts = [
		...(state && isState(state.after) ? [html` ${state.after} にした`] : []),
		...(waiting && typeof waiting.after === "string"
			? [html`問いを変えた`]
			: []),
		...rest,
	];
	const text =
		noteText ?? (typeof waiting?.after === "string" ? waiting.after : null);
	if (parts.length === 0 && text === null) return null;
	return {
		...base,
		kind: text === null ? "line" : "say",
		what: parts.length > 0 ? joined(parts) : html`一言`,
		text,
		detail,
	};
};

const when = (e: Entry, now: Date) =>
	html`<span class="when">${timeAgo(e.at, now)}<span class="via">${e.via}</span></span>`;

const entryItem = (e: Entry, now: Date) =>
	e.kind === "line"
		? html`<li class="ev line"><span class="dot" aria-hidden="true"></span><span class="what"><b>${e.actor}</b> が${e.what}</span>${when(e, now)}${e.detail ?? ""}</li>`
		: html`<li class="ev ${e.kind}">${avatar(e.actor)}<div class="bubble"><div class="bh"><span><b>${e.actor}</b> が${e.what}</span>${when(e, now)}</div>${e.text ? html`<p class="bt">${e.text}</p>` : ""}${e.note ? html`<p class="bt note">${e.note}</p>` : ""}${e.detail ?? ""}</div></li>`;

export type Order = "desc" | "asc";

export type Detail = {
	view: TaskView;
	history: TaskEvent[];
	actors: Actor[];
	labels: Label[];
	now: Date;
	from: ListKind;
	order: Order;
	/** 返事や仕分けの後に開く先 */
	next: string;
	awaitingTriage: boolean;
};

const replyButtons = (resume: TaskState, formId?: string) => {
	const owner = formId ? html` form="${formId}"` : "";
	return html`<button type="submit"${owner} name="to" value="dropped" class="quiet">Drop</button><button type="submit"${owner} name="to" value="done" class="outline">Done</button><button type="submit"${owner} name="to" value="${resume}" class="primary" data-default>Reply</button>`;
};

const triageButtons = (id: string, next: string) =>
	html`<button type="button" class="quiet" data-triage="${id}" data-action="dropped" data-next="${next}">Drop</button><button type="button" class="outline" data-triage="${id}" data-action="keep" data-next="${next}">Backlog</button><button type="button" class="primary" data-triage="${id}" data-action="todo" data-next="${next}">Todo</button>`;

const REPLY_HINT = "空のまま Reply すると「それで進めて」と返す";

const composer = (d: Detail) =>
	html`<li class="ev composer desk">${avatar("owner")}<form id="reply-desk" class="bubble" data-reply="${d.view.task.id}" data-next="${d.next}"><label class="bh" for="answer-desk">返事 <span class="muted">${REPLY_HINT}</span></label><textarea id="answer-desk" name="answer" rows="3" maxlength="2000"></textarea></form></li>`;

const metaRow = (label: string, body: Markup | string) =>
	html`<div class="mrow"><span class="mlabel">${label}</span><div>${body}</div></div>`;

const pullRow = (link: Link, now: Date) => {
	const g = link.github;
	if (!g) return html`<div class="pull">${linkTitle(link)}</div>`;
	const state =
		g.state === null
			? pill("未取得", "")
			: g.state === "merged"
				? pill(
						g.merged_into_default ? "merged" : `merged（${g.base_branch} へ）`,
						g.merged_into_default ? "good" : "wait",
					)
				: g.state === "closed"
					? pill("closed", "")
					: pill(g.draft ? "draft" : "open", "wait");
	const [review, reviewTone] = REVIEW_PILLS[g.review ?? ""] ?? ["", ""];
	const [checks, checksTone] = CHECKS_PILLS[g.checks ?? ""] ?? ["CI 不明", ""];
	return html`<div class="pull">${linkTitle(link)}<span class="muted">${g.repo}#${g.number}${link.source === "marker" ? " 印から付けた" : ""}</span><span class="pills">${state}${g.state === null ? "" : pill(checks, checksTone)}${review ? pill(review, reviewTone) : ""}</span><span class="muted">${g.synced_at ? html`同期 ${timeAgo(g.synced_at, now)}` : "まだ同期していない"}</span></div>`;
};

const editForm = (d: Detail) => {
	const { task } = d.view;
	const assignable = d.actors.filter(
		(a) => a.active || a.id === task.assigneeId,
	);
	return html`<details class="edit"><summary>状態・担当・ラベルを変える</summary>
<form id="edit" data-task="${task.id}" data-state="${task.state}" data-assignee="${task.assigneeId ?? ""}" data-labels="${JSON.stringify([...task.labels].sort())}" data-waiting="${task.waitingOn ?? ""}">
<div class="field"><label for="f-state">状態</label><select id="f-state" name="state">${TASK_STATES.map(
		(s) =>
			html`<option value="${s}"${s === task.state ? html` selected` : ""}>${s}</option>`,
	)}</select></div>
<div class="field" id="waiting-row"><label for="f-waiting">owner に仰ぐ内容（review にするときに要る）</label><textarea id="f-waiting" name="waiting_on" rows="2" maxlength="1000">${task.waitingOn ?? ""}</textarea></div>
<div class="field"><label for="f-assignee">担当</label><select id="f-assignee" name="assignee_id"><option value="">なし</option>${assignable.map(
		(a) =>
			html`<option value="${a.id}"${a.id === task.assigneeId ? html` selected` : ""}>${a.display_name}</option>`,
	)}</select></div>
<fieldset class="field"><legend>ラベル</legend><div class="checks">${d.labels.map(
		(l) =>
			html`<label><input type="checkbox" name="label" value="${l.name}"${task.labels.includes(l.name) ? html` checked` : ""}> ${l.name}</label>`,
	)}</div></fieldset>
<div class="field"><label for="f-new-labels">新しいラベル（カンマで区切る）</label><input id="f-new-labels" type="text" name="new_labels" autocomplete="off"></div>
<div class="field"><label for="f-note">一言（履歴に残す。review から出すときに要る）</label><textarea id="f-note" name="note" rows="2" maxlength="2000"></textarea></div>
<button type="submit" class="primary">保存</button>
</form></details>`;
};

const metaColumn = (d: Detail, names: Names) => {
	const { view } = d;
	const pulls = view.links.filter((l) => l.role === "deliverable");
	const references = view.links.filter((l) => l.role === "reference");
	return html`<aside class="meta" id="meta" aria-label="タスクの情報">
${metaRow("状態", html`${badge(view.task.state)} ${progressBar(view.progress.get(view.task.id))}`)}
${metaRow("担当", view.task.assigneeId ? nameOf(names, view.task.assigneeId) : html`<span class="muted">なし</span>`)}
${metaRow("ラベル", view.task.labels.length > 0 ? html`${labelChips(view.task.labels)}` : html`<span class="muted">なし</span>`)}
${pulls.length > 0 ? metaRow("成果物", html`${pulls.map((l) => pullRow(l, d.now))}`) : ""}
${references.length > 0 ? metaRow("参考", html`${references.map((l) => html`<div class="pull">${linkTitle(l)}${l.note ? html`<span class="muted">${l.note}</span>` : ""}</div>`)}`) : ""}
${
	view.relations.length > 0
		? metaRow(
				"関係",
				html`${view.relations.map(
					(r) =>
						html`<div class="rel">${RELATION_NAMES[r.kind][r.outgoing ? "outgoing" : "incoming"]}: <a href="/tasks/${r.task.id}">${r.task.title}</a> ${badge(r.task.state)}${r.seat ? html` <span class="muted">席 ${r.seat}</span>` : ""}</div>`,
				)}`,
			)
		: ""
}
${
	view.runs.length > 0
		? metaRow(
				"実行記録",
				html`${view.runs.map(
					(r) =>
						html`<div class="rel">席 ${r.seat} の ${nameOf(names, r.actor_id)} <span class="muted">${r.model ?? "model なし"}</span><div class="muted">${formatJst(r.started_at)} から${r.ended_at ? html` ${formatJst(r.ended_at)} まで` : " 実行中"}</div></div>`,
				)}`,
			)
		: ""
}
${metaRow("起票", html`${nameOf(names, view.task.createdBy)} <span class="muted">${formatJst(view.task.createdAt)}</span>`)}
${editForm(d)}
</aside>`;
};

const chips = (d: Detail, names: Names) => {
	const { task, links } = d.view;
	const pulls = links.filter((l) => l.role === "deliverable");
	return html`<div class="tchips phone">${
		task.assigneeId
			? html`<a class="chip" href="#meta"><span class="muted">担当</span> ${nameOf(names, task.assigneeId)}</a>`
			: ""
	}${pulls.map((l) => html`<a class="chip" href="#meta"><span class="muted">PR</span> ${pullSummary(l)}</a>`)}${
		task.labels.length > 0
			? html`<a class="chip" href="#meta"><span class="muted">ラベル</span> ${task.labels.join(" ")}</a>`
			: ""
	}<a class="chip" href="#meta">変える</a></div>`;
};

const subline = (d: Detail, names: Names) => {
	const { task, lastReview } = d.view;
	if (task.state === "review" && lastReview) {
		return html`${nameOf(names, lastReview.asked_by)} の問い ${timeAgo(lastReview.asked_at, d.now)}`;
	}
	return html`更新 ${timeAgo(task.updatedAt, d.now)}`;
};

export const detailPane = (d: Detail) => {
	const { task, project, ancestors, lastReview } = d.view;
	const names = new Map(d.actors.map((a) => [a.id, a.display_name]));
	const reviewing = task.state === "review";
	const resume = resumeState(lastReview?.from ?? null);
	const entries = groupEvents(d.history)
		.map((g) => entryOf(g, names))
		.filter((e): e is Entry => e !== null);
	if (d.order === "desc") entries.reverse();
	const items = entries.map((e) => entryItem(e, d.now));
	const timeline = reviewing
		? d.order === "desc"
			? [composer(d), ...items]
			: [...items, composer(d)]
		: items;
	const orderHref = `/tasks/${task.id}?from=${d.from}${d.order === "desc" ? "&order=asc" : ""}`;
	const question = lastReview?.question ?? task.waitingOn ?? "";
	const created = d.history.find((e) => e.field === "created");
	return html`<header class="head">
${
	// Triage はスマホで一覧を持たず 1 件ずつ捌くので、戻る先が無い
	d.from === "triage"
		? ""
		: html`<a class="back phone" href="${LIST_HREF[d.from]}" aria-label="${LIST_TITLE[d.from]} の一覧へ戻る"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M15 5l-7 7 7 7"></path></svg></a>`
}
<div class="titles"><h1>${task.title}</h1><div class="line">${badge(task.state)}<span class="crumbs"><a href="/projects/${project.id}">${project.name}</a>${ancestors.map((a) => html` › <a href="/tasks/${a.id}">${a.title}</a>`)}</span><span>${subline(d, names)}</span></div></div>
${reviewing ? html`<div class="actions desk">${replyButtons(resume, "reply-desk")}</div>` : d.awaitingTriage ? html`<div class="actions desk">${triageButtons(task.id, d.next)}</div>` : ""}
</header>
${chips(d, names)}
<div class="body">
<div class="conv">
<article class="ev say opening">${avatar(nameOf(names, task.createdBy))}<div class="bubble"><div class="bh"><span><b>${nameOf(names, task.createdBy)}</b> が起票した</span><span class="when">${timeAgo(task.createdAt, d.now)}${created ? html`<span class="via">${via(created)}</span>` : ""}</span></div>${task.body ? html`<p class="bt">${task.body}</p>` : html`<p class="bt muted">本文は無い。</p>`}</div></article>
${
	d.view.children.length > 0
		? html`<section class="children"><h2>子タスク</h2>${d.view.children.map(
				(c) =>
					html`<div class="child">${badge(c.state)}<a href="/tasks/${c.id}">${c.title}</a>${progressBar(d.view.progress.get(c.id))}</div>`,
			)}</section>`
		: ""
}
${
	timeline.length > 0
		? html`<div class="tlhead"><h2>動き <span class="muted">${entries.length}</span></h2><a class="sort" href="${orderHref}">${d.order === "desc" ? "新しい順" : "古い順"}（切り替える）</a></div>
<ol class="timeline">${timeline}</ol>`
		: ""
}
</div>
${metaColumn(d, names)}
</div>
${
	reviewing
		? html`<form class="bar phone" data-reply="${task.id}" data-next="${d.next}"><p class="ask">${question}</p><label class="sr" for="answer-phone">返事</label><textarea id="answer-phone" name="answer" rows="2" maxlength="2000" placeholder="${REPLY_HINT}"></textarea><div class="buttons">${replyButtons(resume)}</div></form>`
		: d.awaitingTriage
			? html`<div class="bar phone"><div class="buttons">${triageButtons(task.id, d.next)}</div></div>`
			: ""
}`;
};

const BLANK: Record<ListKind, string> = {
	review: "あなたの判断を待っているタスクは無い。",
	triage: "仕分けを待っているタスクは無い。",
	doing: "作業中のタスクは無い。",
};

export const blankPane = (kind: ListKind, nav: Nav) => {
	const hint =
		kind !== "triage" && nav.triage > 0
			? html`<p><a href="/triage">Triage に ${nav.triage} 件ある</a></p>`
			: kind !== "review" && nav.review > 0
				? html`<p><a href="/">Review に ${nav.review} 件ある</a></p>`
				: "";
	return html`<div class="blank"><p>${BLANK[kind]}</p>${hint}</div>`;
};

export const renderInbox = (s: {
	list: ListRows;
	projects: ProjectRow[];
	names: Names;
	now: Date;
	nav: Nav;
	detail: Detail | null;
	/** スマホで最初に見せるペイン */
	pane: "list" | "detail";
}): string =>
	page({
		title: s.detail ? s.detail.view.task.title : LIST_TITLE[s.list.kind],
		nav: s.nav,
		section: s.list.kind,
		pane: s.pane,
		side: listPane(
			s.list,
			new Map(s.projects.map((p) => [p.id, p])),
			s.names,
			s.now,
			s.detail?.view.task.id ?? null,
		),
		main: s.detail ? detailPane(s.detail) : blankPane(s.list.kind, s.nav),
	});
