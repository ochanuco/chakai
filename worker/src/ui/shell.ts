import { html, Markup } from "./html.ts";

/** 左ペインの切り替えとスマホの下のナビゲーションに出す件数 */
export type Nav = {
	review: number;
	triage: number;
	doing: number;
	/** 直近の同期の警告の数 */
	syncWarnings: number;
};

export type Section = "review" | "triage" | "doing" | "more";

/**
 * スマホでどちらのペインを見せるか。list は一覧、detail はタスク、page はそれ以外の画面。
 * Mac では list と detail は同じ見た目になる
 */
export type Pane = "list" | "detail" | "page";

const CSS = `
:root{color-scheme:light dark;
--paper:#FAFAF8;--surface:#FFFFFF;--sunken:#F4F4F1;--ink:#1C1C1A;--muted:#66665F;--faint:#B9B8B2;--line:#E4E3DE;--line-strong:#D5D4CE;
--matcha:#4F6B3A;--on-matcha:#FFFFFF;--matcha-wash:#E9EEE4;--matcha-ink:#2F4321;--matcha-line:#C9D4BF;
--alert-bg:#FBE7E4;--alert-ink:#8A2A1D;--wait-bg:#FBF0D9;--wait-ink:#7A5200;--good-bg:#E3F0E1;--good-ink:#2C5E2A;--link:#2F5E8A}
@media (prefers-color-scheme:dark){:root{
--paper:#161715;--surface:#1E1F1C;--sunken:#252622;--ink:#E8E8E3;--muted:#A3A39B;--faint:#5E5E58;--line:#33342F;--line-strong:#45463F;
--matcha:#6E9452;--on-matcha:#0F140B;--matcha-wash:#263021;--matcha-ink:#C3D9B2;--matcha-line:#3D4D33;
--alert-bg:#3E1F1A;--alert-ink:#F2B8AE;--wait-bg:#3A2E14;--wait-ink:#F0CF8C;--good-bg:#1F3320;--good-ink:#A9D8A4;--link:#8DB8E0}}
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.6 system-ui,-apple-system,"Hiragino Sans","Noto Sans JP",sans-serif;overflow-wrap:anywhere;-webkit-text-size-adjust:100%}
a{color:var(--link);text-decoration:none}
a:hover{text-decoration:underline}
:focus-visible{outline:2px solid var(--matcha);outline-offset:2px}
button,input,select,textarea{font:inherit;color:inherit}
button{cursor:pointer}
button:disabled{opacity:.5;cursor:default}
h1,h2,h3{margin:0;line-height:1.4}
.muted{color:var(--muted)}
.app{display:grid;grid-template-columns:300px minmax(0,1fr);height:100dvh}
.side{display:flex;flex-direction:column;min-height:0;background:var(--surface);border-right:1px solid var(--line)}
.switch{flex:none;height:64px;padding:0 12px;display:flex;align-items:center;border-bottom:1px solid var(--line)}
.switch nav{flex:1;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:2px;padding:3px;border-radius:10px;background:var(--sunken)}
.switch a{display:flex;justify-content:center;align-items:center;gap:5px;height:32px;border-radius:8px;color:var(--muted);font-size:13px;white-space:nowrap}
.switch a:hover{text-decoration:none;color:var(--ink)}
.switch a[aria-current]{background:var(--surface);color:var(--ink);font-weight:600;box-shadow:0 0 0 1px var(--line)}
.count{font-variant-numeric:tabular-nums}
.count.hot{color:var(--matcha);font-weight:700}
.listbar{flex:none;height:36px;padding:0 20px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--line);font-size:12px;color:var(--muted)}
.list{flex:1;min-height:0;overflow-y:auto}
.item{display:flex;flex-direction:column;gap:3px;padding:14px 20px;border-bottom:1px solid var(--line);color:var(--ink)}
.item:hover{text-decoration:none;background:var(--sunken)}
.item[aria-current]{background:var(--matcha-wash);box-shadow:inset 3px 0 0 var(--matcha)}
.item .top{display:flex;gap:8px;font-size:12px;color:var(--muted)}
.item .top .project{font-weight:600;color:var(--ink)}
.item .top time{margin-left:auto;white-space:nowrap}
.item .lead{font-size:15px;font-weight:600;line-height:1.5}
.item .sub{font-size:12px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.empty{padding:20px;color:var(--muted);font-size:14px}
.menu{display:flex;flex-direction:column;padding:8px 0}
.menu a{padding:10px 20px;color:var(--ink)}
.menu a[aria-current]{font-weight:600;box-shadow:inset 3px 0 0 var(--matcha)}
.menu .warn{color:var(--alert-ink);font-size:12px;margin-left:6px}
.foot{flex:none;height:44px;padding:0 20px;display:flex;align-items:center;gap:16px;border-top:1px solid var(--line);font-size:13px}
.foot .brand{font-weight:700}
.foot a{color:var(--muted)}
.foot a[aria-current]{color:var(--ink);font-weight:600}
.main{display:flex;flex-direction:column;min-width:0;min-height:0;background:var(--paper)}
.tabbar{display:none}
.alert{background:var(--alert-bg);color:var(--alert-ink);border-radius:8px;padding:10px 12px;margin:12px 0}
.main>.alert{margin:12px 28px 0;flex:none}
.phone{display:none}
.ltitle{font-size:22px;padding:18px 16px 8px;background:var(--surface)}
.ltitle .muted{font-size:15px;font-weight:400}
.state{display:inline-block;border-radius:999px;padding:0 9px;font-size:12px;font-weight:600;line-height:1.7;white-space:nowrap;background:var(--sunken);color:var(--muted)}
.s-review{background:var(--matcha);color:var(--on-matcha)}
.s-doing{background:var(--wait-bg);color:var(--wait-ink)}
.s-todo{background:var(--sunken);color:var(--ink);box-shadow:inset 0 0 0 1px var(--line-strong)}
.s-done{background:var(--good-bg);color:var(--good-ink)}
.s-dropped{background:transparent;color:var(--muted);box-shadow:inset 0 0 0 1px var(--line);text-decoration:line-through}
select.state{appearance:none;-webkit-appearance:none;border:0;padding-right:20px;cursor:pointer;background-image:linear-gradient(45deg,transparent 50%,currentColor 50%),linear-gradient(135deg,currentColor 50%,transparent 50%);background-position:calc(100% - 11px) 55%,calc(100% - 7px) 55%;background-size:4px 4px;background-repeat:no-repeat}
.label{display:inline-block;border:1px solid var(--line-strong);border-radius:999px;padding:0 8px;font-size:12px;color:var(--muted);margin-right:4px}
.pr{display:inline-block;border-radius:6px;padding:0 6px;font-size:12px;font-weight:600;white-space:nowrap;background:var(--sunken);color:var(--muted)}
.pr.good{background:var(--good-bg);color:var(--good-ink)}
.pr.bad{background:var(--alert-bg);color:var(--alert-ink)}
.pr.wait{background:var(--wait-bg);color:var(--wait-ink)}
progress{width:5em;height:.5em;vertical-align:middle;accent-color:var(--matcha)}
.primary,.outline,.quiet{height:32px;padding:0 14px;border-radius:8px;font-size:13px;white-space:nowrap}
.primary{border:0;background:var(--matcha);color:var(--on-matcha);font-weight:600;min-width:120px}
.outline{border:1px solid var(--line-strong);background:var(--surface)}
.quiet{border:0;background:transparent;color:var(--muted)}
.quiet:hover{color:var(--alert-ink)}
.head{flex:none;min-height:64px;padding:10px 28px;display:flex;align-items:center;gap:8px;border-bottom:1px solid var(--line);background:var(--surface)}
.titles{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.titles h1{font-size:17px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.titles .line{display:flex;align-items:center;gap:10px;font-size:12px;color:var(--muted);white-space:nowrap;overflow:hidden}
.titles .crumbs{overflow:hidden;text-overflow:ellipsis}
.titles .crumbs a{color:var(--muted)}
.actions{display:flex;gap:6px;flex:none}
.back{align-items:center;justify-content:center;width:44px;height:44px;color:var(--ink);flex:none}
.back svg{width:22px;height:22px}
.body{flex:1;min-height:0;overflow-y:auto;display:flex;align-items:flex-start}
.conv{flex:1;min-width:0;max-width:820px;padding:20px 28px 40px}
.meta{position:sticky;top:0;width:260px;flex:none;align-self:stretch;border-left:1px solid var(--line);padding:20px;font-size:13px}
.mrow{display:flex;flex-direction:column;gap:4px;padding:12px 0;border-bottom:1px solid var(--line)}
.mrow:first-child{padding-top:0}
.mlabel{font-size:12px;color:var(--muted)}
.pull{display:flex;flex-direction:column;gap:2px;margin-bottom:6px}
.pills{display:flex;flex-wrap:wrap;gap:4px}
.rel{margin-bottom:6px}
.edit{padding-top:12px}
.edit summary{cursor:pointer;color:var(--link)}
.edit form{margin-top:8px}
.ev{list-style:none;display:flex;gap:12px}
.avatar{flex:none;width:32px;height:32px;border-radius:50%;background:var(--sunken);box-shadow:inset 0 0 0 1px var(--line);display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;color:var(--muted)}
.bubble{flex:1;min-width:0;background:var(--surface);border:1px solid var(--line);border-radius:10px}
.bh{display:flex;flex-wrap:wrap;justify-content:space-between;gap:4px 12px;padding:8px 14px;border-bottom:1px solid var(--line);background:var(--sunken);border-radius:10px 10px 0 0;font-size:13px}
.bt{margin:0;padding:12px 14px;white-space:pre-wrap;line-height:1.75}
.md{white-space:normal}
.md>:first-child{margin-top:0}
.md>:last-child{margin-bottom:0}
.md p,.md ul,.md ol,.md pre,.md blockquote{margin:0 0 10px}
.md h3{font-size:15px;margin:16px 0 6px}
.md h4{font-size:14px;margin:14px 0 4px}
.md ul,.md ol{padding-left:1.4em}
.md li{margin:2px 0}
.md code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.88em;background:var(--sunken);border-radius:4px;padding:1px 4px}
.md pre{background:var(--sunken);border-radius:6px;padding:10px 12px;overflow-x:auto}
.md pre code{background:none;padding:0;white-space:pre}
.md blockquote{border-left:3px solid var(--line-strong);padding-left:10px;color:var(--muted)}
.bubble details{padding:0 14px 12px;font-size:13px}
.bubble pre,.ev.line pre{white-space:pre-wrap;margin:4px 0;padding:8px;background:var(--sunken);border-radius:6px;font:inherit;font-size:13px}
.when{display:inline-flex;gap:8px;color:var(--muted);font-size:12px;white-space:nowrap}
.via::before{content:"from ";}
.opening{margin-bottom:20px}
.fold{max-height:13em;overflow:hidden;-webkit-mask-image:linear-gradient(#000 65%,transparent);mask-image:linear-gradient(#000 65%,transparent)}
.unfold{display:block;margin:0 14px 12px;padding:0;border:0;background:none;color:var(--link);font-size:13px}
.question .bubble{border-color:var(--matcha)}
.question .bh{background:var(--matcha-wash);border-color:var(--matcha-line);color:var(--matcha-ink)}
.question .bt{font-size:16px;font-weight:600}
.question .bt.note{font-size:14px;font-weight:400;border-top:1px solid var(--matcha-line)}
.answer .avatar{background:var(--ink);color:var(--paper);box-shadow:none}
.composer .avatar{background:var(--ink);color:var(--paper);box-shadow:none}
.composer .bubble{border-color:var(--line-strong)}
.composer label.bh{display:block;color:var(--muted)}
.composer textarea{display:block;width:100%;min-height:76px;border:0;border-radius:0 0 10px 10px;padding:10px 14px;background:transparent;resize:vertical}
.composer textarea:focus-visible{outline:2px solid var(--matcha);outline-offset:-2px}
.ev.line{align-items:baseline;flex-wrap:wrap;padding:0 0 0 10px;font-size:13px;color:var(--muted)}
.ev.line .what{flex:1;min-width:0}
.ev.line b,.bh b{color:var(--ink)}
.dot{flex:none;width:12px;height:12px;border-radius:50%;background:var(--faint);margin-right:18px;align-self:center}
.timeline{margin:0;padding:0;display:flex;flex-direction:column;gap:14px}
.tlhead{display:flex;justify-content:space-between;align-items:center;padding:20px 0 12px;border-top:1px solid var(--line)}
.tlhead h2{font-size:14px}
.sort{font-size:12px}
.children{margin-bottom:20px}
.children h2{font-size:14px;margin-bottom:6px}
.child{display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--line);font-size:14px}
.blank{margin:auto;padding:40px;text-align:center;color:var(--muted)}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin:10px 0}
.chip{display:inline-flex;align-items:center;gap:4px;min-height:32px;padding:0 10px;border:1px solid var(--line-strong);border-radius:999px;background:var(--surface);color:var(--ink);font-size:12px;white-space:nowrap}
.chip.on{border-color:var(--ink);font-weight:600}
.chip .n{color:var(--muted);font-weight:400;margin-left:4px}
.doc{flex:1;min-height:0;overflow-y:auto;padding:24px 28px 48px;max-width:900px;width:100%}
.doc h1{font-size:22px;margin:0 0 8px}
.doc h2{font-size:15px;margin:28px 0 8px}
.card{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin-top:8px}
.crumbs{font-size:13px;color:var(--muted)}
ul.tree,ul.tree ul{list-style:none;margin:0;padding:0}
ul.tree ul{margin-left:14px;padding-left:10px;border-left:2px solid var(--line)}
.row{display:flex;flex-wrap:wrap;align-items:center;gap:4px 8px;padding:8px 0;border-bottom:1px solid var(--line)}
.row .title{flex:1 1 180px;min-width:0;color:var(--ink)}
.row .who{color:var(--muted);font-size:13px;white-space:nowrap}
.row .waiting{flex-basis:100%;font-size:13px;color:var(--matcha-ink)}
.row.context{opacity:.55}
.row.closed .title{color:var(--muted)}
.move{display:inline-flex;gap:2px;margin-left:auto}
.move button{width:32px;height:32px;border:1px solid var(--line);border-radius:6px;background:var(--surface)}
.move button:disabled{opacity:.3}
.body-text{white-space:pre-wrap}
.inline{display:flex;flex-wrap:wrap;align-items:center;gap:6px}
.doc .actions button,button.plain{padding:4px 12px;border-radius:6px;border:1px solid var(--line-strong);background:var(--surface)}
form .field{margin:10px 0;border:0;padding:0}
form .field>label,form .field>legend{display:block;font-size:12px;color:var(--muted);margin-bottom:2px;padding:0}
form select,form input[type=text],form input[type=number],form textarea{color:var(--ink);background:var(--paper);border:1px solid var(--line-strong);border-radius:6px;padding:6px 8px;max-width:100%}
form textarea,form input[type=text]{width:100%}
form input[type=number]{width:6em}
form .checks{display:flex;flex-wrap:wrap;gap:4px 14px}
.doc form button[type=submit]{padding:6px 18px;border-radius:6px;border:0;background:var(--matcha);color:var(--on-matcha);font-weight:600}
.doc details summary{cursor:pointer}
@media (max-width:860px){
.app{grid-template-columns:minmax(0,1fr);grid-template-rows:minmax(0,1fr) auto}
.pane-list .main,.pane-detail .side,.pane-page .side{display:none}
.switch,.foot,.listbar .desk{display:none}
.desk{display:none !important}
.ltitle{display:block}
.back{display:flex}
.head{padding:6px 12px 8px 4px;min-height:0;align-items:flex-start}
.titles{padding-top:8px}
.head>.titles:first-child{padding-left:12px}
.titles h1{white-space:normal;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;font-size:16px}
.tchips{display:flex;flex:none;overflow-x:auto;gap:6px;padding:8px 16px;border-bottom:1px solid var(--line);background:var(--surface)}
.body{flex-direction:column;align-items:stretch}
.conv{padding:14px 16px 24px}
.meta{position:static;width:auto;border-left:0;border-top:1px solid var(--line);padding:16px}
.bar{display:flex;flex-direction:column;gap:8px;flex:none;padding:10px 16px;border-top:1px solid var(--line);background:var(--surface)}
.bar .ask{margin:0;padding:8px 10px;border-radius:10px;background:var(--matcha-wash);color:var(--matcha-ink);font-size:13px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.bar textarea{width:100%;height:56px;border:1px solid var(--line-strong);border-radius:10px;padding:8px 10px;background:var(--paper);resize:none}
.bar .buttons{display:flex;gap:8px}
.bar .buttons button{height:48px;font-size:15px}
.bar .buttons .quiet{flex:1;text-align:left;padding-left:4px}
.bar .buttons .primary{flex:none;width:180px}
.item{padding:14px 16px}
.fold{max-height:8em}
.side{border-right:0}
.pane-list .item[aria-current]{background:none;box-shadow:none}
.doc{padding:16px 16px 32px}
.tabbar{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));border-top:1px solid var(--line);background:var(--surface);padding:4px 0 env(safe-area-inset-bottom)}
.tabbar a{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1px;min-height:52px;font-size:11px;color:var(--muted);white-space:nowrap}
.tabbar a:hover{text-decoration:none}
.tabbar a[aria-current]{color:var(--matcha);font-weight:600}
.tabbar svg{width:22px;height:22px}
input,select,textarea{font-size:16px !important}
}
@media (prefers-reduced-motion:reduce){*{transition:none !important}}
`;

