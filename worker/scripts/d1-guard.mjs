#!/usr/bin/env node
// 本番 D1 へ migration を当てる前後の見張り。chimera と yunomi に同じ処理を置く（整形だけが違う）。
//   node scripts/d1-guard.mjs before --driver <wrangler|cf> --db <name|id> --dir <migrations> --state <file>
//   node scripts/d1-guard.mjs after --state <file>
// before: 未適用の migration があれば、Time Travel の bookmark と各テーブルの行数を state に残し、復元コマンドを Job Summary に出す。
// after: 行数を取り直し、行が減ったテーブルがあれば失敗する（deploy は Worker を出す前に止まる）。
// 行を消す migration は、本文に `-- deploy: allow-row-loss <table>` と書いて減るテーブルを宣言する。
import { execFileSync } from "node:child_process";
import {
	appendFileSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

const [command, ...rest] = process.argv.slice(2);
const args = {};
for (let i = 0; i < rest.length; i += 2)
	args[rest[i].replace(/^--/, "")] = rest[i + 1];

const drivers = {
	wrangler: (db) => ({
		query: (sql) =>
			run([
				"wrangler",
				"d1",
				"execute",
				db,
				"--remote",
				"--json",
				"--command",
				sql,
			]),
		bookmark: () =>
			run(["wrangler", "d1", "time-travel", "info", db, "--json"]),
		restore: (bookmark) =>
			`pnpm exec wrangler d1 time-travel restore ${db} --bookmark=${bookmark}`,
	}),
	cf: (db) => ({
		query: (sql) => run(["cf", "d1", "query", db, "--sql", sql]),
		bookmark: () => run(["cf", "d1", "time-travel", "get-bookmark", db]),
		restore: (bookmark) =>
			`pnpm exec cf d1 time-travel restore ${db} --bookmark ${bookmark} --force`,
	}),
};

function run(argv) {
	const out = execFileSync("pnpm", ["exec", ...argv], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "inherit"],
	});
	return JSON.parse(out.slice(out.search(/[[{]/)));
}

// CLI ごとに封筒の形が違うので、値の入った最初のキーを深さ優先で探す
function find(value, key) {
	if (value === null || typeof value !== "object") return undefined;
	if (!Array.isArray(value) && key in value) return value[key];
	for (const child of Object.values(value)) {
		const found = find(child, key);
		if (found !== undefined) return found;
	}
	return undefined;
}

function rows(driver, sql) {
	const results = find(driver.query(sql), "results");
	if (!Array.isArray(results))
		throw new Error(`D1 の応答に results が無い: ${sql}`);
	return results;
}

function counts(driver) {
	const tables = rows(
		driver,
		"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name <> 'd1_migrations' ORDER BY name",
	).map((r) => r.name);
	if (tables.length === 0) return {};
	// D1 は UNION の項数を強く制限するので、1 行に並べたスカラー副問い合わせで数える（列数の上限 100 に収まるよう 50 ずつ）
	const result = {};
	for (let k = 0; k < tables.length; k += 50) {
		const sql = `SELECT ${tables
			.slice(k, k + 50)
			.map((t) => `(SELECT count(*) FROM "${t}") AS "${t}"`)
			.join(", ")}`;
		for (const [t, n] of Object.entries(rows(driver, sql)[0]))
			result[t] = Number(n);
	}
	return result;
}

function summary(lines) {
	const text = `${lines.join("\n")}\n`;
	process.stdout.write(text);
	if (process.env.GITHUB_STEP_SUMMARY)
		appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
}

const base = (name) => name.replace(/\.sql$/, "");

if (command === "before") {
	const driver = drivers[args.driver]?.(args.db);
	if (!driver || !args.dir || !args.state)
		throw new Error(
			"usage: d1-guard.mjs before --driver <wrangler|cf> --db <db> --dir <dir> --state <file>",
		);
	const hasTable =
		rows(
			driver,
			"SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'd1_migrations'",
		).length > 0;
	const applied = new Set(
		hasTable
			? rows(driver, "SELECT name FROM d1_migrations").map((r) => base(r.name))
			: [],
	);
	const pending = readdirSync(args.dir)
		.filter((f) => f.endsWith(".sql") && !applied.has(base(f)))
		.sort();
	if (pending.length === 0) {
		writeFileSync(args.state, JSON.stringify({ pending }));
		console.log("d1-guard: 未適用の migration は無い");
		process.exit(0);
	}
	const allowed = new Set(
		pending.flatMap((f) =>
			[
				...readFileSync(join(args.dir, f), "utf8").matchAll(
					/^--\s*deploy:\s*allow-row-loss\s+(\S+)/gm,
				),
			].map((m) => m[1]),
		),
	);
	const bookmark = find(driver.bookmark(), "bookmark");
	if (typeof bookmark !== "string")
		throw new Error("Time Travel の bookmark を取れなかった");
	const before = counts(driver);
	writeFileSync(
		args.state,
		JSON.stringify({
			driver: args.driver,
			db: args.db,
			pending,
			allowed: [...allowed],
			bookmark,
			before,
		}),
	);
	summary([
		"### D1 migration",
		"",
		...pending.map((f) => `- \`${f}\``),
		"",
		`適用前の bookmark: \`${bookmark}\`。戻すときは:`,
		"",
		"```sh",
		driver.restore(bookmark),
		"```",
		"",
		"戻したら、Worker も前のコミットにロールバックする（deploy を workflow_dispatch で前の SHA に）。",
	]);
} else if (command === "after") {
	const state = JSON.parse(readFileSync(args.state, "utf8"));
	if (state.pending.length === 0) process.exit(0);
	const driver = drivers[state.driver](state.db);
	const after = counts(driver);
	const allowed = new Set(state.allowed);
	const changes = Object.entries(state.before)
		.filter(([t]) => t in after && after[t] !== state.before[t])
		.map(([t, n]) => ({
			t,
			before: n,
			after: after[t],
			lost: after[t] < n && !allowed.has(t),
		}));
	const dropped = Object.keys(state.before).filter((t) => !(t in after));
	const lost = changes.filter((c) => c.lost);
	summary([
		"",
		changes.length + dropped.length === 0
			? "行数の変わったテーブルは無い。"
			: "| テーブル | 前 | 後 |\n|---|---:|---:|",
		...changes.map(
			(c) => `| ${c.lost ? "⚠️ " : ""}${c.t} | ${c.before} | ${c.after} |`,
		),
		...dropped.map((t) => `| ${t}（消えた） | ${state.before[t]} | - |`),
	]);
	if (lost.length > 0) {
		summary([
			"",
			`**行が減った: ${lost.map((c) => c.t).join(", ")}。Worker は出さずに止める。** 意図した削除なら migration に \`-- deploy: allow-row-loss <table>\` を書く。`,
			"戻すときは:",
			"",
			"```sh",
			driver.restore(state.bookmark),
			"```",
		]);
		process.exit(1);
	}
} else {
	throw new Error("usage: d1-guard.mjs <before|after> ...");
}
