const ESCAPES: Record<string, string> = {
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
	"'": "&#39;",
};

export const escapeHtml = (s: string): string =>
	s.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);

/** エスケープ済みの HTML。html`` の中で、これだけがそのまま出る */
export class Markup {
	readonly value: string;
	constructor(value: string) {
		this.value = value;
	}
}

type Part = Markup | string | number | null | undefined | false | Part[];

const render = (part: Part): string => {
	if (part === null || part === undefined || part === false) return "";
	if (part instanceof Markup) return part.value;
	if (Array.isArray(part)) return part.map(render).join("");
	return escapeHtml(String(part));
};

/** 件名や本文は AI が書くので、埋め込む値は既定ですべてエスケープする */
export const html = (
	strings: TemplateStringsArray,
	...values: Part[]
): Markup =>
	new Markup(strings.reduce((out, s, i) => out + s + render(values[i]), ""));