const icon = (path: string) =>
	html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${new Markup(path)}</svg>`;

const TABS: { section: Section; label: string; href: string; icon: string }[] =
	[
		{
			section: "review",
			label: "Review",
			href: "/",
			icon: '<circle cx="12" cy="8" r="4"></circle><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"></path>',
		},
		{
			section: "triage",
			label: "Triage",
			href: "/triage",
			icon: '<path d="M3 7h18M6 12h12M10 17h4"></path>',
		},
		{
			section: "doing",
			label: "Doing",
			href: "/doing",
			icon: '<path d="M3 12h4l3-7 4 14 3-7h4"></path>',
		},
		{
			section: "more",
			label: "More",
			href: "/more",
			icon: '<circle cx="5" cy="12" r="1.5"></circle><circle cx="12" cy="12" r="1.5"></circle><circle cx="19" cy="12" r="1.5"></circle>',
		},
	];

const countOf = (nav: Nav, section: Section) =>
	section === "more" ? null : nav[section];

const current = (on: boolean) => (on ? html` aria-current="page"` : "");

const switcher = (nav: Nav, section: Section) =>
	html`<div class="switch"><nav aria-label="一覧">${TABS.filter(
		(t) => t.section !== "more",
	).map((t) => {
		const n = countOf(nav, t.section) ?? 0;
		return html`<a href="${t.href}"${current(t.section === section)}>${t.label}<span class="count${t.section === "review" && n > 0 ? " hot" : ""}">${n}</span></a>`;
	})}</nav></div>`;

const tabbar = (nav: Nav, section: Section) =>
	html`<nav class="tabbar" aria-label="画面">${TABS.map((t) => {
		const n = countOf(nav, t.section);
		return html`<a href="${t.href}"${current(t.section === section)}>${icon(t.icon)}<span>${t.label}${n === null ? "" : html` <span class="count">${n}</span>`}</span></a>`;
	})}</nav>`;

export type MoreItem = "projects" | "sync" | "settings";

const MORE: { item: MoreItem; label: string; href: string }[] = [
	{ item: "projects", label: "プロジェクト", href: "/projects" },
	{ item: "sync", label: "同期", href: "/sync" },
	{ item: "settings", label: "設定", href: "/settings" },
];

const syncWarning = (nav: Nav) =>
	nav.syncWarnings > 0
		? html`<span class="warn">警告 ${nav.syncWarnings}</span>`
		: "";

/** More の画面では左ペインに同じリンクが並ぶので、下の帯には出さない */
const foot = (nav: Nav, section: Section, item?: MoreItem) =>
	html`<div class="foot"><span class="brand">chakai</span>${(
		section === "more" ? [] : MORE
	).map(
		(m) =>
			html`<a href="${m.href}"${current(m.item === item)}>${m.label}${m.item === "sync" ? syncWarning(nav) : ""}</a>`,
	)}</div>`;

/** More の中身。Mac では一覧の代わりに左ペインに、スマホでは画面いっぱいに出す */
export const moreMenu = (nav: Nav, item?: MoreItem) =>
	html`<nav class="menu" aria-label="その他">${MORE.map(
		(m) =>
			html`<a href="${m.href}"${current(m.item === item)}>${m.label}${m.item === "sync" ? syncWarning(nav) : ""}</a>`,
	)}</nav>`;

export type Shell = {
	title: string;
	nav: Nav;
	section: Section;
	pane: Pane;
	/** 左ペインの、切り替えと下の帯の間 */
	side: Markup;
	main: Markup;
	more?: MoreItem;
};

export const page = (s: Shell): string =>
	html`<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${s.title} - chakai</title>
<style>${new Markup(CSS)}</style>
</head>
<body class="pane-${s.pane}">
<div class="app">
<aside class="side">${switcher(s.nav, s.section)}${s.side}${foot(s.nav, s.section, s.more)}</aside>
<main class="main"><p id="alert" class="alert" role="alert" hidden></p>${s.main}</main>
${tabbar(s.nav, s.section)}
</div>
<script src="/assets/app.js"></script>
</body>
</html>`.value;
