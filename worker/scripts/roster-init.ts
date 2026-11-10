// 名簿に最初の owner と、Mac の呼び出し元（既定の actor は owner）を入れる。
//   OWNER_EMAIL=... MAC_AGENT_CLIENT_ID=... node scripts/roster-init.ts <--local|--remote>
// 実値を repo に載せないよう、値は環境変数で受ける。もう入っている行は変えないので、何度流してもよい。
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uuidv7 } from "uuidv7";

const target = process.argv[2];
if (target !== "--local" && target !== "--remote") {
	console.error("usage: node scripts/roster-init.ts <--local|--remote>");
	process.exit(2);
}

// SQL に埋めるので、形の合わない値は通さない
const read = (name: string, pattern: RegExp) => {
	const value = process.env[name]?.trim() ?? "";
	if (!pattern.test(value)) {
		console.error(`error: ${name} が未設定か、形が違う（${pattern}）`);
		process.exit(1);
	}
	return value;
};

const email = read(
	"OWNER_EMAIL",
	/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+$/,
).toLowerCase();
const clientId = read("MAC_AGENT_CLIENT_ID", /^[0-9a-f]{32}\.access$/);

const at = new Date().toISOString();
const caller = `(SELECT id FROM callers WHERE access_client_id = '${clientId}')`;
// 行がまだ無いときだけ events に残す。流し直しても履歴は増えない
const event = (
	entity: string,
	entityId: string,
	field: string,
	after: unknown,
	exists: string,
) =>
	`INSERT INTO events (id, entity, entity_id, actor_id, caller_id, at, field, before, after)
SELECT '${uuidv7()}', '${entity}', ${entityId}, 'owner', NULL, '${at}', '${field}', NULL, '${JSON.stringify(after)}'
WHERE NOT EXISTS (${exists});`;

const newCallerId = uuidv7();
// events.actor_id は actors を参照するので、owner の行だけは履歴より先に入れる。
// 呼び出し元の履歴は、行があるかどうかを見てから書くために、行を入れる文の前に置く
const sql = `INSERT OR IGNORE INTO actors (id, kind, role, display_name, runtime, email, active)
VALUES ('owner', 'human', 'owner', 'owner', NULL, '${email}', 1);
${event("actor", "'owner'", "created", { id: "owner", kind: "human", role: "owner" }, "SELECT 1 FROM events WHERE entity = 'actor' AND entity_id = 'owner' AND field = 'created'")}
${event("caller", `'${newCallerId}'`, "created", { name: "mac-agent", default_actor_id: "owner" }, caller.slice(1, -1))}
${event("caller", `COALESCE(${caller}, '${newCallerId}')`, "actors", "owner", `SELECT 1 FROM caller_actors WHERE actor_id = 'owner' AND caller_id = ${caller}`)}
INSERT OR IGNORE INTO callers (id, access_client_id, name, default_actor_id)
VALUES ('${newCallerId}', '${clientId}', 'mac-agent', 'owner');
INSERT OR IGNORE INTO caller_actors (caller_id, actor_id)
SELECT id, 'owner' FROM callers WHERE access_client_id = '${clientId}';
`;

const dir = mkdtempSync(join(tmpdir(), "chakai-roster-"));
const file = join(dir, "roster.sql");
try {
	writeFileSync(file, sql, { mode: 0o600 });
	const run = spawnSync(
		"pnpm",
		["exec", "wrangler", "d1", "execute", "chakai", target, "--file", file],
		{ cwd: join(import.meta.dirname, ".."), stdio: "inherit" },
	);
	process.exitCode = run.status ?? 1;
} finally {
	rmSync(dir, { recursive: true, force: true });
}
