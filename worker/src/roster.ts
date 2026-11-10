import { asc, eq } from "drizzle-orm";
import type { Principal } from "./auth.ts";
import type { Db } from "./db/client.ts";
import { actors, labels } from "./db/schema.ts";

export type Actor = {
	id: string;
	kind: (typeof actors.$inferSelect)["kind"];
	role: (typeof actors.$inferSelect)["role"];
	display_name: string;
	runtime: string | null;
	active: boolean;
};

/** 名簿を返す。email は service token の呼び出しにも見えるので、載せない */
export const listActors = async (db: Db): Promise<Actor[]> =>
	(await db.select().from(actors).orderBy(asc(actors.id))).map((a) => ({
		id: a.id,
		kind: a.kind,
		role: a.role,
		display_name: a.displayName,
		runtime: a.runtime,
		active: a.active,
	}));

export type Label = { id: string; name: string };

export const listLabels = async (db: Db): Promise<Label[]> =>
	db.select().from(labels).orderBy(asc(labels.name));

/**
 * owner 本人が Access にログインして来たリクエストか。
 * service token は、owner を名乗れる呼び出し元（Mac の道具）でも通さない
 */
export const isOwnerLogin = async (db: Db, who: Principal) => {
	if (who.callerId !== null) return false;
	const [actor] = await db
		.select({ role: actors.role })
		.from(actors)
		.where(eq(actors.id, who.actorId))
		.limit(1);
	return actor?.role === "owner";
};
