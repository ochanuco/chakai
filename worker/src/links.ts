import { and, asc, eq, inArray } from "drizzle-orm";
import { findActor } from "./actors.ts";
import type { Principal } from "./auth.ts";
import type { Db } from "./db/client.ts";
import {
	githubLinks,
	type LinkKind,
	type LinkOwnerType,
	type LinkRole,
	type LinkSource,
	links,
	type PullChecks,
	type PullReview,
	type PullState,
	projectRepos,
	projects,
	tasks,
} from "./db/schema.ts";
import { retryOnConflict, writeAll } from "./db/write.ts";
import { type Change, eventInserts } from "./events.ts";
import {
	addLabel,
	fetchPulls,
	type GitHub,
	GitHubError,
	type Pull,
	type PullRef,
} from "./github.ts";
import { chunked } from "./history.ts";
import { newId } from "./id.ts";
import { fail, ok, type Result } from "./result.ts";

export type GithubPull = {
	repo: string;
	number: number;
	base_branch: string | null;
	draft: boolean | null;
	state: PullState | null;
	merged_into_default: boolean | null;
	review: PullReview | null;
	checks: PullChecks | null;
	synced_at: string | null;
};

export type Link = {
	id: string;
	owner_type: LinkOwnerType;
	owner_id: string;
	role: LinkRole;
	kind: LinkKind;
	url: string;
	title: string;
	note: string;
	linked_by: string;
	/** marker は、同期が PR の本文の印から付けた */
	source: LinkSource;
	created_at: string;
	/** 成果物の PR だけが持つ。同期で取り込んだ状態 */
	github: GithubPull | null;
};

type LinkRow = typeof links.$inferSelect;
type GithubRow = typeof githubLinks.$inferSelect;

const toLink = (row: LinkRow, github: GithubRow | null): Link => ({
	id: row.id,
	owner_type: row.ownerType,
	owner_id: row.ownerId,
	role: row.role,
	kind: row.kind,
	url: row.url,
	title: row.title,
	note: row.note,
	linked_by: row.linkedBy,
	source: row.source,
	created_at: row.createdAt,
	github: github && {
		repo: github.repo,
		number: github.number,
		base_branch: github.baseBranch,
		draft: github.draft,
		state: github.state,
		merged_into_default: github.mergedIntoDefault,
		review: github.review,
		checks: github.checks,
		synced_at: github.syncedAt,
	},
});

/** owner ごとのリンクを、付けた順に返す */
export const linksOf = async (
	db: Db,
	ownerType: LinkOwnerType,
	ownerIds: string[],
) => {
	const byOwner = new Map<string, Link[]>();
	for (const ids of chunked(ownerIds)) {
		const rows = await db
			.select({ link: links, github: githubLinks })
			.from(links)
			.leftJoin(githubLinks, eq(githubLinks.linkId, links.id))
			.where(and(eq(links.ownerType, ownerType), inArray(links.ownerId, ids)))
			.orderBy(asc(links.id));
		for (const r of rows) {
			byOwner.set(r.link.ownerId, [
				...(byOwner.get(r.link.ownerId) ?? []),
				toLink(r.link, r.github),
			]);
		}
	}
	return byOwner;
};

const REPO_PATH = /^\/([A-Za-z0-9-]+\/[A-Za-z0-9._-]+)\/(pull|issues)\/(\d+)/;

/**
 * URL から種類を決める。GitHub の PR と Issue は、タブやコメントの位置を落とした形に揃える
 * （同じ PR を別の URL で二重に付けないため）
 */
export const classifyUrl = (
	input: string,
): { kind: LinkKind; url: string; pull: PullRef | null } | null => {
	const parsed = URL.parse(input);
	if (!parsed || !["http:", "https:"].includes(parsed.protocol)) return null;
	const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
	if (host === "github.com") {
		const [, repo, type, number] = REPO_PATH.exec(parsed.pathname) ?? [];
		if (repo && type === "pull") {
			return {
				kind: "github_pr",
				url: `https://github.com/${repo}/pull/${number}`,
				pull: { repo, number: Number(number) },
			};
		}
		if (repo) {
			return {
				kind: "github_issue",
				url: `https://github.com/${repo}/issues/${number}`,
				pull: null,
			};
		}
	}
	const under = (domain: string) =>
		host === domain || host.endsWith(`.${domain}`);
	const kind: LinkKind =
		under("notion.so") || under("notion.site") || under("notion.com")
			? "notion"
			: host === "x.com" || host === "twitter.com"
				? "x"
				: "url";
	return { kind, url: parsed.href, pull: null };
};

export const pullUrl = (ref: PullRef) =>
	`https://github.com/${ref.repo}/pull/${ref.number}`;

