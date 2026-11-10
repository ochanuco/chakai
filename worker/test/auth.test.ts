import { beforeAll, describe, expect, it } from "vitest";
import {
	call,
	eventsOf,
	MAC,
	mac,
	owner,
	seedRoster,
	sign,
	strangerKey,
	WORKING,
	working,
} from "./helpers.ts";

beforeAll(seedRoster);

const whoCreates = async (as: Parameters<typeof call>[0]) => {
	const res = await call(as, "POST", "/v1/projects", { name: "who" });
	expect(res.status).toBe(201);
	const { id } = await res.json<{ id: string }>();
	const [event] = await eventsOf(id);
	return { actor: event?.actor_id, caller: event?.caller_id };
};

describe("人（email）", () => {
	it("名簿の email を actor にし、caller_id は残さない", async () => {
		expect(await whoCreates(owner)).toEqual({ actor: "owner", caller: null });
	});

	it("email の大文字と小文字を区別しない", async () => {
		expect(await whoCreates({ email: "Owner@Example.com" })).toEqual({
			actor: "owner",
			caller: null,
		});
	});

	it("名簿に無い email と、無効にした人は 403", async () => {
		for (const email of ["stranger@example.com", "left@example.com"]) {
			const res = await call({ email }, "GET", "/v1/projects");
			expect(res.status).toBe(403);
		}
	});
});

describe("service token（common_name）", () => {
	it("X-Actor が無ければ既定の actor にし、caller_id を残す", async () => {
		expect(await whoCreates(mac)).toEqual({ actor: "owner", caller: MAC.id });
	});

	it("X-Actor が許可リストにあれば、その actor にする", async () => {
		expect(await whoCreates(working("akarin"))).toEqual({
			actor: "akarin",
			caller: WORKING.id,
		});
	});

	it("許可リストに無い名乗りは 403", async () => {
		for (const as of [
			working("owner"),
			{ ...mac, actor: "yukarin" },
			working("nobody"),
		]) {
			const res = await call(as, "GET", "/v1/projects");
			expect(res.status).toBe(403);
			expect(await res.json()).toMatchObject({ error: "actor_not_allowed" });
		}
	});

	it("許可リストにあっても、無効にした actor は 403", async () => {
		const res = await call(working("retired"), "GET", "/v1/projects");
		expect(res.status).toBe(403);
	});

	it("既定の actor が無い呼び出し元は、名乗らなければ 400", async () => {
		const res = await call(
			{ clientId: WORKING.clientId },
			"GET",
			"/v1/projects",
		);
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({ error: "actor_required" });
	});

	it("登録の無い common_name は 403", async () => {
		const res = await call(
			{ clientId: "unknown.access" },
			"GET",
			"/v1/projects",
		);
		expect(res.status).toBe(403);
		expect(await res.json()).toMatchObject({ error: "unknown_caller" });
	});
});

describe("JWT の検証", () => {
	it("JWT が無ければ 401", async () => {
		expect((await call(null, "GET", "/v1/projects")).status).toBe(401);
		expect((await call(null, "POST", "/mcp", {})).status).toBe(401);
	});

	it.each([
		["別の鍵で署名", { key: strangerKey }],
		["aud が違う", { aud: "other-aud" }],
		["issuer が違う", { iss: "https://evil.example.com" }],
		["期限切れ", { exp: "-1m" }],
	])("%s は 401", async (_name, opts) => {
		const token = await sign({ email: "owner@example.com" }, opts);
		expect((await call({ token }, "GET", "/v1/projects")).status).toBe(401);
	});

	it("/health は JWT が無くても応える", async () => {
		expect((await call(null, "GET", "/health")).status).toBe(200);
	});
});
