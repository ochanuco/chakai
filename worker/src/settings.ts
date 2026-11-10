import { and, eq, inArray } from "drizzle-orm";
import { requireOwner } from "./actors.ts";
import type { Principal } from "./auth.ts";
import type { Db } from "./db/client.ts";
import { settings } from "./db/schema.ts";
import { retryOnConflict, writeAll } from "./db/write.ts";
import { eventInserts } from "./events.ts";
import { projectExists } from "./projects.ts";
import { fail, ok, type Result } from "./result.ts";

export const GLOBAL_SCOPE = "global";

/** どの scope にも行が無いときの値 */
const DEFAULTS = { max_self_todo_depth: 3 };

export type SettingKey = keyof typeof DEFAULTS;
export const SETTING_KEYS = Object.keys(DEFAULTS) as SettingKey[];

type Source = "default" | "global" | "project";
export type Settings = {
	scope: string;
	settings: Record<SettingKey, { value: number; source: Source }>;
};

const resolve = async (db: Db, scope: string): Promise<Settings> => {
	const rows = await db
		.select()
		.from(settings)
		.where(inArray(settings.scope, [GLOBAL_SCOPE, scope]));
	const stored = (at: string, key: SettingKey) => {
		const row = rows.find((r) => r.scope === at && r.key === key);
		const value = row ? (JSON.parse(row.value) as number | null) : null;
		return value ?? undefined;
	};
	const one = (key: SettingKey): { value: number; source: Source } => {
		const own = scope === GLOBAL_SCOPE ? undefined : stored(scope, key);
		if (own !== undefined) return { value: own, source: "project" };
		const global = stored(GLOBAL_SCOPE, key);
		if (global !== undefined) return { value: global, source: "global" };
		return { value: DEFAULTS[key], source: "default" };
	};
	return {
		scope,
		settings: { max_self_todo_depth: one("max_self_todo_depth") },
	};
};

/** プロジェクトで効く値。プロジェクトの上書き、global、既定の順に探す */
export const settingFor = async (db: Db, projectId: string, key: SettingKey) =>
	(await resolve(db, projectId)).settings[key].value;

const scopeExists = async (db: Db, scope: string) =>
	scope === GLOBAL_SCOPE || (await projectExists(db, scope));

const noScope = () =>
	fail(404, "scope_not_found", "scope は global かプロジェクトの ID");

export const getSettings = async (
	db: Db,
	scope: string,
): Promise<Result<Settings>> =>
	(await scopeExists(db, scope)) ? ok(await resolve(db, scope)) : noScope();

export type PutSettingInput = { key: SettingKey; value: number | null };

/** value が null なら、その scope の値を外して上の scope の値に戻す */
export const putSetting = async (
	db: Db,
	who: Principal,
	scope: string,
	input: PutSettingInput,
): Promise<Result<Settings>> => {
	const allowed = await requireOwner(db, who);
	if (!allowed.ok) return allowed;
	if (!(await scopeExists(db, scope))) return noScope();

	const at = and(eq(settings.scope, scope), eq(settings.key, input.key));
	return retryOnConflict(
		async () => {
			const [current] = await db.select().from(settings).where(at).limit(1);
			const before = current
				? (JSON.parse(current.value) as number | null)
				: null;
			if (before !== input.value) {
				const value = JSON.stringify(input.value);
				await writeAll(db, [
					// 読んだ後に他の書き込みが入っていたら、一意制約か revision の trigger が batch ごと取り消す。
					// events の before が、実際の直前の値とずれないようにするため
					current
						? db
								.update(settings)
								.set({ value, revision: current.revision + 1 })
								.where(at)
						: db.insert(settings).values({ scope, key: input.key, value }),
					...eventInserts(db, who, new Date().toISOString(), [
						{
							entity: "setting",
							entityId: scope,
							field: input.key,
							before,
							after: input.value,
						},
					]),
				]);
			}
			return ok(await resolve(db, scope));
		},
		() => fail(409, "conflict", "他の書き込みと重なった。もう一度試す"),
	);
};
