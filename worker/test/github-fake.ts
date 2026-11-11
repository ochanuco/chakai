export type FakePull = {
	title: string;
	body: string;
	state: "OPEN" | "CLOSED" | "MERGED";
	isDraft: boolean;
	baseRefName: string;
	headRefOid: string;
	updatedAt: string;
	reviewDecision: string | null;
	reviews: string[];
	/** null は、statusCheckRollup を読めない（fine-grained PAT に Checks の権限が無い） */
	rollup: string | null;
	labels: string[];
	/** null は、消えたアカウント */
	author: string | null;
	/** fork からの PR */
	fork: boolean;
};

type FakeRun = {
	workflow_id: number;
	status: string;
	conclusion: string | null;
	created_at: string;
};

type FakeRepo = {
	defaultBranch: string;
	labels: Set<string>;
	pulls: Map<number, FakePull>;
	/** head の commit ごとの workflow run と commit status。無ければ REST は 403 を返す */
	runs: Map<string, FakeRun[]>;
	statuses: Map<string, { state: string; total_count: number }>;
};

export const TOKEN = "test-token";
/** token のアカウント */
export const VIEWER = "chakai-bot";

/**
 * GitHub の代わりに答える。答えの形は、本物の GraphQL と REST の応答に合わせてある
 * （読めない repo や PR は data が null になり、errors に別名が載る）
 */
export class FakeGitHub {
	repos = new Map<string, FakeRepo>();
	calls: string[] = [];
	/** 入れると、どの呼び出しにもこの status を返す */
	down: number | null = null;
	/** token に PR へラベルを付ける権限が無い */
	labelForbidden = false;
	/** PR の一覧だけが null と errors で返る repo */
	brokenLists = new Set<string>();
	/** 入れると、fetch が例外を投げる（接続できない） */
	unreachable = false;
	/** 入れると、JSON でない 200 を返す */
	garbage = false;
	/** PR を番号で読む問い合わせが来たときに、答える前に 1 度だけ呼ぶ。同期の途中に他の書き込みを挟むため */
	beforePulls: (() => Promise<void>) | null = null;
	/** 同時に答えを待っていた REST の GET の、最大の数 */
	maxInFlight = 0;
	private inFlight = 0;

	repo(name: string, defaultBranch = "main") {
		const repo: FakeRepo = {
			defaultBranch,
			labels: new Set(),
			pulls: new Map(),
			runs: new Map(),
			statuses: new Map(),
		};
		this.repos.set(name, repo);
		return repo;
	}

	pull(repo: string, number: number, patch: Partial<FakePull> = {}) {
		const target = this.repos.get(repo) ?? this.repo(repo);
		const pull: FakePull = {
			title: `pull-${number}`,
			body: "",
			state: "OPEN",
			isDraft: false,
			baseRefName: target.defaultBranch,
			headRefOid: `sha-${number}`,
			updatedAt: new Date().toISOString(),
			reviewDecision: null,
			reviews: [],
			rollup: "SUCCESS",
			labels: [],
			author: repo.split("/")[0] ?? null,
			fork: false,
			...target.pulls.get(number),
			...patch,
		};
		target.pulls.set(number, pull);
		return pull;
	}

	count(prefix: string) {
		return this.calls.filter((c) => c.startsWith(prefix)).length;
	}

	fetch: typeof fetch = async (input, init) => {
		const url = new URL(String(input));
		const method = init?.method ?? "GET";
		const headers = new Headers(init?.headers);
		this.calls.push(`${method} ${url.pathname}`);
		if (headers.get("authorization") !== `Bearer ${TOKEN}`) {
			return Response.json({ message: "Bad credentials" }, { status: 401 });
		}
		if (this.unreachable) throw new TypeError("Network connection lost");
		if (this.garbage) return new Response("<html>oops</html>");
		if (this.down !== null) {
			return Response.json({ message: "down" }, { status: this.down });
		}
		if (method === "POST" && url.pathname === "/graphql") {
			const body = JSON.parse(String(init?.body));
			if (this.beforePulls && body.variables.k0 !== undefined) {
				const hook = this.beforePulls;
				this.beforePulls = null;
				await hook();
			}
			return this.graphql(body);
		}
		if (method === "GET") {
			this.maxInFlight = Math.max(this.maxInFlight, ++this.inFlight);
			await new Promise((resolve) => setTimeout(resolve, 1));
			this.inFlight--;
		}
		const [, owner, name, ...rest] = url.pathname.split("/").slice(1);
		const repo = this.repos.get(`${owner}/${name}`);
		if (!repo) return Response.json({ message: "Not Found" }, { status: 404 });
		if (method === "GET" && rest.join("/") === "actions/runs") {
			const runs = repo.runs.get(url.searchParams.get("head_sha") ?? "");
			return runs
				? Response.json({ total_count: runs.length, workflow_runs: runs })
				: Response.json({ message: "Forbidden" }, { status: 403 });
		}
		if (method === "GET" && rest[0] === "commits" && rest[2] === "status") {
			const status = repo.statuses.get(rest[1] ?? "");
			return status
				? Response.json(status)
				: Response.json({ message: "Forbidden" }, { status: 403 });
		}
		if (method === "POST" && rest[0] === "issues" && rest[2] === "labels") {
			if (this.labelForbidden) {
				return Response.json(
					{ message: "Resource not accessible by personal access token" },
					{ status: 403 },
				);
			}
			const pull = repo.pulls.get(Number(rest[1]));
			if (!pull)
				return Response.json({ message: "Not Found" }, { status: 404 });
			const { labels } = JSON.parse(String(init?.body)) as { labels: string[] };
			for (const label of labels) {
				// 本物も、定義の無いラベルを作ってから付ける
				repo.labels.add(label);
				if (!pull.labels.includes(label)) pull.labels.push(label);
			}
			return Response.json(pull.labels.map((l) => ({ name: l })));
		}
		return Response.json({ message: "Not Found" }, { status: 404 });
	};

