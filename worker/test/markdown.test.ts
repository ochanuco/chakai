import { describe, expect, it } from "vitest";
import { markdown } from "../src/ui/markdown.ts";

const md = (s: string) => markdown(s).value;

describe("本文の Markdown", () => {
	it("見出し・箇条書き・番号付きリスト・段落を組む", () => {
		expect(
			md(
				"## 起きていること\n画面が重い。\n次の行\n\n- 一つ目\n- 二つ目\n  - 入れ子\n\n1. 手順\n2. 次",
			),
		).toBe(
			"<h3>起きていること</h3><p>画面が重い。<br>次の行</p><ul><li>一つ目</li><li>二つ目<ul><li>入れ子</li></ul></li></ul><ol><li>手順</li><li>次</li></ol>",
		);
	});

	it("コード、太字、引用を組み、コードの中には書式を当てない", () => {
		expect(md("`**a**` と **b**")).toBe(
			"<p><code>**a**</code> と <strong>b</strong></p>",
		);
		expect(md("```\n<b>x</b>\n## y\n```")).toBe(
			"<pre><code>&lt;b&gt;x&lt;/b&gt;\n## y</code></pre>",
		);
		expect(md("> 引用")).toBe("<blockquote>引用</blockquote>");
	});

	it("リンクは http と https だけにする", () => {
		expect(md("[資料](https://example.com/a?b=1&c=2)")).toBe(
			'<p><a href="https://example.com/a?b=1&amp;c=2" rel="noreferrer">資料</a></p>',
		);
		expect(md("見る https://example.com/x。")).toBe(
			'<p>見る <a href="https://example.com/x" rel="noreferrer">https://example.com/x</a>。</p>',
		);
		expect(md("[x](javascript:alert(1))")).not.toContain("<a");
	});

	it("書き手の HTML はエスケープして通さない", () => {
		const out = md(
			'<img src=x onerror=alert(1)>\n- <script>a</script>\n[a"><b>](https://e.example/")',
		);
		expect(out).not.toContain("<img");
		expect(out).not.toContain("<script>");
		expect(out).not.toContain('"><b>');
		expect(out).toContain("&lt;img src=x onerror=alert(1)&gt;");
	});
});
