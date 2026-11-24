import { TASK_STATES, type TaskState } from "../db/schema.ts";
import type { Link } from "../links.ts";
import { type Progress, progressOf } from "../progress.ts";
import type { Actor } from "../roster.ts";
import {
	SETTING_KEYS,
	type SettingSource,
	type Settings,
} from "../settings.ts";
import type { SyncRun } from "../sync.ts";
import type {
	ProjectRow,
	ProjectView,
	RelatedTask,
	SettingsView,
	StateCounts,
	TaskRow,
} from "./data.ts";
import { html, type Markup } from "./html.ts";
import { type MoreItem, moreMenu, type Nav, page } from "./shell.ts";

export type { Nav } from "./shell.ts";

const JST_MS = 9 * 3_600_000;

export const formatJst = (iso: string): string => {
	const t = Date.parse(iso);
	if (Number.isNaN(t)) return iso;
	return new Date(t + JST_MS).toISOString().slice(0, 16).replace("T", " ");
};

export const ago = (iso: string, now: Date): string => {
	const minutes = Math.floor((now.getTime() - Date.parse(iso)) / 60_000);
	if (Number.isNaN(minutes) || minutes < 1) return "たった今";
	if (minutes < 60) return `${minutes} 分前`;
	if (minutes < 60 * 24) return `${Math.floor(minutes / 60)} 時間前`;
	return `${Math.floor(minutes / (60 * 24))} 日前`;
};

export const when = (iso: string, now: Date) =>
	`${formatJst(iso)}（${ago(iso, now)}）`;

export type Names = Map<string, string>;

export const actorNames = (actors: Actor[]): Names =>
	new Map(actors.map((a) => [a.id, a.display_name]));

export const nameOf = (names: Names, id: string) => names.get(id) ?? id;

export const isState = (value: unknown): value is TaskState =>
	TASK_STATES.includes(value as TaskState);

export const badge = (state: TaskState) =>
	html`<span class="state s-${state}">${state}</span>`;

const stateSelect = (task: TaskRow) =>
	html`<select class="state s-${task.state}" data-quick-state="${task.id}" data-current="${task.state}" aria-label="状態">${TASK_STATES.map(
		(s) =>
			html`<option value="${s}"${s === task.state ? html` selected` : ""}>${s}</option>`,
	)}</select>`;

export const labelChips = (names: string[]) =>
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
	progress?: Progress;
};

/** 続けさせるときは review の前の作業の状態に戻す。前が作業の状態でなければ todo にする */
export const resumeState = (from: TaskState | null): TaskState =>
	from === "todo" || from === "doing" ? from : "todo";

/** 数える末端が無い（子がすべて dropped の）ときは、率が意味を持たないので出さない */
export const progressBar = (p: Progress | undefined): Markup | "" =>
	p && p.total > 0
		? html`<progress value="${p.done}" max="${p.total}"></progress><span class="who">${p.done} / ${p.total}</span>`
		: "";

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
	return html`<div class="${classes}">${stateSelect(task)}<a class="title" href="/tasks/${task.id}">${task.title}</a>${progressBar(o.progress)}${labelChips(task.labels)}${
		task.assigneeId
			? html`<span class="who">担当 ${nameOf(o.names, task.assigneeId)}</span>`
			: ""
	}${o.project ? html`<a class="who" href="/projects/${o.project.id}">${o.project.name}</a>` : ""}${move}${waiting}</div>`;
};

export type Tone = "good" | "bad" | "wait" | "";

export const pill = (text: string, tone: Tone) =>
	html`<span class="pr${tone ? ` ${tone}` : ""}">${text}</span>`;

export const REVIEW_PILLS: Record<string, [string, Tone]> = {
	approved: ["レビュー 承認", "good"],
	changes_requested: ["レビュー 修正依頼", "bad"],
	review_required: ["レビュー 待ち", "wait"],
	none: ["レビュー なし", ""],
};

export const CHECKS_PILLS: Record<string, [string, Tone]> = {
	success: ["CI 成功", "good"],
	failure: ["CI 失敗", "bad"],
	pending: ["CI 実行中", "wait"],
	none: ["CI なし", ""],
};

/** リンク先は AI が書いた URL なので、http と https だけを href にする */
export const linkTitle = (link: Link) => {
	const text = link.title || link.url;
	return /^https?:\/\//.test(link.url)
		? html`<a class="title" href="${link.url}" rel="noreferrer">${text}</a>`
		: html`<span class="title">${text}</span>`;
};

