import { asc, eq } from "drizzle-orm";
import type { Principal } from "./auth.ts";
import type { Db } from "./db/client.ts";
import { events as eventsTable, projectRepos, projects } from "./db/schema.ts";
import { writeAll } from "./db/write.ts";
import { eventRows } from "./events.ts";
import { newId } from "./id.ts";
import { fail, ok, type Result } from "./result.ts";

export type Project = {
	id: string;
	name: string;
	description: string;
	created_by: string;
	created_at: string;
	repos: string[];
};

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

export const listProjects = async (db: Db): Promise<Project[]> => {
	const rows = await db.select().from(projects).orderBy(asc(projects.id));
	const repos = await db
		.select()
		.from(projectRepos)
		.orderBy(asc(projectRepos.repo));
	return rows.map((row) =>
		toProject(
			row,
			repos.filter((r) => r.projectId === row.id).map((r) => r.repo),
		),
	);
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
		db.insert(eventsTable).values(
			eventRows(who, row.createdAt, [
				{
					entity: "project",
					entityId: row.id,
					field: "created",
					after: project,
				},
			]),
		),
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
	const before = await linked();
	if (before.includes(repo)) return ok(toProject(row, before));
	await writeAll(db, [
		db.insert(projectRepos).values({ projectId, repo }),
		db.insert(eventsTable).values(
			eventRows(who, new Date().toISOString(), [
				{
					entity: "project",
					entityId: projectId,
					field: "repos",
					after: repo,
				},
			]),
		),
	]);
	return ok(toProject(row, await linked()));
};

export const projectExists = async (db: Db, id: string) =>
	(
		await db
			.select({ id: projects.id })
			.from(projects)
			.where(eq(projects.id, id))
			.limit(1)
	).length > 0;
