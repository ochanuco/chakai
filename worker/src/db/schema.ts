import {
	index,
	integer,
	primaryKey,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";

// system は同期のような仕組みの actor。名乗ることも担当にすることもできないよう、名簿では無効にして持つ
export const ACTOR_KINDS = ["human", "agent", "system"] as const;
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
		// 印を探す同期が、この repo の PR を最後に見終えた時刻。次の同期は、これより後に更新された PR を見る
		scannedAt: text("scanned_at"),
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

export const LINK_OWNER_TYPES = ["task", "project"] as const;
export type LinkOwnerType = (typeof LINK_OWNER_TYPES)[number];
export const LINK_ROLES = ["deliverable", "reference"] as const;
export type LinkRole = (typeof LINK_ROLES)[number];
export const LINK_KINDS = [
	"github_pr",
	"github_issue",
	"notion",
	"x",
	"url",
] as const;
export type LinkKind = (typeof LINK_KINDS)[number];

// owner_id はタスクかプロジェクトの ID。どちらを指すかは owner_type で決まるので、外部キーにしない
export const links = sqliteTable(
	"links",
	{
		id: text("id").primaryKey(),
		ownerType: text("owner_type", { enum: LINK_OWNER_TYPES }).notNull(),
		ownerId: text("owner_id").notNull(),
		role: text("role", { enum: LINK_ROLES }).notNull(),
		kind: text("kind", { enum: LINK_KINDS }).notNull(),
		url: text("url").notNull(),
		title: text("title").notNull().default(""),
		note: text("note").notNull().default(""),
		linkedBy: text("linked_by")
			.notNull()
			.references(() => actors.id),
		createdAt: text("created_at").notNull(),
	},
	(t) => [uniqueIndex("links_owner_url").on(t.ownerType, t.ownerId, t.url)],
);

export const PULL_STATES = ["open", "closed", "merged"] as const;
export type PullState = (typeof PULL_STATES)[number];
export const PULL_REVIEWS = [
	"approved",
	"changes_requested",
	"review_required",
	"none",
] as const;
export type PullReview = (typeof PULL_REVIEWS)[number];
export const PULL_CHECKS = ["success", "failure", "pending", "none"] as const;
export type PullChecks = (typeof PULL_CHECKS)[number];

// 成果物の PR の、GitHub から取り込んだ状態。同期のたびに上書きし、events には残さない。
// まだ取り込めていない列は null（checks の null は、CI の結果を読めなかったことも表す）
export const githubLinks = sqliteTable(
	"github_links",
	{
		linkId: text("link_id")
			.primaryKey()
			.references(() => links.id),
		repo: text("repo").notNull(),
		number: integer("number").notNull(),
		baseBranch: text("base_branch"),
		draft: integer("draft", { mode: "boolean" }),
		state: text("state", { enum: PULL_STATES }),
		mergedIntoDefault: integer("merged_into_default", { mode: "boolean" }),
		review: text("review", { enum: PULL_REVIEWS }),
		checks: text("checks", { enum: PULL_CHECKS }),
		syncedAt: text("synced_at"),
	},
	(t) => [index("github_links_pull").on(t.repo, t.number)],
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