	private graphql(body: { query: string; variables: Record<string, unknown> }) {
		const { query, variables: v } = body;
		const data: Record<string, unknown> = query.includes("viewer { login }")
			? { viewer: { login: VIEWER } }
			: {};
		const errors: { type: string; path: string[]; message: string }[] = [];
		for (let i = 0; v[`o${i}`] !== undefined; i++) {
			const name = `${v[`o${i}`]}/${v[`n${i}`]}`;
			const repo = this.repos.get(name);
			const isPull = v[`k${i}`] !== undefined;
			const alias = `${isPull ? "p" : "r"}${i}`;
			if (
				!query.includes(`${alias}: repository(owner: $o${i}, name: $n${i})`)
			) {
				throw new Error(`問い合わせに ${alias} が無い`);
			}
			if (!repo) {
				data[alias] = null;
				errors.push({
					type: "NOT_FOUND",
					path: [alias],
					message: `Could not resolve to a Repository with the name '${name}'.`,
				});
				continue;
			}
			if (!isPull && this.brokenLists.has(name)) {
				data[alias] = { open: null, recent: null };
				errors.push({
					type: "FORBIDDEN",
					path: [alias, "open"],
					message: "Resource not accessible by personal access token",
				});
				continue;
			}
			if (!isPull) {
				data[alias] = this.scan(repo, v, i);
				continue;
			}
			const pull = repo.pulls.get(Number(v[`k${i}`]));
			if (!pull) {
				errors.push({
					type: "NOT_FOUND",
					path: [alias, "pullRequest"],
					message: "Could not resolve to a PullRequest",
				});
			}
			const label = v[`l${i}`];
			data[alias] = {
				defaultBranchRef: { name: repo.defaultBranch },
				...(typeof label === "string"
					? { label: repo.labels.has(label) ? { name: label } : null }
					: {}),
				pullRequest: pull
					? {
							number: Number(v[`k${i}`]),
							title: pull.title,
							state: pull.state,
							isDraft: pull.isDraft,
							baseRefName: pull.baseRefName,
							headRefOid: pull.headRefOid,
							reviewDecision: pull.reviewDecision,
							latestOpinionatedReviews: {
								nodes: pull.reviews.map((state) => ({ state })),
							},
							labels: { nodes: pull.labels.map((l) => ({ name: l })) },
							commits: {
								nodes: [
									{
										commit: {
											statusCheckRollup: pull.rollup
												? { state: pull.rollup }
												: null,
										},
									},
								],
							},
						}
					: null,
			};
		}
		return Response.json(errors.length > 0 ? { data, errors } : { data });
	}

	private scan(repo: FakeRepo, v: Record<string, unknown>, i: number) {
		const all = [...repo.pulls]
			.map(([number, p]) => ({ number, ...p }))
			.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
		const page = (pulls: typeof all, after: unknown) => {
			const start = typeof after === "string" ? Number(after) : 0;
			const nodes = pulls.slice(start, start + 50);
			return {
				pageInfo: {
					hasNextPage: start + 50 < pulls.length,
					endCursor: nodes.length > 0 ? String(start + nodes.length) : null,
				},
				nodes: nodes.map((p) => ({
					number: p.number,
					body: p.body,
					updatedAt: p.updatedAt,
					isCrossRepository: p.fork,
					author: p.author === null ? null : { login: p.author },
				})),
			};
		};
		return {
			...(v[`wo${i}`]
				? {
						open: page(
							all.filter((p) => p.state === "OPEN"),
							v[`oa${i}`],
						),
					}
				: {}),
			...(v[`wr${i}`] ? { recent: page(all, v[`ra${i}`]) } : {}),
		};
	}
}
