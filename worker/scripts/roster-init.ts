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
const event = (entity: string, entityId: string, after: object) =>
	`INSERT INTO events (id, entity, entity_id, actor_id, caller_id, at, field, before, after)
SELECT '${uuidv7()}', '${entity}', ${entityId}, 'owner', NULL, '${at}', 'created', NULL, '${JSON.stringify(after)}'
WHERE NOT EXISTS (SELECT 1 FROM events WHERE entity = '${entity}' AND entity_id = ${entityId} AND field = 'created');`;

const sql = `INSERT OR IGNORE INTO actors (id, kind, role, display_name, runtime, email, active)
VALUES ('owner', 'human', 'owner', 'owner', NULL, '${email}', 1);
${event("actor", "'owner'", { id: "owner", kind: "human", role: "owner" })}
INSERT OR IGNORE INTO callers (id, access_client_id, name, default_actor_id)
VALUES ('${uuidv7()}', '${clientId}', 'mac-agent', 'owner');
INSERT OR IGNORE INTO caller_actors (caller_id, actor_id)
SELECT id, 'owner' FROM callers WHERE access_client_id = '${clientId}';
${event("caller", caller, { name: "mac-agent", default_actor_id: "owner", actors: ["owner"] })}
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