/** AI を見分けるためのラベルなので、agent にだけ付ける */
export const actorLabelOf = async (db: Db, actorId: string | null) =>
	actorId && (await findActor(db, actorId))?.kind === "agent"
		? `actor:${actorId}`
		: null;

/**
 * PR に actor のラベルを付ける。定義の無いラベルは作らず、付けられなかった理由を返す。
 * pull は、label を付けて fetchPulls で読んだもの
 */
export const applyActorLabel = async (
	gh: GitHub,
	pull: Pull,
	label: string,
): Promise<string | null> => {
	if (pull.labels.includes(label)) return null;
	if (!pull.labelDefined) {
		return `${pull.repo} にラベル ${label} が定義されていないので、付けていない`;
	}
	try {
		await addLabel(gh, pull, label);
		return null;
	} catch (e) {
		if (!(e instanceof GitHubError)) throw e;
		return `${pullUrl(pull)} にラベル ${label} を付けられなかった（${e.message}）`;
	}
};

const githubValues = (pull: Pull, syncedAt: string) => ({
	baseBranch: pull.baseBranch,
	draft: pull.draft,
	state: pull.state,
	mergedIntoDefault: pull.mergedIntoDefault,
	review: pull.review,
	checks: pull.checks,
	syncedAt,
});

/** 同期で github_links を上書きする文。events には残さない */
export const pullUpdate = (
	db: Db,
	linkId: string,
	pull: Pull,
	syncedAt: string,
) =>
	db
		.update(githubLinks)
		.set(githubValues(pull, syncedAt))
		.where(eq(githubLinks.linkId, linkId));

/**
 * タスクに成果物の PR を付ける文を作る。PR の repo がプロジェクトに紐付いていなければ、一緒に足す。
 * pull が null なら、状態はまだ取り込めていないものとして空で持つ
 */
export const deliverableWrites = async (
	db: Db,
	who: Principal,
	at: string,
	task: { id: string; projectId: string },
	ref: PullRef,
	pull: Pull | null,
	text: { title: string; note: string },
	/** 付けるべき actor のラベルと、もう付いているか。付いていなければ、同期が付け直す */
	label: { name: string | null; applied: boolean },
	source: LinkSource,
) => {
	const row: LinkRow = {
		id: newId(),
		ownerType: "task",
		ownerId: task.id,
		role: "deliverable",
		kind: "github_pr",
		url: pullUrl(ref),
		title: text.title || (pull?.title ?? ""),
		note: text.note,
		linkedBy: who.actorId,
		source,
		createdAt: at,
	};
	const github: GithubRow = {
		linkId: row.id,
		repo: ref.repo,
		number: ref.number,
		baseBranch: null,
		draft: null,
		state: null,
		mergedIntoDefault: null,
		review: null,
		checks: null,
		syncedAt: null,
		...(pull ? githubValues(pull, at) : {}),
		actorLabel: label.name,
		labeledAt: label.name && label.applied ? at : null,
	};
	const link = toLink(row, github);
	const [known] = await db
		.select({ repo: projectRepos.repo })
		.from(projectRepos)
		.where(
			and(
				eq(projectRepos.projectId, task.projectId),
				eq(projectRepos.repo, ref.repo),
			),
		)
		.limit(1);
	const changes: Change[] = [
		{ entity: "task", entityId: task.id, field: "link", after: link },
	];
	if (!known) {
		changes.push({
			entity: "project",
			entityId: task.projectId,
			field: "repos",
			after: ref.repo,
		});
	}
	return {
		link,
		statements: [
			db.insert(links).values(row),
			db.insert(githubLinks).values(github),
			...(known
				? []
				: [
						db
							.insert(projectRepos)
							.values({ projectId: task.projectId, repo: ref.repo })
							.onConflictDoNothing(),
					]),
			...eventInserts(db, who, at, changes),
		],
	};
};

export type LinkOwner = { type: LinkOwnerType; id: string };

export type AddLinkInput = {
	url: string;
	role: LinkRole;
	title: string;
	note: string;
};

export type LinkWithWarnings = Link & { warnings: string[] };

export const NO_TOKEN_WARNING =
	"GitHub の token が無いので、PR の状態の取り込みとラベル付けをしていない";

const findOwner = async (db: Db, owner: LinkOwner) => {
	if (owner.type === "project") {
		const [row] = await db
			.select({ id: projects.id })
			.from(projects)
			.where(eq(projects.id, owner.id))
			.limit(1);
		return row && { id: row.id, projectId: row.id };
	}
	const [row] = await db
		.select({ id: tasks.id, projectId: tasks.projectId })
		.from(tasks)
		.where(eq(tasks.id, owner.id))
		.limit(1);
	return row;
};

