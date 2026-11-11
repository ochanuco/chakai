import type { PullChecks, PullReview, PullState } from "./db/schema.ts";

/** GitHub を呼ぶ口。fetch を差し替えられるのは、テストが GitHub の代わりに答えるため */
export type GitHub = { token: string; fetch: typeof fetch };

export class GitHubError extends Error {}

const API = "https://api.github.com";

const request = async (gh: GitHub, path: string, init: RequestInit = {}) => {
	const res = await gh.fetch(`${API}${path}`, {
		...init,
		headers: {
			accept: "application/vnd.github+json",
			authorization: `Bearer ${gh.token}`,
			"content-type": "application/json",
			"user-agent": "chakai",
			"x-github-api-version": "2022-11-28",
		},
	});
	if (!res.ok) {
		throw new GitHubError(
			`GitHub ${init.method ?? "GET"} ${path}: ${res.status}`,
		);
	}
	return res;
};

type GraphQlError = { type?: string; path?: unknown[]; message?: string };

/**
 * 1 つの問い合わせに複数の repo を別名で並べるので、読めない repo が混ざると data の一部が null になり、
 * errors にその別名が載る。全体は失敗にせず、別名ごとに呼ぶ側が扱う
 */
const graphql = async <T>(
	gh: GitHub,
	query: string,
	variables: Record<string, unknown>,
): Promise<{ data: T; errors: GraphQlError[] }> => {
	const res = await request(gh, "/graphql", {
		method: "POST",
		body: JSON.stringify({ query, variables }),
	});
	const body = await res.json<{ data?: T | null; errors?: GraphQlError[] }>();
	if (!body.data) {
		throw new GitHubError(
			`GitHub GraphQL: ${body.errors?.map((e) => e.message).join("; ") ?? "data が無い"}`,
		);
	}
	return { data: body.data, errors: body.errors ?? [] };
};

const splitRepo = (repo: string) => {
	const [owner = "", name = ""] = repo.split("/");
	return { owner, name };
};

export type PullRef = { repo: string; number: number };

export const pullKey = (ref: PullRef) => `${ref.repo}#${ref.number}`;

export type Pull = PullRef & {
	title: string;
	state: PullState;
	draft: boolean;
	baseBranch: string;
	mergedIntoDefault: boolean;
	review: PullReview;
	/** null は、CI の結果を読めなかった */
	checks: PullChecks | null;
	labels: string[];
	/** 問い合わせに label を付けたときだけ入る。その名前のラベルが repo に定義されているか */
	labelDefined: boolean | null;
};

type PullNode = {
	number: number;
	title: string;
	state: "OPEN" | "CLOSED" | "MERGED";
	isDraft: boolean;
	baseRefName: string;
	headRefOid: string;
	reviewDecision: string | null;
	latestOpinionatedReviews: { nodes: { state: string }[] } | null;
	labels: { nodes: { name: string }[] } | null;
	commits: {
		nodes: { commit: { statusCheckRollup: { state: string } | null } }[];
	} | null;
};

type PullRepoNode = {
	defaultBranchRef: { name: string } | null;
	label?: { name: string } | null;
	pullRequest: PullNode | null;
} | null;

const PULL_FIELDS = `number title state isDraft baseRefName headRefOid reviewDecision
latestOpinionatedReviews(first: 20) { nodes { state } }
labels(first: 50) { nodes { name } }
commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }`;

// レビューを必須にしていない repo では reviewDecision が null のままなので、レビューそのものから決める
const reviewOf = (node: PullNode): PullReview => {
	const states = node.latestOpinionatedReviews?.nodes.map((r) => r.state) ?? [];
	if (states.includes("CHANGES_REQUESTED")) return "changes_requested";
	if (states.includes("APPROVED")) return "approved";
	return node.reviewDecision === "REVIEW_REQUIRED" ? "review_required" : "none";
};

const ROLLUP: Record<string, PullChecks> = {
	SUCCESS: "success",
	FAILURE: "failure",
	ERROR: "failure",
	PENDING: "pending",
	EXPECTED: "pending",
};

const FAILED_CONCLUSIONS = [
	"failure",
	"timed_out",
	"cancelled",
	"startup_failure",
	"action_required",
];

type WorkflowRun = {
	workflow_id: number;
	status: string | null;
	conclusion: string | null;
	created_at: string;
};

/**
 * head の commit の CI の結果を、Actions の workflow run と commit status から読む。
 * fine-grained PAT には Checks の権限が無く、statusCheckRollup を読めない repo があるため。
 * どちらかを読めなければ、結果は分からないとして null を返す
 */
