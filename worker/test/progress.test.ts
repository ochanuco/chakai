import { describe, expect, it } from "vitest";
import { progressOf } from "../src/progress.ts";

const t = (id: string, parentId: string | null, state: string) => ({
	id,
	parentId,
	state,
});

describe("progressOf", () => {
	it("子を持つタスクごとに、子孫の末端のうち done の数と数えるものの数を返す", () => {
		const map = progressOf([
			t("root", null, "doing"),
			t("a", "root", "done"),
			t("b", "root", "doing"),
			t("b1", "b", "done"),
			t("b2", "b", "todo"),
			t("leaf", null, "todo"),
		]);
		expect(map.get("root")).toEqual({ done: 2, total: 3 });
		expect(map.get("b")).toEqual({ done: 1, total: 2 });
		expect(map.has("a")).toBe(false);
		expect(map.has("leaf")).toBe(false);
	});

	it("dropped の枝は数えない", () => {
		const map = progressOf([
			t("root", null, "doing"),
			t("a", "root", "done"),
			t("x", "root", "dropped"),
			t("y", "root", "dropped"),
			t("y1", "y", "todo"),
		]);
		expect(map.get("root")).toEqual({ done: 1, total: 1 });
	});

	it("子がすべて dropped のタスクは、末端として数える", () => {
		const map = progressOf([
			t("root", null, "doing"),
			t("a", "root", "done"),
			t("a1", "a", "dropped"),
			t("b", "root", "todo"),
		]);
		expect(map.get("root")).toEqual({ done: 1, total: 2 });
	});

	it("渡されていない親は無視し、親が自分に戻る輪でも止まる", () => {
		const map = progressOf([t("a", "b", "done"), t("b", "a", "todo")]);
		expect(map.get("a")).toBeDefined();
	});
});
