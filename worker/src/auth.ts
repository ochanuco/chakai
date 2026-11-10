import { and, eq } from "drizzle-orm";
import {
	createRemoteJWKSet,
	errors,
	type JWTPayload,
	type JWTVerifyGetKey,
	jwtVerify,
} from "jose";
import type { Db } from "./db/client.ts";
import { actors, callerActors, callers } from "./db/schema.ts";
import { fail, ok, type Result } from "./result.ts";

/** 誰のリクエストか。callerId は service token で来たときだけ入る */
export type Principal = { actorId: string; callerId: string | null };

export type AccessConfig = { teamDomain: string; aud: string };

export const ACTOR_HEADER = "X-Actor";

// isolate 内で JWKS を使い回す（jose が取得結果と cooldown を管理する）
const remoteKeys = new Map<string, JWTVerifyGetKey>();

export const accessKeySource = (teamDomain: string): JWTVerifyGetKey => {
	let keys = remoteKeys.get(teamDomain);
	if (!keys) {
		keys = createRemoteJWKSet(
			new URL(`https://${teamDomain}/cdn-cgi/access/certs`),
		);
		remoteKeys.set(teamDomain, keys);
	}
	return keys;
};

const activeActor = async (db: Db, id: string) =>
	(
		await db
			.select({ id: actors.id })
			.from(actors)
			.where(and(eq(actors.id, id), eq(actors.active, true)))
			.limit(1)
	)[0];

export const authenticate = async (
	request: Request,
	db: Db,
	config: AccessConfig,
	keys: JWTVerifyGetKey,
): Promise<Result<Principal>> => {
	const token = request.headers.get("Cf-Access-Jwt-Assertion");
	if (!token) return fail(401, "missing_token", "Access の JWT が無い");

	let payload: JWTPayload;
	try {
		({ payload } = await jwtVerify(token, keys, {
			algorithms: ["RS256"],
			issuer: `https://${config.teamDomain}`,
			audience: config.aud,
		}));
	} catch (e) {
		// JWKS を取れないときも検証できないので、認証の失敗として扱う
		return fail(
			401,
			e instanceof errors.JOSEError ? e.code : "invalid_token",
			"Access の JWT を検証できない",
		);
	}

	if (typeof payload.email === "string" && payload.email) {
		const [actor] = await db
			.select({ id: actors.id })
			.from(actors)
			.where(
				and(
					eq(actors.email, payload.email.toLowerCase()),
					eq(actors.kind, "human"),
					eq(actors.active, true),
				),
			)
			.limit(1);
		return actor
			? ok({ actorId: actor.id, callerId: null })
			: fail(403, "unknown_email", "名簿に無い email");
	}

	const commonName = payload.common_name;
	if (typeof commonName !== "string" || !commonName) {
		return fail(403, "unknown_caller", "email も common_name も無い");
	}
	const [caller] = await db
		.select()
		.from(callers)
		.where(eq(callers.accessClientId, commonName))
		.limit(1);
	if (!caller) return fail(403, "unknown_caller", "登録の無い呼び出し元");

	const claimed = request.headers.get(ACTOR_HEADER);
	if (claimed === null) {
		if (!caller.defaultActorId) {
			return fail(
				400,
				"actor_required",
				`この呼び出し元は ${ACTOR_HEADER} で actor を名乗る必要がある`,
			);
		}
		return (await activeActor(db, caller.defaultActorId))
			? ok({ actorId: caller.defaultActorId, callerId: caller.id })
			: fail(403, "actor_not_allowed", "既定の actor が無効になっている");
	}
	const [allowed] = await db
		.select({ actorId: callerActors.actorId })
		.from(callerActors)
		.where(
			and(
				eq(callerActors.callerId, caller.id),
				eq(callerActors.actorId, claimed),
			),
		)
		.limit(1);
	if (!allowed || !(await activeActor(db, claimed))) {
		return fail(
			403,
			"actor_not_allowed",
			"この呼び出し元はその actor を名乗れない",
		);
	}
	return ok({ actorId: claimed, callerId: caller.id });
};
