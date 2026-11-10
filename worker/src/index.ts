import type { JWTVerifyGetKey } from "jose";
import { accessKeySource, authenticate } from "./auth.ts";
import { openDb } from "./db/client.ts";
import { handleMcp } from "./mcp.ts";
import { handleRest } from "./rest.ts";
import { handleUi } from "./ui/index.ts";

/** keys を差し替えられるのは、テストが Access の代わりに JWT を署名するため */
export const createApp = (options: { keys?: JWTVerifyGetKey } = {}) => ({
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
		const context = { db, who: who.value };
		if (pathname.startsWith("/v1/")) return handleRest(request, context);
		if (pathname === "/mcp") return handleMcp(request, context);
		return handleUi(request, context);
	},
});

export default createApp() satisfies ExportedHandler<Env>;
