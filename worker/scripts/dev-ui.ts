// 手元で画面を確かめるための入口。Access の代わりに、起動のたびに作る鍵で JWT を署名して付ける。
//   pnpm run dev:ui
// 既定は owner@example.com のログイン。X-Dev-Client-Id を付けると、その Client ID の service token として署名する。
// wrangler.jsonc の main はこのファイルを指さないので、deploy する Worker には入らない
import { generateKeyPair, SignJWT } from "jose";
import { createApp } from "../src/index.ts";

const OWNER_EMAIL = "owner@example.com";
const CLIENT_ID_HEADER = "X-Dev-Client-Id";

// 乱数は global scope で使えないので、最初のリクエストで作る
let pair: ReturnType<typeof generateKeyPair> | undefined;

export default {
	async fetch(request, env): Promise<Response> {
		pair ??= generateKeyPair("RS256");
		const { publicKey, privateKey } = await pair;
		const clientId = request.headers.get(CLIENT_ID_HEADER);
		const token = await new SignJWT(
			clientId ? { common_name: clientId } : { email: OWNER_EMAIL },
		)
			.setProtectedHeader({ alg: "RS256" })
			.setIssuer(`https://${env.ACCESS_TEAM_DOMAIN}`)
			.setAudience(env.ACCESS_AUD)
			.setIssuedAt()
			.setExpirationTime("5m")
			.sign(privateKey);
		const headers = new Headers(request.headers);
		headers.set("Cf-Access-Jwt-Assertion", token);
		return createApp({ keys: async () => publicKey }).fetch(
			new Request(request, { headers }),
			env,
		);
	},
} satisfies ExportedHandler<Env>;
