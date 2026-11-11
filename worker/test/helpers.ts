import { env } from "cloudflare:workers";
import { generateKeyPair, SignJWT } from "jose";
import { createApp } from "../src/index.ts";

export const BASE = "https://chakai.example.com";

const pair = await generateKeyPair("RS256");
const stranger = await generateKeyPair("RS256");
const app = createApp({ keys: async () => pair.publicKey });

export const OWNER_EMAIL = "owner@example.com";
export const MAC = { id: "caller-mac", clientId: "mac-example.access" };
export const WORKING = {
	id: "caller-working",
	clientId: "working-example.access",
};

/** 架空の名簿。Mac は既定で owner、Working は必ず名乗る */
export const seedRoster = () =>
	env.DB.batch([
		env.DB.prepare(
			`INSERT OR IGNORE INTO actors (id, kind, role, display_name, runtime, email, active) VALUES
				('owner', 'human', 'owner', 'Owner', NULL, '${OWNER_EMAIL}', 1),
				('yukarin', 'agent', 'member', 'Yukarin', 'claude-cli', NULL, 1),
				('akarin', 'agent', 'member', 'Akarin', 'codex-cli', NULL, 1),
				('retired', 'agent', 'member', 'Retired', NULL, NULL, 0),
				('left', 'human', 'member', 'Left', NULL, 'left@example.com', 0)`,
		),
		env.DB.prepare(
			`INSERT OR IGNORE INTO callers (id, access_client_id, name, default_actor_id) VALUES
				('${MAC.id}', '${MAC.clientId}', 'mac-agent', 'owner'),
				('${WORKING.id}', '${WORKING.clientId}', 'working', NULL)`,
		),
		env.DB.prepare(
			`INSERT OR IGNORE INTO caller_actors (caller_id, actor_id) VALUES
				('${MAC.id}', 'owner'),
				('${WORKING.id}', 'yukarin'),
				('${WORKING.id}', 'akarin'),
				('${WORKING.id}', 'retired')`,
		),
	]);

type SignOptions = {
	key?: CryptoKey;
	aud?: string;
	iss?: string;
	exp?: string;
};

export const sign = (claims: Record<string, unknown>, opts: SignOptions = {}) =>
	new SignJWT(claims)
		.setProtectedHeader({ alg: "RS256", kid: "k1" })
		.setIssuer(opts.iss ?? `https://${env.ACCESS_TEAM_DOMAIN}`)
		.setAudience(opts.aud ?? env.ACCESS_AUD)
		.setIssuedAt()
		.setExpirationTime(opts.exp ?? "5m")
		.sign(opts.key ?? pair.privateKey);

export const strangerKey = stranger.privateKey;

export type As = {
	token?: string;
	email?: string;
	clientId?: string;
	actor?: string;
};

export const owner: As = { email: OWNER_EMAIL };
export const mac: As = { clientId: MAC.clientId };
export const working = (actor: string): As => ({
	clientId: WORKING.clientId,
	actor,
});

type App = ReturnType<typeof createApp>;

/** GitHub の代わりに答える fetch と token を持たせた入口。token を渡さなければ、token の無い Worker になる */
export const appWithGitHub = (fetcher: typeof fetch, token?: string) => {
	const custom = createApp({
		keys: async () => pair.publicKey,
		fetch: fetcher,
	});
	const environment = { ...env, GITHUB_TOKEN: token };
	return { app: custom, env: environment, call: caller(custom, environment) };
};

const caller =
	(target: App, environment: Env) =>
	async (
		as: As | null,
		method: string,
		path: string,
		body?: unknown,
		headers: Record<string, string | null> = {},
		rawBody?: string,
	) => {
		// 既定は実際の呼び出し元に合わせる。ブラウザ（email のログイン）は書き込みに Origin を付ける。
		// null を渡したヘッダーは付けない
		const all: Record<string, string> = {};
		const defaults: Record<string, string | null> = {
			"content-type": method === "GET" ? null : "application/json",
			origin: as?.email && method !== "GET" ? BASE : null,
		};
		for (const [name, value] of Object.entries({ ...defaults, ...headers })) {
			if (value !== null) all[name.toLowerCase()] = value;
		}
		if (as) {
			all["Cf-Access-Jwt-Assertion"] =
				as.token ??
				(await sign(
					as.email ? { email: as.email } : { common_name: as.clientId },
				));
			if (as.actor) all["X-Actor"] = as.actor;
		}
		return target.fetch(
			new Request(`${BASE}${path}`, {
				method,
				headers: all,
				body:
					rawBody ?? (body === undefined ? undefined : JSON.stringify(body)),
			}),
			environment,
		);
	};

export const call = caller(app, env);

export type TaskJson = {
	id: string;
	project_id: string;
	parent_id: string | null;
	title: string;
	state: string;
	assignee_id: string | null;
	order_key: string;
	waiting_on: string | null;
	created_by: string;
	triaged_at: string | null;
	labels: string[];
};

export type RelationJson = {
	from_task: string;
	kind: string;
	to_task: string;
	run_id: string | null;
	created_by: string;
};

let seq = 0;

export const newProject = async (as: As = owner) => {
	const res = await call(as, "POST", "/v1/projects", {
		name: `project-${++seq}`,
	});
	if (res.status !== 201) throw new Error(`project: ${res.status}`);
	return res.json<{ id: string; repos: string[] }>();
};

export const newTask = async (
	projectId: string,
	input: Record<string, unknown> = {},
	as: As = owner,
) => {
	const res = await call(as, "POST", "/v1/tasks", {
		project_id: projectId,
		title: `task-${++seq}`,
		...input,
	});
	if (res.status !== 201) throw new Error(`task: ${res.status}`);
	return res.json<TaskJson>();
};

export type EventRow = {
	entity: string;
	entity_id: string;
	actor_id: string;
	caller_id: string | null;
	field: string;
	before: string | null;
	after: string | null;
};

export const eventsOf = async (entityId: string) =>
	(
		await env.DB.prepare(
			"SELECT entity, entity_id, actor_id, caller_id, field, before, after FROM events WHERE entity_id = ? ORDER BY id",
		)
			.bind(entityId)
			.all<EventRow>()
	).results;