const deliverableRow = (link: Link, now: Date) => {
	const g = link.github;
	if (!g) return html`<div class="row">${linkTitle(link)}</div>`;
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
					: pill(g.draft ? "open（draft）" : "open", "wait");
	const [review, reviewTone] = REVIEW_PILLS[g.review ?? ""] ?? ["", ""];
	const [checks, checksTone] = CHECKS_PILLS[g.checks ?? ""] ?? ["CI 不明", ""];
	return html`<div class="row">${state}${linkTitle(link)}<span class="who">${g.repo}#${g.number}${g.base_branch ? html` → ${g.base_branch}` : ""}${link.source === "marker" ? "・印から" : ""}</span>${review ? pill(review, reviewTone) : ""}${g.state === null ? "" : pill(checks, checksTone)}<span class="who">${g.synced_at ? html`同期 ${when(g.synced_at, now)}` : "まだ同期していない"}</span></div>`;
};

const referenceRow = (link: Link) =>
	html`<div class="row">${linkTitle(link)}<span class="who">${link.kind}</span>${link.note ? html`<div class="waiting muted">${link.note}</div>` : ""}</div>`;

const linkSections = (links: Link[], now: Date) => {
	const deliverables = links.filter((l) => l.role === "deliverable");
	const references = links.filter((l) => l.role === "reference");
	return html`${deliverables.length > 0 ? html`<h2>成果物の PR</h2><div>${deliverables.map((l) => deliverableRow(l, now))}</div>` : ""}${references.length > 0 ? html`<h2>参考リンク</h2><div>${references.map(referenceRow)}</div>` : ""}`;
};

/** More の下の画面。中身は文書のように 1 列で組む */
const doc = (
	title: string,
	content: Markup,
	nav: Nav,
	more?: MoreItem,
): string =>
	page({
		title,
		nav,
		section: "more",
		pane: "page",
		side: moreMenu(nav, more),
		main: html`<div class="doc">${content}</div>`,
		more,
	});

export const renderMore = (nav: Nav): string =>
	page({
		title: "More",
		nav,
		section: "more",
		pane: "page",
		side: moreMenu(nav),
		main: html`<div class="doc"><h1>More</h1>${moreMenu(nav)}</div>`,
	});

export const renderProjects = (
	view: {
		projects: ProjectRow[];
		counts: Map<string, StateCounts>;
	},
	nav: Nav,
): string => {
	// repo ごとにプロジェクトが自動でできるので、タスクの無いものまで札にすると一覧が埋まる
	const busy = view.projects.filter((p) => view.counts.has(p.id));
	const idle = view.projects.filter((p) => !view.counts.has(p.id));
	return doc(
		"プロジェクト",
		html`<h1>プロジェクト</h1>
${
	view.projects.length === 0
		? html`<p class="muted">プロジェクトはまだ無い。</p>`
		: html`${busy.map((p) => {
				const counts = view.counts.get(p.id) ?? {};
				return html`<div class="card"><a href="/projects/${p.id}"><strong>${p.name}</strong></a>
<div class="chips">${TASK_STATES.filter((s) => counts[s]).map(
					(s) =>
						html`<a class="state s-${s}" href="/projects/${p.id}?state=${s}">${s} ${counts[s]}</a>`,
				)}</div></div>`;
			})}${
				idle.length === 0
					? ""
					: html`<details><summary class="muted">タスクの無いプロジェクト ${idle.length}</summary>
<p>${idle.map((p, i) => html`${i > 0 ? "、" : ""}<a href="/projects/${p.id}">${p.name}</a>`)}</p></details>`
			}`
}`,
		nav,
		"projects",
	);
};

const SOURCE_NAMES: Record<SettingSource, string> = {
	default: "既定",
	global: "全体",
	project: "プロジェクト",
};

const DEPTH_KEY = "max_self_todo_depth";

/** scope に自分の値があるときだけ、入力欄に値を入れ、上の値に戻すボタンを出す */
const settingForm = (settings: Settings, own: SettingSource, reset: string) => {
	const { value, source } = settings.settings[DEPTH_KEY];
	const id = `f-depth-${settings.scope}`;
	return html`<form class="inline" data-setting-scope="${settings.scope}" data-key="${DEPTH_KEY}">
<span>効いている値 <strong>${value}</strong></span><span class="label">${SOURCE_NAMES[source]}</span>
<label class="muted" for="${id}">${own === "global" ? "全体の値" : "上書きする値"}</label><input id="${id}" type="number" name="value" min="0" max="20" step="1" inputmode="numeric" required${source === own ? html` value="${value}"` : ""}>
<button type="submit">保存</button>${source === own ? html`<button type="button" class="plain" data-setting-reset>${reset}</button>` : ""}
</form>`;
};

const projectSetting = ({
	project,
	settings,
}: SettingsView["projects"][number]) =>
	html`<div class="card"><div><a href="/projects/${project.id}"><strong>${project.name}</strong></a></div>${settingForm(settings, "project", "上書きを消す")}</div>`;

