// 名簿に呼び出し元（service token）と、その呼び出し元が名乗ってよい actor を足す。
//   CALLER_NAME=... CALLER_CLIENT_ID=... CALLER_ACTORS=名前[:runtime],... [CALLER_DEFAULT_ACTOR=...] \
//     node scripts/roster-add-caller.ts <--local|--remote>
// 実値を repo に載せないよう、値は環境変数で受ける。
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callerStatements } from "./roster-caller-sql.ts";

const target = process.argv[2];
if (target !== "--local" && target !== "--remote") {
	console.error("usage: node scripts/roster-add-caller.ts <--local|--remote>");
	process.exit(2);
}

const env = (name: string) => process.env[name]?.trim() ?? "";
const built = callerStatements(
	{
		name: env("CALLER_NAME"),
		clientId: env("CALLER_CLIENT_ID"),
		actors: env("CALLER_ACTORS"),
		defaultActor: env("CALLER_DEFAULT_ACTOR"),
	},
	new Date().toISOString(),
);
if (!built.ok) {
	console.error(`error: ${built.error}`);
	process.exit(1);
}

const dir = mkdtempSync(join(tmpdir(), "chakai-roster-"));
const file = join(dir, "roster.sql");
try {
	writeFileSync(file, `${built.statements.join(";\n")};\n`, { mode: 0o600 });
	const run = spawnSync(
		"pnpm",
		["exec", "wrangler", "d1", "execute", "chakai", target, "--file", file],
		{ cwd: join(import.meta.dirname, ".."), stdio: "inherit" },
	);
	process.exitCode = run.status ?? 1;
} finally {
	rmSync(dir, { recursive: true, force: true });
}
