import { escapeHtml, Markup } from "./html.ts";

/**
 * AI が書く本文と一言を、Markdown の一部として HTML にする。
 * 全体をエスケープしてから、決まった形だけをタグに戻すので、書き手の HTML は通らない。
 * 扱うのは見出し・箇条書き・番号付きリスト・引用・コードブロック・段落と、
 * 行の中のコード・太字・リンク（http と https だけ）
 */
export const markdown = (source: string): Markup => {
	const out: string[] = [];
	const lines = source.replace(/\r\n?/g, "\n").split("\n");
	let paragraph: string[] = [];
	const lists: { tag: "ul" | "ol"; indent: number }[] = [];

	const flushParagraph = () => {
		if (paragraph.length === 0) return;
		out.push(`<p>${paragraph.map(inline).join("<br>")}</p>`);
		paragraph = [];
	};
	const closeLists = (indent = -1) => {
		while (lists.length > 0 && (lists.at(-1)?.indent ?? 0) > indent) {
			out.push(`</li></${lists.pop()?.tag}>`);
		}
	};

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";
		const fence = line.match(/^\s*```/);
		if (fence) {
			flushParagraph();
			closeLists();
			const code: string[] = [];
			while (++i < lines.length && !/^\s*```/.test(lines[i] ?? "")) {
				code.push(lines[i] ?? "");
			}
			out.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
			continue;
		}
		if (line.trim() === "") {
			flushParagraph();
			closeLists();
			continue;
		}
		const heading = line.match(/^(#{1,6})\s+(.*)$/);
		if (heading) {
			flushParagraph();
			closeLists();
			const level = (heading[1]?.length ?? 1) <= 2 ? "h3" : "h4";
			out.push(`<${level}>${inline(heading[2] ?? "")}</${level}>`);
			continue;
		}
		const item = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
		if (item) {
			flushParagraph();
			const indent = item[1]?.length ?? 0;
			const tag = /\d/.test(item[2] ?? "") ? "ol" : "ul";
			const top = lists.at(-1);
			if (top && indent > top.indent) {
				out.push(`<${tag}><li>`);
				lists.push({ tag, indent });
			} else {
				closeLists(indent);
				const same = lists.at(-1);
				if (same && same.indent === indent && same.tag === tag) {
					out.push("</li><li>");
				} else {
					if (same && same.indent === indent) {
						out.push(`</li></${lists.pop()?.tag}>`);
					}
					out.push(`<${tag}><li>`);
					lists.push({ tag, indent });
				}
			}
			out.push(inline(item[3] ?? ""));
			continue;
		}
		const quote = line.match(/^>\s?(.*)$/);
		if (quote) {
			flushParagraph();
			closeLists();
			out.push(`<blockquote>${inline(quote[1] ?? "")}</blockquote>`);
			continue;
		}
		if (lists.length > 0 && /^\s+\S/.test(line)) {
			// 箇条書きの項目の続きの行
			out.push(`<br>${inline(line.trim())}`);
			continue;
		}
		closeLists();
		paragraph.push(line);
	}
	flushParagraph();
	closeLists();
	return new Markup(out.join(""));
};

/** 行の中の書式。コードの中身には、ほかの書式を当てない */
const inline = (text: string): string =>
	text
		.split(/(`[^`]+`)/)
		.map((part) =>
			part.startsWith("`") && part.endsWith("`") && part.length > 2
				? `<code>${escapeHtml(part.slice(1, -1))}</code>`
				: decorate(escapeHtml(part)),
		)
		.join("");

const decorate = (escaped: string): string =>
	escaped
		.replace(
			/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
			(_, label: string, url: string) =>
				`<a href="${url}" rel="noreferrer">${label}</a>`,
		)
		.replace(
			/(^|[^"'>=])(https?:\/\/[^\s<]+[^\s<.,、。）)])/g,
			(_, before: string, url: string) =>
				`${before}<a href="${url}" rel="noreferrer">${url}</a>`,
		)
		.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