const checksFromRest = async (
	gh: GitHub,
	repo: string,
	sha: string,
): Promise<PullChecks | null> => {
	try {
		const [runsRes, statusRes] = await Promise.all([
			request(gh, `/repos/${repo}/actions/runs?head_sha=${sha}&per_page=100`),
			request(gh, `/repos/${repo}/commits/${sha}/status`),
		]);
		const { workflow_runs: runs } = await runsRes.json<{
			workflow_runs: WorkflowRun[];
		}>();
		const status = await statusRes.json<{
			state: string;
			total_count: number;
		}>();
		// 同じ workflow を流し直した run が並ぶので、workflow ごとに新しいものだけを見る
		const latest = new Map<number, WorkflowRun>();
		for (const run of runs) {
			const seen = latest.get(run.workflow_id);
			if (!seen || seen.created_at < run.created_at) {
				latest.set(run.workflow_id, run);
			}
		}
		const results: PullChecks[] = [...latest.values()].map((run) => {
			if (run.status !== "completed") return "pending";
			return FAILED_CONCLUSIONS.includes(run.conclusion ?? "")
				? "failure"
				: "success";
		});
		// status が 1 つも無いときも state は pending で返る
		if (status.total_count > 0) {
			results.push(
				status.state === "success"
					? "success"
					: status.state === "pending"
						? "pending"
						: "failure",
			);
		}
		if (results.includes("failure")) return "failure";
		if (results.includes("pending")) return "pending";
		return results.length > 0 ? "success" : "none";
	} catch (e) {
		if (!(e instanceof GitHubError)) throw e;
		return null;
	}
};

const toPull = async (
	gh: GitHub,
	ref: PullRef,
	repoNode: NonNullable<PullRepoNode>,
	node: PullNode,
	withLabel: boolean,
): Promise<Pull> => {
	const rollup = node.commits?.nodes[0]?.commit.statusCheckRollup?.state;
	const state: PullState =
		node.state === "MERGED"
			? "merged"
			: node.state === "CLOSED"
				? "closed"
				: "open";
	return {
		...ref,
		title: node.title,
		state,
		draft: node.isDraft,
		baseBranch: node.baseRefName,
		mergedIntoDefault:
			state === "merged" &&
			node.baseRefName === repoNode.defaultBranchRef?.name,
		review: reviewOf(node),
		checks:
			ROLLUP[rollup ?? ""] ??
			(await checksFromRest(gh, ref.repo, node.headRefOid)),
		labels: node.labels?.nodes.map((l) => l.name) ?? [],
		labelDefined: withLabel ? Boolean(repoNode.label) : null,
	};
};

// 1 つの問い合わせに並べる数。GitHub は 1 つの問い合わせが辿る node の数に上限を持つ
const PULLS_PER_QUERY = 30;
const REPOS_PER_QUERY = 10;

const chunks = <T>(items: T[], size: number): T[][] =>
	Array.from({ length: Math.ceil(items.length / size) }, (_, i) =>
		items.slice(i * size, (i + 1) * size),
	);

/**
 * PR の状態を、渡した順に読む。読めなかった PR（無い、token に見えない）は null。
 * label を渡した PR には、その名前のラベルが repo に定義されているかも付ける
 */
export const fetchPulls = async (
	gh: GitHub,
	refs: (PullRef & { label?: string })[],
): Promise<(Pull | null)[]> => {
	const pulls: (Pull | null)[] = [];
	for (const batch of chunks(refs, PULLS_PER_QUERY)) {
		const variables: Record<string, unknown> = {};
		const declarations: string[] = [];
		const selections = batch.map((ref, i) => {
			const { owner, name } = splitRepo(ref.repo);
			variables[`o${i}`] = owner;
			variables[`n${i}`] = name;
			variables[`k${i}`] = ref.number;
			declarations.push(`$o${i}: String!, $n${i}: String!, $k${i}: Int!`);
			let label = "";
			if (ref.label !== undefined) {
				variables[`l${i}`] = ref.label;
				declarations.push(`$l${i}: String!`);
				label = `label(name: $l${i}) { name }`;
			}
			return `p${i}: repository(owner: $o${i}, name: $n${i}) { defaultBranchRef { name } ${label} pullRequest(number: $k${i}) { ${PULL_FIELDS} } }`;
		});
		const { data } = await graphql<Record<string, PullRepoNode>>(
			gh,
			`query(${declarations.join(", ")}) { ${selections.join("\n")} }`,
			variables,
		);
		pulls.push(
			...(await Promise.all(
				batch.map((ref, i) => {
					const repoNode = data[`p${i}`];
					return repoNode?.pullRequest
						? toPull(
								gh,
								{ repo: ref.repo, number: ref.number },
								repoNode,
								repoNode.pullRequest,
								ref.label !== undefined,
							)
						: null;
				}),
			)),
		);
	}
	return pulls;
};

export type ScannedPull = { number: number; body: string };

type PullPage = {
	pageInfo: { hasNextPage: boolean; endCursor: string | null };
	nodes: { number: number; body: string; updatedAt: string }[];
};

