import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import {
	type CallerInput,
	callerStatements,
} from "../scripts/roster-caller-sql.ts";
import { call, eventsOf, seedRoster } from "./helpers.ts";

beforeAll(seedRoster);

const CLIENT_ID = `${"0123456789abcdef".repeat(2)}.access`;
const input: CallerInput = {
	name: "example-working",
	clientId: CLIENT_ID,
	actors: "yukarin:claude-cli,hikari:codex-cli",
	defaultActor: "",
};

const run = async (i: CallerInput) => {
	const built = callerStatements(i, new Date().toISOString());
	if (!built.ok) throw new Error(built.error);
	await env.DB.batch(built.statements.map((s) => env.DB.prepare(s)));
};

const callerRow = (clientId: string) =>
	env.DB.prepare(
		"SELECT id, name, default_actor_id FROM callers WHERE access_client_id = ?",
	)
		.bind(clientId)
		.first<{ id: string; name: string; default_actor_id: string | null }>();

const allowed = async (callerId: string) =>
	(
		await env.DB.prepare(
			"SELECT actor_id FROM caller_actors WHERE caller_id = ? ORDER BY actor_id",
		)
			.bind(callerId)
			.all<{ actor_id: string }>()
	).results.map((r) => r.actor_id);

const actorRow = (id: string) =>
	env.DB.prepare(
		"SELECT kind, role, display_name, runtime, active FROM actors WHERE id = ?",
	)
		.bind(id)
		.first();

describe("呼び出し元を名簿に足す", () => {
	it("呼び出し元と、無い actor と、名乗りの許可を足し、すべて events に残す", async () => {
		await run(input);
		const caller = await callerRow(CLIENT_ID);
		expect(caller).toMatchObject({
			name: "example-working",
			default_actor_id: null,
		});
		const id = caller?.id ?? "";
		expect(await allowed(id)).toEqual(["hikari", "yukarin"]);
		expect(await actorRow("hikari")).toEqual({
			kind: "agent",
			role: "member",
			display_name: "hikari",
			runtime: "codex-cli",
			active: 1,
		});
		// もう居る actor の行は変えず、作ったとも残さない
		expect(await actorRow("yukarin")).toMatchObject({
			display_name: "Yukarin",
		});
		expect(await eventsOf("yukarin")).toEqual([]);

		expect(await eventsOf("hikari")).toEqual([
			{
				entity: "actor",
				entity_id: "hikari",
				actor_id: "owner",
				caller_id: null,
				field: "created",
				before: null,
				after: JSON.stringify({
					id: "hikari",
					kind: "agent",
					role: "member",
					runtime: "codex-cli",
				}),
			},
		]);
		const events = await eventsOf(id);
		expect(events.map((e) => [e.entity, e.field, e.after])).toEqual([
			[
				"caller",
				"created",
				JSON.stringify({ name: "example-working", default_actor_id: null }),
			],
			["caller", "actors", '"yukarin"'],
			["caller", "actors", '"hikari"'],
		]);
	});

	it("もう一度流しても、行も events も増えない", async () => {
		const id = (await callerRow(CLIENT_ID))?.id ?? "";
		const count = () =>
			env.DB.prepare(
				"SELECT (SELECT count(*) FROM events) AS events, (SELECT count(*) FROM actors) AS actors, (SELECT count(*) FROM callers) AS callers, (SELECT count(*) FROM caller_actors) AS links",
			).first();
		const before = await count();
		await run(input);
		expect(await count()).toEqual(before);
		expect((await callerRow(CLIENT_ID))?.id).toBe(id);
	});

	it("後から actor を足すと、その許可だけを同じ呼び出し元に足す", async () => {
		const id = (await callerRow(CLIENT_ID))?.id ?? "";
		await run({ ...input, actors: `${input.actors},akarin` });
		expect(await allowed(id)).toEqual(["akarin", "hikari", "yukarin"]);
		const events = await eventsOf(id);
		expect(events.map((e) => e.after).slice(3)).toEqual(['"akarin"']);
		expect(await eventsOf("akarin")).toEqual([]);
	});

	it("足した呼び出し元は、名乗った actor として記録され、名乗らなければ 400、一覧に無い名乗りは 403", async () => {
		const as = { clientId: CLIENT_ID };
		const made = await call(
			{ ...as, actor: "hikari" },
			"POST",
			"/v1/projects",
			{
				name: "roster",
			},
		);
		expect(made.status).toBe(201);
		const project = await made.json<{ id: string }>();
		expect((await eventsOf(project.id))[0]).toMatchObject({
			actor_id: "hikari",
			caller_id: (await callerRow(CLIENT_ID))?.id,
		});
		expect((await call(as, "GET", "/v1/projects")).status).toBe(400);
		const other = await call({ ...as, actor: "owner" }, "GET", "/v1/projects");
		expect(other.status).toBe(403);
	});

	it("既定の actor を持つ呼び出し元は、名乗らなければその actor になる", async () => {
		const clientId = `${"f".repeat(32)}.access`;
		await run({
			name: "example-solo",
			clientId,
			actors: "solo",
			defaultActor: "solo",
		});
		expect(await callerRow(clientId)).toMatchObject({
			default_actor_id: "solo",
		});
		expect(await actorRow("solo")).toMatchObject({ runtime: null });
		const made = await call({ clientId }, "POST", "/v1/projects", {
			name: "solo",
		});
		const project = await made.json<{ id: string }>();
		expect((await eventsOf(project.id))[0]?.actor_id).toBe("solo");
	});

	it("形の違う値は、文を作らずに拒む", () => {
		const bad: Partial<CallerInput>[] = [
			{ name: "" },
			{ name: "x'; DROP TABLE actors; --" },
			{ clientId: "abc.access" },
			{ clientId: `${"A".repeat(32)}.access` },
			{ actors: "" },
			{ actors: "yukarin,yukarin" },
			{ actors: "yukarin:claude'cli" },
			{ actors: "yukarin:a:b" },
			{ actors: "Yukarin" },
			{ defaultActor: "akarin" },
		];
		for (const patch of bad) {
			expect(callerStatements({ ...input, ...patch }, "t").ok).toBe(false);
		}
	});
});
