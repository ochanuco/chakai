import { asc, eq } from "drizzle-orm";
import type { Principal } from "./auth.ts";
import type { Db } from "./db/client.ts";
import { projectRepos, projects } from "./db/schema.ts";
import { retryOnConflict, writeAll } from "./db/write.ts";
import { eventInserts } from "./events.ts";
import { newId } from "./id.ts";
import { type Link, linksOf } from "./links.ts";
import { fail, ok, type Result } from "./result.ts";

export type Project = {
	id: string;
	name: string;
	description: string;
	created_by: string;
	created_at: string;
	repos: string[];
};

export type ProjectWithLinks = Project & { links: Link[] };

const toProject = (
	row: typeof projects.$inferSelect,
	repos: string[],
): Project => ({
	id: row.id,
	name: row.name,
	description: row.description,
	created_by: row.createdBy,
	created_at: row.createdAt,
	repos,
});

export const listProjects = async (db: Db): Promise<ProjectWithLinks[]> => {
	const rows = await db.select().from(projects).orderBy(asc(projects.id));
	const repos = await db
		.select()
		.from(projectRepos)
		.orderBy(asc(projectRepos.repo));
	const linked = await linksOf(
		db,
		"project",
		rows.map((r) => r.id),
	);
	return rows.map((row) => ({
		...toProject(
			row,
			repos.filter((r) => r.projectId === row.id).map((r) => r.repo),
		),
		links: linked.get(row.id) ?? [],
	}));
};

export const createProject = async (
	db: Db,
	who: Principal,
	input: { name: string; description: string },
): Promise<Project> => {
	const row = {
		id: newId(),
		name: input.name,
		description: input.description,
		createdBy: who.actorId,
		createdAt: new Date().toISOString(),
	};
	const project = toProject(row, []);
	await writeAll(db, [
		db.insert(projects).values(row),
		...eventInserts(db, who, row.createdAt, [
			{
				entity: "project",
				entityId: row.id,
				field: "created",
				after: project,
			},
		]),
	]);
	return project;
};

export const linkRepo = async (
	db: Db,
	who: Principal,
	projectId: string,
	repo: string,
): Promise<Result<Project>> => {
	const [row] = await db
		.select()
		.from(projects)
		.where(eq(projects.id, projectId))
		.limit(1);
	if (!row) return fail(404, "project_not_found", "プロジェクトが無い");
	const linked = async () =>
		(
			await db
				.select()
				.from(projectRepos)
				.where(eq(projectRepos.projectId, projectId))
				.orderBy(asc(projectRepos.repo))
		).map((r) => r.repo);
	const link = async () => {
		const before = await linked();
		if (before.includes(repo)) return before;
		await writeAll(db, [
			db.insert(projectRepos).values({ projectId, repo }),
			...eventInserts(db, who, new Date().toISOString(), [
				{
					entity: "project",
					entityId: projectId,
					field: "repos",
					after: repo,
				},
			]),
		]);
		return linked();
	};
	// 同じ repo を同時に紐付けると片方が一意制約で弾かれる。読み直せば、もう紐付いている
	return ok(toProject(row, await retryOnConflict(link, linked)));
};

/**
 * どのプロジェクトにも紐付いていない repo を、repo 名のプロジェクトを作って紐付ける。
 * 同じ名前で repo の無いプロジェクトがあれば、作らずにそこへ紐付ける
 */
export const adoptRepos = async (
	db: Db,
	who: Principal,
	repos: string[],
): Promise<void> => {
	const linkedRows = await db.select().from(projectRepos);
	const linked = new Set(linkedRows.map((r) => r.repo.toLowerCase()));
	const withRepos = new Set(linkedRows.map((r) => r.projectId));
	const vacant = new Map<string, typeof projects.$inferSelect>();
	for (const p of await db.select().from(projects).orderBy(asc(projects.id))) {
		const key = p.name.toLowerCase();
		if (!withRepos.has(p.id) && !vacant.has(key)) vacant.set(key, p);
	}
	for (const repo of repos) {
		if (linked.has(repo.toLowerCase())) continue;
		const name = repo.split("/")[1] ?? repo;
		const at = new Date().toISOString();
		const existing = vacant.get(name.toLowerCase());
		const row = existing ?? {
			id: newId(),
			name,
			description: "",
			createdBy: who.actorId,
			createdAt: at,
		};
		// プロジェクトは消せないので、作るのと紐付けるのを 1 つの batch にし、repo の無いプロジェクトを残さない
		await writeAll(db, [
			...(existing ? [] : [db.insert(projects).values(row)]),
			db.insert(projectRepos).values({ projectId: row.id, repo }),
			...eventInserts(db, who, at, [
				...(existing
					? []
					: [
							{
								entity: "project" as const,
								entityId: row.id,
								field: "created",
								after: toProject(row, []),
							},
						]),
				{ entity: "project", entityId: row.id, field: "repos", after: repo },
			]),
		]);
		vacant.delete(name.toLowerCase());
		linked.add(repo.toLowerCase());
	}
};

export const projectExists = async (db: Db, id: string) =>
	(
		await db
			.select({ id: projects.id })
			.from(projects)
			.where(eq(projects.id, id))
			.limit(1)
	).length > 0;