const findLink = async (db: Db, owner: LinkOwner, url: string) => {
	const [row] = await db
		.select({ link: links, github: githubLinks })
		.from(links)
		.leftJoin(githubLinks, eq(githubLinks.linkId, links.id))
		.where(
			and(
				eq(links.ownerType, owner.type),
				eq(links.ownerId, owner.id),
				eq(links.url, url),
			),
		)
		.limit(1);
	return row && toLink(row.link, row.github);
};

export const addLink = async (
	db: Db,
	who: Principal,
	github: GitHub | null,
	owner: LinkOwner,
	input: AddLinkInput,
): Promise<Result<LinkWithWarnings>> => {
	const found = await findOwner(db, owner);
	if (!found) {
		return owner.type === "task"
			? fail(404, "task_not_found", "タスクが無い")
			: fail(404, "project_not_found", "プロジェクトが無い");
	}
	const target = classifyUrl(input.url);
	if (!target) {
		return fail(400, "invalid_url", "http か https の URL ではない");
	}
	const pull = input.role === "deliverable" ? target.pull : null;
	if (input.role === "deliverable" && (!pull || owner.type !== "task")) {
		return fail(
			400,
			"deliverable_must_be_pull",
			"成果物にできるのは、タスクに付ける GitHub の PR だけ。それ以外は reference で付ける",
		);
	}
	const duplicate = (existing: Link): Result<LinkWithWarnings> =>
		existing.role === input.role
			? ok({ ...existing, warnings: [] })
			: fail(
					409,
					"link_exists",
					`同じ URL が ${existing.role} として付いている。変えるときは、消してから付け直す`,
				);
	const existing = await findLink(db, owner, target.url);
	if (existing) return duplicate(existing);

	const warnings: string[] = [];
	let state: Pull | null = null;
	const label = pull ? await actorLabelOf(db, who.actorId) : null;
	let labeled = false;
	if (pull) {
		if (!github) {
			warnings.push(NO_TOKEN_WARNING);
		} else {
			try {
				[state = null] = await fetchPulls(github, [
					{ ...pull, ...(label ? { label } : {}) },
				]);
			} catch (e) {
				if (!(e instanceof GitHubError)) throw e;
				warnings.push(`PR の状態を取り込めなかった（${e.message}）`);
			}
			if (state && label) {
				const skipped = await applyActorLabel(github, state, label);
				if (skipped) warnings.push(skipped);
				labeled = !skipped;
			} else if (!state && warnings.length === 0) {
				return fail(
					400,
					"pull_not_found",
					"PR が無いか、chakai の token からは見えない",
				);
			}
		}
	}

	const write = async (): Promise<Result<LinkWithWarnings>> => {
		const raced = await findLink(db, owner, target.url);
		if (raced) return duplicate(raced);
		const at = new Date().toISOString();
		if (pull) {
			const { link, statements } = await deliverableWrites(
				db,
				who,
				at,
				found,
				pull,
				state,
				input,
				{ name: label, applied: labeled },
				"explicit",
			);
			await writeAll(db, statements);
			return ok({ ...link, warnings });
		}
		const row: LinkRow = {
			id: newId(),
			ownerType: owner.type,
			ownerId: owner.id,
			role: "reference",
			kind: target.kind,
			url: target.url,
			title: input.title,
			note: input.note,
			linkedBy: who.actorId,
			source: "explicit",
			createdAt: at,
		};
		const link = toLink(row, null);
		await writeAll(db, [
			db.insert(links).values(row),
			...eventInserts(db, who, at, [
				{ entity: owner.type, entityId: owner.id, field: "link", after: link },
			]),
		]);
		return ok({ ...link, warnings });
	};
	// 同じ URL を同時に付けると片方が一意制約で弾かれる。読み直せば、もう付いている
	return retryOnConflict(write, () =>
		fail(409, "conflict", "他の書き込みと重なった。もう一度試す"),
	);
};

export const removeLink = async (
	db: Db,
	who: Principal,
	id: string,
): Promise<Result<Link>> => {
	const [row] = await db
		.select({ link: links, github: githubLinks })
		.from(links)
		.leftJoin(githubLinks, eq(githubLinks.linkId, links.id))
		.where(eq(links.id, id))
		.limit(1);
	if (!row) return fail(404, "link_not_found", "リンクが無い");
	const link = toLink(row.link, row.github);
	await writeAll(db, [
		db.delete(githubLinks).where(eq(githubLinks.linkId, id)),
		db.delete(links).where(eq(links.id, id)),
		...eventInserts(db, who, new Date().toISOString(), [
			{
				entity: link.owner_type,
				entityId: link.owner_id,
				field: "link",
				before: link,
			},
		]),
	]);
	return ok(link);
};
