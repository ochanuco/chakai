import { and, eq, inArray, isNull, ne, or } from "drizzle-orm";
import type { Principal } from "./auth.ts";
import type { Db } from "./db/client.ts";
import { githubLinks, links, projectRepos, tasks } from "./db/schema.ts";
import { isConflict, writeAll } from "./db/write.ts";
import {
	CHECKS_FALLBACK_PER_SYNC,
	type ChecksBudget,
	fetchPulls,
	type GitHub,
	GitHubError,
	PULLS_PER_QUERY,
	type PullRef,
	pullKey,
	scanRepos,
} from "./github.ts";
import { chunked } from "./history.ts";
import {
	actorLabelOf,
	applyActorLabel,
	deliverableWrites,
	NO_TOKEN_WARNING,
	pullUpdate,
	pullUrl,
} from "./links.ts";
import { completeDelivered } from "./tasks.ts";

/** Cron の同期が動かした書き込みを残す actor。名簿には migration が無効な行として入れる */
export const SYNC_ACTOR_ID = "sync";

export type SyncResult = {
	/** token が無くて同期しなかった */
	skipped: boolean;
	/** 状態を取り込んだ成果物の PR の数 */
	synced: number;
	/** 印から付けたリンク */
	linked: { task_id: string; url: string }[];
	/** done にしたタスクの ID */
	done: string[];
	warnings: string[];
};

