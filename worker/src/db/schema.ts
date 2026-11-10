import {
	index,
	integer,
	primaryKey,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const ACTOR_KINDS = ["human", "agent"] as const;
export const ACTOR_ROLES = ["owner", "member"] as const;
export const TASK_STATES = [
	"backlog",
	"todo",
	"doing",
	"review",
	"done",
	"dropped",
] as const;
export type TaskState = (typeof TASK_STATES)[number];

// id は名簿の名前（owner、yukarin など）。X-Actor で名乗る値になるので、ここだけ UUID にしない
export const actors = sqliteTable("actors", {
	id: text("id").primaryKey(),
	kind: text("kind", { enum: ACTOR_KINDS }).notNull(),
	role: text("role", { enum: ACTOR_ROLES }).notNull(),
	displayName: text("display_name").notNull(),
	runtime: text("runtime"),
	email: text("email").unique(),
	active: integer("active", { mode: "boolean" }).notNull().default(true),
});

export const actorExternalIds = sqliteTable(
	"actor_external_ids",
	{
		actorId: text("actor_id")
			.notNull()
			.references(() => actors.id),
		provider: text("provider").notNull(),
		externalId: text("external_id").notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.actorId, t.provider] }),
		uniqueIndex("actor_external_ids_external").on(t.provider, t.externalId),
	],
);

export const callers = sqliteTable("callers", {
	id: text("id").primaryKey(),
	accessClientId: text("access_client_id").notNull().unique(),
	name: text("name").notNull(),
	defaultActorId: text("default_actor_id").references(() => actors.id),
});

export const callerActors = sqliteTable(
	"caller_actors",
	{
		callerId: text("caller_id")
			.notNull()
			.references(() => callers.id),
		actorId: text("actor_id")
			.notNull()
			.references(() => actors.id),
	},
	(t) => [primaryKey({ columns: [t.callerId, t.actorId] })],
);

export const projects = sqliteTable("projects", {
	id: text("id").primaryKey(),
	name: text("name").notNull(),
	description: text("description").notNull().default(""),
	createdBy: text("created_by")
		.notNull()
		.references(() => actors.id),
	createdAt: text("created_at").notNull(),
});

export const projectRepos = sqliteTable(
	"project_repos",
	{
		projectId: text("project_id")
			.notNull()
			.references(() => projects.id),
		repo: text("repo").notNull(),
	},
	(t) => [primaryKey({ columns: [t.projectId, t.repo] })],
);

export const tasks = sqliteTable(
	"tasks",
	{
		id: text("id").primaryKey(),
		projectId: text("project_id")
			.notNull()
			.references(() => projects.id),
		parentId: text("parent_id"),
		title: text("title").notNull(),
		body: text("body").notNull().default(""),
		state: text("state", { enum: TASK_STATES }).notNull().default("backlog"),
		assigneeId: text("assignee_id").references(() => actors.id),
		orderKey: text("order_key").notNull(),
		waitingOn: text("waiting_on"),
		// 更新のたびに 1 ずつ増える。同時の更新を見つけるために使う（migration の trigger）
		revision: integer("revision").notNull().default(0),
		createdBy: text("created_by")
			.notNull()
			.references(() => actors.id),
		createdAt: text("created_at").notNull(),
		updatedAt: text("updated_at").notNull(),
		triagedAt: text("triaged_at"),
	},
	(t) => [
		uniqueIndex("tasks_project_order").on(t.projectId, t.orderKey),
		index("tasks_parent").on(t.parentId),
		index("tasks_state").on(t.state),
	],
);

export const labels = sqliteTable("labels", {
	id: text("id").primaryKey(),
	name: text("name").notNull().unique(),
});

export const taskLabels = sqliteTable(
	"task_labels",
	{
		taskId: text("task_id")
			.notNull()
			.references(() => tasks.id),
		labelId: text("label_id")
			.notNull()
			.references(() => labels.id),
	},
	(t) => [primaryKey({ columns: [t.taskId, t.labelId] })],
);

export const runs = sqliteTable(
	"runs",
	{
		id: text("id").primaryKey(),
		taskId: text("task_id")
			.notNull()
			.references(() => tasks.id),
		actorId: text("actor_id")
			.notNull()
			.references(() => actors.id),
		seat: text("seat").notNull(),
		model: text("model"),
		hishakuNo: integer("hishaku_no"),
		startedAt: text("started_at").notNull(),
		endedAt: text("ended_at"),
	},
	(t) => [index("runs_task").on(t.taskId)],
);

export const RELATION_KINDS = [
	"discovered_from",
	"follows",
	"replaced_by",
] as const;
export type RelationKind = (typeof RELATION_KINDS)[number];

// 「from_task が kind で to_task」と読む。discovered_from と follows は新しいタスクから元のタスクへ、
// replaced_by は古いタスクから新しいタスクへ向く
export const taskRelations = sqliteTable(
	"task_relations",
	{
		fromTask: text("from_task")
			.notNull()
			.references(() => tasks.id),
		kind: text("kind", { enum: RELATION_KINDS }).notNull(),
		toTask: text("to_task")
			.notNull()
			.references(() => tasks.id),
		runId: text("run_id").references(() => runs.id),
		createdBy: text("created_by")
			.notNull()
			.references(() => actors.id),
		createdAt: text("created_at").notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.fromTask, t.kind, t.toTask] }),
		index("task_relations_to").on(t.toTask),
	],
);

// scope は global かプロジェクトの ID。value は JSON で、上の scope に戻した行は null を持つ。
// 行を消すと revision で同時の書き込みを見つけられなくなるので、消さない
export const settings = sqliteTable(
	"settings",
	{
		scope: text("scope").notNull(),
		key: text("key").notNull(),
		value: text("value").notNull(),
		// 更新のたびに 1 ずつ増える。同時の更新を見つけるために使う（migration の trigger）
		revision: integer("revision").notNull().default(0),
	},
	(t) => [primaryKey({ columns: [t.scope, t.key] })],
);

export const events = sqliteTable(
	"events",
	{
		id: text("id").primaryKey(),
		entity: text("entity").notNull(),
		entityId: text("entity_id").notNull(),
		actorId: text("actor_id")
			.notNull()
			.references(() => actors.id),
		callerId: text("caller_id").references(() => callers.id),
		at: text("at").notNull(),
		field: text("field").notNull(),
		before: text("before"),
		after: text("after"),
	},
	(t) => [index("events_entity").on(t.entity, t.entityId, t.id)],
);