type ScanRepoNode = { open?: PullPage; recent?: PullPage } | null;

const SCAN_PAGE = `pageInfo { hasNextPage endCursor } nodes { number body updatedAt }`;
// 1 つの repo で辿るページの上限。超えた分は読まず、読めたところまでを返す
const MAX_SCAN_ROUNDS = 5;

type ScanCursor = {
	repo: string;
	since: string | null;
	open: boolean;
	openAfter: string | null;
	recent: boolean;
	recentAfter: string | null;
};

export type ScanResult = {
	/** 読めた repo と、その開いている PR・since の後に更新された PR */
	scanned: Map<string, ScannedPull[]>;
	/** 見終えなかった repo。読めなかったものと、ページの上限に届いたもの */
	failed: string[];
};

/**
 * repo ごとに、開いている PR と、since の後に更新された PR の本文を読む。
 * since が null の repo は、更新の新しい順に 1 ページだけ読む
 */
export const scanRepos = async (
	gh: GitHub,
	repos: { repo: string; since: string | null }[],
): Promise<ScanResult> => {
	const found = new Map<string, Map<number, ScannedPull>>();
	const failed = new Set<string>();
	const unreadable = new Set<string>();
	let pending: ScanCursor[] = repos.map((r) => ({
		...r,
		open: true,
		openAfter: null,
		recent: true,
		recentAfter: null,
	}));
	for (const r of repos) found.set(r.repo, new Map());

	for (let round = 0; pending.length > 0; round++) {
		if (round >= MAX_SCAN_ROUNDS) {
			for (const c of pending) failed.add(c.repo);
			break;
		}
		const next: ScanCursor[] = [];
		for (const batch of chunks(pending, REPOS_PER_QUERY)) {
			const variables: Record<string, unknown> = {};
			const declarations: string[] = [];
			const selections = batch.map((c, i) => {
				const { owner, name } = splitRepo(c.repo);
				Object.assign(variables, {
					[`o${i}`]: owner,
					[`n${i}`]: name,
					[`wo${i}`]: c.open,
					[`oa${i}`]: c.openAfter,
					[`wr${i}`]: c.recent,
					[`ra${i}`]: c.recentAfter,
				});
				declarations.push(
					`$o${i}: String!, $n${i}: String!, $wo${i}: Boolean!, $oa${i}: String, $wr${i}: Boolean!, $ra${i}: String`,
				);
				return `r${i}: repository(owner: $o${i}, name: $n${i}) {
open: pullRequests(states: OPEN, first: 50, after: $oa${i}, orderBy: {field: UPDATED_AT, direction: DESC}) @include(if: $wo${i}) { ${SCAN_PAGE} }
recent: pullRequests(first: 50, after: $ra${i}, orderBy: {field: UPDATED_AT, direction: DESC}) @include(if: $wr${i}) { ${SCAN_PAGE} }
}`;
			});
			const { data } = await graphql<Record<string, ScanRepoNode>>(
				gh,
				`query(${declarations.join(", ")}) { ${selections.join("\n")} }`,
				variables,
			);
			batch.forEach((c, i) => {
				const node = data[`r${i}`];
				const pulls = found.get(c.repo);
				if (!node || !pulls) {
					failed.add(c.repo);
					unreadable.add(c.repo);
					return;
				}
				for (const p of node.open?.nodes ?? []) {
					pulls.set(p.number, { number: p.number, body: p.body });
				}
				const since = c.since;
				const fresh = (node.recent?.nodes ?? []).filter(
					(p) => since === null || p.updatedAt > since,
				);
				for (const p of fresh) {
					pulls.set(p.number, { number: p.number, body: p.body });
				}
				const more: ScanCursor = {
					...c,
					open: Boolean(node.open?.pageInfo.hasNextPage),
					openAfter: node.open?.pageInfo.endCursor ?? null,
					// since より古い PR に届いたら、その先は見ない
					recent:
						since !== null &&
						Boolean(node.recent?.pageInfo.hasNextPage) &&
						fresh.length === (node.recent?.nodes.length ?? 0),
					recentAfter: node.recent?.pageInfo.endCursor ?? null,
				};
				if (more.open || more.recent) next.push(more);
			});
		}
		pending = next;
	}
	const scanned = new Map<string, ScannedPull[]>();
	for (const [repo, pulls] of found) {
		if (!unreadable.has(repo)) scanned.set(repo, [...pulls.values()]);
	}
	return { scanned, failed: [...failed] };
};

/** ラベルを付ける。この入口は、定義の無いラベルを作ってしまうので、定義があると確かめてから呼ぶ */
export const addLabel = async (gh: GitHub, ref: PullRef, label: string) => {
	await request(gh, `/repos/${ref.repo}/issues/${ref.number}/labels`, {
		method: "POST",
		body: JSON.stringify({ labels: [label] }),
	});
};
