import type { Principal } from "./auth.ts";
import type { events } from "./db/schema.ts";
import { newId } from "./id.ts";

export type Change = {
	entity: "project" | "task" | "label";
	entityId: string;
	field: string;
	before?: unknown;
	after?: unknown;
};

const encode = (value: unknown): string | null =>
	value === undefined || value === null ? null : JSON.stringify(value);

/** events の行を作る。書き込みと同じ batch に入れて、片方だけが残らないようにする */
export const eventRows = (
	who: Principal,
	at: string,
	changes: Change[],
): (typeof events.$inferInsert)[] =>
	changes.map((c) => ({
		id: newId(),
		entity: c.entity,
		entityId: c.entityId,
		actorId: who.actorId,
		callerId: who.callerId,
		at,
		field: c.field,
		before: encode(c.before),
		after: encode(c.after),
	}));