export const renderSettings = (view: SettingsView, nav: Nav): string => {
	const isOverridden = (s: SettingsView["projects"][number]) =>
		SETTING_KEYS.some((k) => s.settings.settings[k].source === "project");
	const overridden = view.projects.filter(isOverridden);
	const plain = view.projects.filter((s) => !isOverridden(s));
	return doc(
		"設定",
		html`<h1>設定</h1>
<h2>自分で作る todo の深さの上限 <span class="muted">${DEPTH_KEY}</span></h2>
<p class="muted">AI が親の下に todo でタスクを作るとき、AI が作ったタスクが上へ続いてよい数。0 から 20 の整数。プロジェクトに上書きが無ければ全体の値、全体の値も無ければ既定の値が効く。</p>
<h2>全体</h2>
<div class="card">${settingForm(view.global, "global", "既定に戻す")}</div>
<h2>プロジェクトごとの上書き</h2>
${
	view.projects.length === 0
		? html`<p class="muted">プロジェクトはまだ無い。</p>`
		: html`${overridden.map(projectSetting)}${
				plain.length === 0
					? ""
					: html`<details><summary class="muted">上書きの無いプロジェクト ${plain.length}</summary>${plain.map(projectSetting)}</details>`
			}`
}`,
		nav,
		"settings",
	);
};

export const renderSync = (
	runs: SyncRun[],
	names: Names,
	now: Date,
	nav: Nav,
): string =>
	doc(
		"同期",
		html`<h1>GitHub との同期 <span class="muted">直近 ${runs.length} 回</span></h1>
<p class="muted">1 時間ごとの同期と、手で呼んだ同期の結果。新しい順。</p>
${
	runs.length === 0
		? html`<p class="muted">同期の記録はまだ無い。</p>`
		: runs.map(
				(r) =>
					html`<div class="card"><div>${when(r.at, now)} <span class="label">${r.trigger === "cron" ? "Cron" : `手動（${nameOf(names, r.actor_id)}）`}</span>${r.skipped ? html`<span class="label">同期せず</span>` : ""}</div>
<div class="muted">取り込んだ PR ${r.synced}・印から付けたリンク ${r.linked}・done にしたタスク ${r.done}</div>
${r.warnings.map((w) => html`<p class="alert">${w}</p>`)}</div>`,
			)
}`,
		nav,
		"sync",
	);

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
	nav: Nav,
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
	// 絞り込みで隠れた子孫も数える
	const progress = progressOf(tasks);
	const branch = (siblings: TaskRow[], top: boolean): Markup =>
		html`<ul${top ? html` class="tree"` : ""}>${siblings.map((t, i) => {
			const children = childrenOf.get(t.id) ?? [];
			return html`<li>${taskRow(t, {
				names,
				now,
				context: !matched.has(t.id),
				progress: progress.get(t.id),
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

	return doc(
		project.name,
		html`<h1>${project.name}</h1>
${project.description ? html`<p class="body-text muted">${project.description}</p>` : ""}
${view.repos.length > 0 ? html`<p class="muted">repo: ${view.repos.join("、")}</p>` : ""}
${linkSections(view.links, now)}
<div class="chips">${chip("進行中", ACTIVE_STATES)}${chip("すべて", [...TASK_STATES], tasks.length)}</div>
<div class="chips">${TASK_STATES.map(toggle)}</div>
${roots.length > 0 ? branch(roots, true) : html`<p class="muted">当てはまるタスクは無い。</p>`}`,
		nav,
		"projects",
	);
};

export const FIELD_NAMES: Record<string, string> = {
	title: "件名",
	body: "本文",
	state: "状態",
	waiting_on: "仰ぐ内容",
	assignee_id: "担当",
	labels: "ラベル",
};

export const plain = (value: unknown): Markup => {
	if (value === null || value === undefined || value === "") {
		return html`<span class="muted">なし</span>`;
	}
	return html`${typeof value === "string" ? value : JSON.stringify(value)}`;
};

/** 関係の向きごとの呼び名。relation は「from_task が kind で to_task」と読む */
export const RELATION_NAMES: Record<
	RelatedTask["kind"],
	{ outgoing: string; incoming: string }
> = {
	discovered_from: {
		outgoing: "見つけた元",
		incoming: "ここで見つけた",
	},
	follows: { outgoing: "区切った元", incoming: "続き" },
	replaced_by: { outgoing: "作り直した先", incoming: "作り直す前" },
};

export const renderNotFound = (nav: Nav): string =>
	doc(
		"見つからない",
		html`<h1>見つからない</h1><p><a href="/">owner の番へ戻る</a></p>`,
		nav,
	);
