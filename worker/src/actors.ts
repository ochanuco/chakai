import { eq } from "drizzle-orm";
import type { Principal } from "./auth.ts";
import type { Db } from "./db/client.ts";
import { actors } from "./db/schema.ts";
import { fail, ok, type Result } from "./result.ts";

export const findActor = async (db: Db, id: string) =>
	(
		await db
			.select({ kind: actors.kind, role: actors.role })
			.from(actors)
			.where(eq(actors.id, id))
			.limit(1)
	)[0];

export const isOwner = async (db: Db, who: Principal) =>
	(await findActor(db, who.actorId))?.role === "owner";

export const requireOwner = async (
	db: Db,
	who: Principal,
): Promise<Result<null>> =>
	(await isOwner(db, who))
		? ok(null)
		: fail(403, "owner_only", "owner だけができる操作");
