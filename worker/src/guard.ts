import type { Principal } from "./auth.ts";
import { type Failure, fail } from "./result.ts";

const WRITE_METHODS = ["POST", "PATCH", "PUT", "DELETE"];

/**
 * REST の書き込みを、HTTP の入口で確かめる。経路ごとではなく method で見るので、後から足した書き込みにも効く。
 * ログインの cookie はブラウザが別のサイトからのリクエストにも付けるので、ログインで来た書き込みは
 * Origin が自分と同じものだけを通す。form で送れる Content-Type も受けない
 */
export const checkWrite = (
	request: Request,
	who: Principal,
): { ok: false; error: Failure } | null => {
	if (!WRITE_METHODS.includes(request.method)) return null;
	if (
		who.callerId === null &&
		request.headers.get("origin") !== new URL(request.url).origin
	) {
		return fail(403, "origin_mismatch", "Origin が無いか、違う");
	}
	const type = request.headers
		.get("content-type")
		?.split(";")[0]
		?.trim()
		.toLowerCase();
	if (type !== "application/json") {
		return fail(
			415,
			"unsupported_media_type",
			"Content-Type は application/json にする",
		);
	}
	return null;
};
