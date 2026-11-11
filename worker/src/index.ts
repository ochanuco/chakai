import type { JWTVerifyGetKey } from "jose";
import { accessKeySource, authenticate } from "./auth.ts";
import { openDb } from "./db/client.ts";
import type { GitHub } from "./github.ts";
import { checkWrite } from "./guard.ts";
import { handleMcp } from "./mcp.ts";
import { handleRest } from "./rest.ts";
import { runSync } from "./sync.ts";
import { handleUi } from "./ui/index.ts";

type Options = { keys?: JWTVerifyGetKey; fetch?: typeof fetch };

const githubOf = (env: Env, options: Options): GitHub | null =>
	env.GITHUB_TOKEN
		? {
				token: env.GITHUB_TOKEN,
				// メソッドとして呼ばないと、Workers の fetch は this が違うと言って拒む
				fetch: options.fetch ?? ((input, init) => fetch(input, init)),
			}
		: null;

/**
 * keys を差し替えられるのは、テストが Access の代わりに JWT を署名するため。
 * fetch は、テストが GitHub の代わりに答えるため
 */
export const createApp = (options: Options = {}) => ({
	async fetch(request: Request, env: Env): Promise<Response> {
		const { pathname } = new URL(request.url);
		if (request.method === "GET" && pathname === "/health") {
			return Response.json({ ok: true });
		}
		const db = openDb(env.DB);
		const who = await authenticate(
			request,
			db,
			{ teamDomain: env.ACCESS_TEAM_DOMAIN, aud: env.ACCESS_AUD },
			options.keys ?? accessKeySource(env.ACCESS_TEAM_DOMAIN),
		);
		if (!who.ok) {
			return Response.json(
				{ error: who.error.code, message: who.error.message },
				{ status: who.error.status },
			);
		}
		const context = { db, who: who.value, github: githubOf(env, options) };
		if (pathname.startsWith("/v1/")) {
			const refused = checkWrite(request, who.value);
			if (refused) {
				return Response.json(
					{ error: refused.error.code, message: refused.error.message },
					{ status: refused.error.status },
				);
			}
			return handleRest(request, context);
		}
		if (pathname === "/mcp") return handleMcp(request, context);
		return handleUi(request, context);
	},
	async scheduled(
		_controller: ScheduledController,
		env: Env,
		ctx: ExecutionContext,
	): Promise<void> {
		ctx.waitUntil(
			runSync(openDb(env.DB), githubOf(env, options), null)
				.then((result) => {
					const log = result.warnings.length > 0 ? console.warn : console.log;
					log(JSON.stringify({ message: "sync", ...result }));
				})
				// 失敗した回を例外で終わらせず、理由をログに残して次の回に任せる
				.catch((e: unknown) => {
					console.error(
						JSON.stringify({ message: "sync failed", error: String(e) }),
					);
				}),
		);
	},
});

export default createApp() satisfies ExportedHandler<Env>;