// タスクの ID は UUID v7。前後に英数字やハイフンが続くもの（別の語の一部、長い ID の途中）は印と読まない
const MARKER =
	/(?<![0-9a-z_-])chakai:([0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(?![0-9a-z_-])/gi;

export const markedTaskIds = (body: string): string[] => [
	...new Set([...body.matchAll(MARKER)].map((m) => (m[1] ?? "").toLowerCase())),
];

/**
 * プロジェクトに紐付いた repo の PR の本文から印を探し、まだ付いていない成果物のリンクを付ける。
 * 見終えた repo だけ、見始めた時刻を次の同期の起点として残す
 */
const linkMarked = async (
	db: Db,
	gh: GitHub,
	who: Principal,
	result: SyncResult,
	budget: ChecksBudget,
) => {
	const startedAt = new Date().toISOString();
	const rows = await db.select().from(projectRepos);
	const scans = new Map<string, (string | null)[]>();
	const projectsOf = new Map<string, Set<string>>();
	for (const r of rows) {
		scans.set(r.repo, [...(scans.get(r.repo) ?? []), r.scannedAt]);
		projectsOf.set(
			r.repo,
			(projectsOf.get(r.repo) ?? new Set()).add(r.projectId),
		);
	}
	// 同じ repo が複数のプロジェクトにあるときは、古い方の起点から見る。まだ見ていない行があれば 1 ページ目から
	const since = new Map(
		[...scans].map(([repo, times]) => [
			repo,
			times.includes(null) ? null : (times.sort()[0] ?? null),
		]),
	);
	const { scanned, failed } = await scanRepos(
		gh,
		[...since].map(([repo, at]) => ({ repo, since: at })),
	);
	for (const repo of failed) {
		result.warnings.push(`${repo} の PR を読み終えられなかった`);
	}

	const marked: { ref: PullRef; taskId: string }[] = [];
	for (const [repo, pulls] of scanned) {
		for (const pull of pulls) {
			for (const taskId of markedTaskIds(pull.body)) {
				marked.push({ ref: { repo, number: pull.number }, taskId });
			}
		}
	}
	const taskById = new Map<
		string,
		{ id: string; projectId: string; assigneeId: string | null }
	>();
	const linked = new Set<string>();
	for (const ids of chunked([...new Set(marked.map((m) => m.taskId))])) {
		for (const t of await db
			.select({
				id: tasks.id,
				projectId: tasks.projectId,
				assigneeId: tasks.assigneeId,
			})
			.from(tasks)
			.where(inArray(tasks.id, ids))) {
			taskById.set(t.id, t);
		}
		for (const l of await db
			.select({ ownerId: links.ownerId, url: links.url })
			.from(links)
			.where(and(eq(links.ownerType, "task"), inArray(links.ownerId, ids)))) {
			linked.add(`${l.ownerId} ${l.url}`);
		}
	}
	const labels = new Map<string | null, string | null>();
	const fresh: {
		ref: PullRef;
		task: { id: string; projectId: string; assigneeId: string | null };
		label: string | null;
	}[] = [];
	for (const { ref, taskId } of marked) {
		const task = taskById.get(taskId);
		// 印を拾うのは、タスクのプロジェクトに紐付いた repo の PR だけ
		if (!task || !projectsOf.get(ref.repo)?.has(task.projectId)) continue;
		if (linked.has(`${task.id} ${pullUrl(ref)}`)) continue;
		if (!labels.has(task.assigneeId)) {
			labels.set(task.assigneeId, await actorLabelOf(db, task.assigneeId));
		}
		fresh.push({ ref, task, label: labels.get(task.assigneeId) ?? null });
	}
	const pulls = await fetchPulls(
		gh,
		fresh.map((f) => ({ ...f.ref, ...(f.label ? { label: f.label } : {}) })),
		budget,
	);
	for (const [i, { ref, task, label }] of fresh.entries()) {
		const pull = pulls[i];
		if (!pull) continue;
		const at = new Date().toISOString();
		const { link, statements } = await deliverableWrites(
			db,
			who,
			at,
			task,
			ref,
			pull,
			{ title: "", note: "" },
		);
		try {
			await writeAll(db, statements);
		} catch (e) {
			// 別の同期や add_link が、読んでから書くまでの間に同じリンクを付けた。もう付いている
			if (!isConflict(e)) throw e;
			continue;
		}
		result.linked.push({ task_id: task.id, url: link.url });
		if (label) {
			const skipped = await applyActorLabel(gh, pull, label);
			if (skipped) result.warnings.push(skipped);
		}
	}

	const finished = [...scanned.keys()].filter((r) => !failed.includes(r));
	for (const repos of chunked(finished)) {
		await db
			.update(projectRepos)
			.set({ scannedAt: startedAt })
			.where(inArray(projectRepos.repo, repos));
	}
};

/** merge された PR はもう変わらないので、それ以外の成果物の状態を取り込み直す */
const refreshPulls = async (
	db: Db,
	gh: GitHub,
	_who: Principal,
	result: SyncResult,
	budget: ChecksBudget,
) => {
	const rows = await db
		.select({
			linkId: githubLinks.linkId,
			repo: githubLinks.repo,
			number: githubLinks.number,
		})
		.from(githubLinks)
		.where(or(isNull(githubLinks.state), ne(githubLinks.state, "merged")));
	const unique = new Map<string, PullRef>();
	for (const r of rows) unique.set(pullKey(r), r);
	// CI を REST で読める本数に上限があるので、毎回同じ PR が枠を使い切らないよう、読み始める位置を 1 時間ごとにずらす
	const all = [...unique.values()];
	const start =
		all.length &&
		(Math.floor(Date.now() / 3_600_000) * CHECKS_FALLBACK_PER_SYNC) %
			all.length;
	const refs = [...all.slice(start), ...all.slice(0, start)];
	const pulls = new Map<string, Awaited<ReturnType<typeof fetchPulls>>[0]>();
	for (const batch of chunked(refs, PULLS_PER_QUERY)) {
		try {
			const fetched = await fetchPulls(gh, batch, budget);
			for (const [i, ref] of batch.entries()) {
				pulls.set(pullKey(ref), fetched[i] ?? null);
			}
		} catch (e) {
			if (!(e instanceof GitHubError)) throw e;
			result.warnings.push(e.message);
		}
	}
	const at = new Date().toISOString();
	const updates = rows.flatMap((r) => {
		const pull = pulls.get(pullKey(r));
		return pull ? [pullUpdate(db, r.linkId, pull, at)] : [];
	});
	for (const [key, pull] of pulls) {
		if (!pull) result.warnings.push(`${key} を読めなかった`);
	}
	for (const batch of chunked(updates, 50)) await writeAll(db, batch);
	result.synced = updates.length;
};

/**
 * GitHub との同期。印からリンクを付け、成果物の PR の状態を取り込み、条件を満たしたタスクを done にする。
 * GitHub を読めなかった段は警告にして先へ進む（取り込み済みの状態で done の規則を当てる）。
 * caller は手で同期を呼んだ人で、書き込みはその人の操作として残る。Cron は null を渡し、sync の actor で残る
 */
export const runSync = async (
	db: Db,
	github: GitHub | null,
	caller: Principal | null,
): Promise<SyncResult> => {
	const result: SyncResult = {
		skipped: false,
		synced: 0,
		linked: [],
		done: [],
		warnings: [],
	};
	if (!github) {
		return { ...result, skipped: true, warnings: [NO_TOKEN_WARNING] };
	}
	const who = caller ?? { actorId: SYNC_ACTOR_ID, callerId: null };
	const budget = { remaining: CHECKS_FALLBACK_PER_SYNC };
	for (const step of [linkMarked, refreshPulls]) {
		try {
			await step(db, github, who, result, budget);
		} catch (e) {
			if (!(e instanceof GitHubError)) throw e;
			result.warnings.push(e.message);
		}
	}
	result.done = await completeDelivered(db, who);
	return result;
};
