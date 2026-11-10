import { uuidv7 } from "uuidv7";

export type CallerInput = {
	name: string;
	clientId: string;
	/** `yukarin:claude-cli,akarin:codex-cli` の形。runtime は省ける */
	actors: string;
	/** 空なら既定の actor 無し（必ず名乗る呼び出し元） */
	defaultActor: string;
};

type Built = { ok: true; statements: string[] } | { ok: false; error: string };

// SQL に埋めるので、形の合わない値は通さない
const NAME = /^[a-z][a-z0-9_-]{0,63}$/;
const RUNTIME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const CLIENT_ID = /^[0-9a-f]{32}\.access$/;

/**
 * 呼び出し元を名簿に足す文を作る。もう入っている行は変えず、行を足すときだけ events に残すので、
 * 何度流しても行も履歴も増えない。events の actor は owner なので、owner の行が先に要る
 */
export const callerStatements = (input: CallerInput, at: string): Built => {
	if (!NAME.test(input.name)) {
		return { ok: false, error: `呼び出し元の名前の形が違う（${NAME}）` };
	}
	if (!CLIENT_ID.test(input.clientId)) {
		return { ok: false, error: `Client ID の形が違う（${CLIENT_ID}）` };
	}
	const actors: { id: string; runtime: string | null }[] = [];
	for (const entry of input.actors.split(",")) {
		const [id = "", runtime, ...rest] = entry.trim().split(":");
		if (
			!NAME.test(id) ||
			rest.length > 0 ||
			(runtime !== undefined && !RUNTIME.test(runtime))
		) {
			return {
				ok: false,
				error: `actor の形が違う: "${entry}"（名前 か 名前:runtime）`,
			};
		}
		if (actors.some((a) => a.id === id)) {
			return { ok: false, error: `actor が重なっている: ${id}` };
		}
		actors.push({ id, runtime: runtime ?? null });
	}
	if (input.defaultActor && !actors.some((a) => a.id === input.defaultActor)) {
		return {
			ok: false,
			error: `既定の actor が、名乗ってよい actor の一覧に無い: ${input.defaultActor}`,
		};
	}
	const defaultActor = input.defaultActor || null;

	const newCallerId = uuidv7();
	const caller = `(SELECT id FROM callers WHERE access_client_id = '${input.clientId}')`;
	const quote = (value: string | null) =>
		value === null ? "NULL" : `'${value}'`;
	// 行があるかどうかを見てから書くために、どの履歴も、その行を入れる文の前に置く
	const event = (
		entity: string,
		entityId: string,
		field: string,
		after: unknown,
		exists: string,
	) =>
		`INSERT INTO events (id, entity, entity_id, actor_id, caller_id, at, field, before, after) SELECT '${uuidv7()}', '${entity}', ${entityId}, 'owner', NULL, '${at}', '${field}', NULL, '${JSON.stringify(after)}' WHERE NOT EXISTS (${exists})`;

	return {
		ok: true,
		statements: [
			...actors.flatMap((a) => [
				event(
					"actor",
					`'${a.id}'`,
					"created",
					{ id: a.id, kind: "agent", role: "member", runtime: a.runtime },
					`SELECT 1 FROM actors WHERE id = '${a.id}'`,
				),
				`INSERT OR IGNORE INTO actors (id, kind, role, display_name, runtime, email, active) VALUES ('${a.id}', 'agent', 'member', '${a.id}', ${quote(a.runtime)}, NULL, 1)`,
			]),
			event(
				"caller",
				`'${newCallerId}'`,
				"created",
				{ name: input.name, default_actor_id: defaultActor },
				caller.slice(1, -1),
			),
			...actors.map((a) =>
				event(
					"caller",
					`COALESCE(${caller}, '${newCallerId}')`,
					"actors",
					a.id,
					`SELECT 1 FROM caller_actors WHERE actor_id = '${a.id}' AND caller_id = ${caller}`,
				),
			),
			`INSERT OR IGNORE INTO callers (id, access_client_id, name, default_actor_id) VALUES ('${newCallerId}', '${input.clientId}', '${input.name}', ${quote(defaultActor)})`,
			...actors.map(
				(a) =>
					`INSERT OR IGNORE INTO caller_actors (caller_id, actor_id) SELECT id, '${a.id}' FROM callers WHERE access_client_id = '${input.clientId}'`,
			),
		],
	};
};
