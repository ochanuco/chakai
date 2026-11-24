/**
 * 画面の書き込みは、この script が既存の REST を呼んで行う。
 * HTML の form は PATCH も PUT も JSON も送れないので、ここだけ script にしている
 */
export const CLIENT_JS = `"use strict";
(() => {
	const showError = (message) => {
		const alertBox = document.getElementById("alert");
		if (!alertBox) return;
		alertBox.textContent = message;
		alertBox.hidden = false;
		alertBox.scrollIntoView({ block: "nearest" });
	};

	// 本文の無い書き込みも、REST は Content-Type が JSON のものだけを受ける
	const request = async (method, path, body) => {
		let res;
		try {
			res = await fetch(path, {
				method,
				headers: { "content-type": "application/json" },
				body: body === undefined ? undefined : JSON.stringify(body),
			});
		} catch {
			showError("通信できなかった。ページを読み直して、もう一度試す");
			return false;
		}
		if (res.ok) return true;
		let message = "更新できなかった（" + res.status + "）";
		try {
			const json = await res.json();
			if (json.message) message = json.message;
		} catch {}
		showError(message);
		return false;
	};

	/** 書けたら画面を読み直す。タスクの画面の外（プロジェクト・設定）で使う */
	const send = async (method, path, body) => {
		const done = await request(method, path, body);
		if (done) location.reload();
		return done;
	};

	const taskPath = (id) => "/v1/tasks/" + encodeURIComponent(id);
	const patch = (id, body) => request("PATCH", taskPath(id), body);

	const pageTitle = () =>
		document.querySelector(".titles h1")?.textContent ?? "タスク";

	// --- 変えた後の知らせ ---

	const toast = (change, next) => {
		const bar = document.createElement("div");
		bar.className = "toast";
		bar.setAttribute("role", "status");
		const text = document.createElement("span");
		text.className = "what";
		text.textContent = change.undone
			? "「" + change.title + "」を " + change.from + " に戻した"
			: change.to
				? "「" + change.title + "」を " + change.to + " にした"
				: "「" + change.title + "」を変えた";
		bar.append(text);
		if (!change.undone && change.to && change.from !== change.to) {
			const undo = document.createElement("button");
			undo.type = "button";
			undo.textContent = "元に戻す";
			undo.addEventListener("click", async () => {
				undo.disabled = true;
				const body = { state: change.from, note: "元に戻した" };
				if (change.from === "review") {
					body.waiting_on = change.waiting || "元に戻した";
				}
				if (await patch(change.id, body)) {
					await refresh({ ...change, undone: true });
				} else {
					undo.disabled = false;
				}
			});
			bar.append(undo);
		}
		if (next) {
			const go = document.createElement("a");
			go.href = next;
			go.textContent = "次へ";
			bar.append(go);
		}
		document.getElementById("alert")?.after(bar);
	};

	// タスクの画面の外で変えたとき（プロジェクトの画面の状態の選択）は、
	// 読み直した後の画面で知らせる
	const LAST = "chakai:last-change";
	const rememberForNextPage = (change) => {
		try {
			sessionStorage.setItem(LAST, JSON.stringify(change));
		} catch {}
	};
	const showRemembered = () => {
		let change;
		try {
			change = JSON.parse(sessionStorage.getItem(LAST) ?? "null");
			sessionStorage.removeItem(LAST);
		} catch {}
		if (change?.id && change.from !== change.to) toast(change, null);
	};

	/**
	 * タスクを変えた後、そのタスクに留まったまま中身を差し替える。
	 * 一覧の行は消さずに移った先を印で示し、画面がまるごと入れ替わって見失うのを避ける
	 */
	const refresh = async (change) => {
		const row = document.querySelector("a[data-row][aria-current]");
		const from = row
			? new URL(row.href).searchParams.get("from")
			: new URLSearchParams(location.search).get("from");
		const url =
			"/tasks/" + encodeURIComponent(change.id) + (from ? "?from=" + from : "");
		let doc;
		try {
			const res = await fetch(url);
			doc = new DOMParser().parseFromString(await res.text(), "text/html");
		} catch {
			location.assign(url);
			return;
		}
		const main = doc.querySelector(".main");
		if (!main) {
			location.assign(url);
			return;
		}
		document.querySelector(".main")?.replaceWith(main);
		for (const selector of [".switch", ".tabbar"]) {
			const fresh = doc.querySelector(selector);
			if (fresh) document.querySelector(selector)?.replaceWith(fresh);
		}
		row?.querySelector(".moved")?.remove();
		if (row && change.to && !change.undone && change.from !== change.to) {
			const moved = document.createElement("span");
			moved.className = "moved";
			moved.textContent = "→ " + change.to;
			row.querySelector(".top")?.append(moved);
		}
		history.replaceState(null, "", url);
		document.body.className = "pane-detail";
		initFolds();
		toast(change, main.querySelector(".head")?.dataset.next ?? null);
	};

	// --- タスクの画面の書き込み ---

	// 返事を空で送ったときの一言。review を出るには note が要り、
	// 「このまま進めてよい」がいちばん多い返事なので、これを既定にする
	const DEFAULT_REPLY = "それで進めて";

	const disableAll = (selector, on) => {
		for (const b of document.querySelectorAll(selector)) b.disabled = on;
	};

	document.addEventListener("submit", async (event) => {
		const form = event.target;
		if (!(form instanceof HTMLFormElement) || !form.dataset.reply) return;
		event.preventDefault();
		const submitter = event.submitter;
		if (!submitter) return;
		let note = form.elements.namedItem("answer").value.trim();
		if (!note) {
			if (!("default" in submitter.dataset)) {
				showError(submitter.textContent + " には一言を書く。履歴に残り、AI が読む");
				return;
			}
			note = DEFAULT_REPLY;
		}
		const buttons = "button[name=to], [data-reply] button";
		disableAll(buttons, true);
		const change = {
			id: form.dataset.reply,
			title: pageTitle(),
			from: "review",
			to: submitter.value,
			waiting: form.dataset.question,
		};
		if (await patch(change.id, { state: change.to, note })) {
			await refresh(change);
		} else {
			disableAll(buttons, false);
		}
	});

	document.addEventListener("click", async (event) => {
		if (!(event.target instanceof Element)) return;
		const button = event.target.closest("button[data-triage]");
		if (!button) return;
		const id = button.dataset.triage;
		const action = button.dataset.action;
		disableAll("button[data-triage]", true);
		const done =
			action === "keep"
				? await request("POST", taskPath(id) + "/triage")
				: await patch(id, { state: action });
		if (done) {
			await refresh({
				id,
				title: pageTitle(),
				from: "backlog",
				to: action === "keep" ? "backlog" : action,
			});
		} else {
			disableAll("button[data-triage]", false);
		}
	});

	// 右の列の「変える」。選んだらその場で書く
	document.addEventListener("click", async (event) => {
		if (!(event.target instanceof Element)) return;
		const button = event.target.closest("[data-pick] button[data-value]");
		if (!button) return;
		const pick = button.closest("[data-pick]");
		const id = pick.dataset.task;
		const value = button.dataset.value;
		let body;
		let change = { id, title: pageTitle(), from: null, to: null };
		if (pick.dataset.pick === "state") {
			const current = pick.dataset.current;
			if (value === current) return;
			const text = pick.querySelector("textarea").value.trim();
			body = { state: value };
			if (value === "review") {
				if (!text) {
					showError("review にするときは、問いを書く");
					return;
				}
				body.waiting_on = text;
			} else if (current === "review" && !text) {
				showError("review から出すときは、判断の一言を書く");
				return;
			}
			if (text && value !== "review") body.note = text;
			change = { ...change, from: current, to: value, waiting: pick.dataset.waiting };
		} else if (pick.dataset.pick === "assignee") {
			if (value === pick.dataset.current) return;
			body = { assignee_id: value || null };
		} else {
			const labels = new Set(JSON.parse(pick.dataset.current));
			if (labels.has(value)) labels.delete(value);
			else labels.add(value);
			body = { labels: [...labels].sort() };
		}
		disableAll("[data-pick] button", true);
		if (await patch(id, body)) {
			await refresh(change);
		} else {
			disableAll("[data-pick] button", false);
		}
	});

	document.addEventListener("keydown", async (event) => {
		const input = event.target;
		if (
			event.key !== "Enter" ||
			event.isComposing ||
			!(input instanceof HTMLInputElement) ||
			input.name !== "new" ||
			!input.closest('[data-pick="labels"]')
		) {
			return;
		}
		event.preventDefault();
		const pick = input.closest("[data-pick]");
		const added = input.value.split(/[,、]/).map((s) => s.trim()).filter(Boolean);
		if (added.length === 0) return;
		const labels = [...new Set([...JSON.parse(pick.dataset.current), ...added])].sort();
		input.disabled = true;
		if (await patch(pick.dataset.task, { labels })) {
			await refresh({ id: pick.dataset.task, title: pageTitle(), from: null, to: null });
		} else {
			input.disabled = false;
		}
	});

	// --- プロジェクトの画面 ---

	document.addEventListener("change", async (event) => {
		const select = event.target;
		if (!(select instanceof HTMLSelectElement)) return;
		const id = select.dataset.quickState;
		if (!id) return;
		const body = { state: select.value };
		if (select.value === "review") {
			const waitingOn = (prompt("owner に仰ぐ内容（waiting_on）") ?? "").trim();
			if (!waitingOn) {
				select.value = select.dataset.current;
				return;
			}
			body.waiting_on = waitingOn;
		} else if (select.dataset.current === "review") {
			const note = (prompt("判断（note）") ?? "").trim();
			if (!note) {
				select.value = select.dataset.current;
				return;
			}
			body.note = note;
		}
		select.disabled = true;
		rememberForNextPage({
			id,
			title: select.closest(".row")?.querySelector(".title")?.textContent ?? "タスク",
			from: select.dataset.current,
			to: select.value,
			waiting: select.dataset.waiting,
		});
		if (!(await send("PATCH", taskPath(id), body))) {
			select.disabled = false;
			select.value = select.dataset.current;
		}
	});

	document.addEventListener("click", async (event) => {
		if (!(event.target instanceof Element)) return;
		const button = event.target.closest("button[data-move]");
		if (!button) return;
		button.disabled = true;
		const moved = await send("PATCH", taskPath(button.dataset.move), {
			order: { [button.dataset.dir]: button.dataset.anchor },
		});
		if (!moved) button.disabled = false;
	});

	// --- 設定 ---

	const putSetting = async (form, value) => {
		const buttons = form.querySelectorAll("button");
		for (const b of buttons) b.disabled = true;
		const saved = await send(
			"PUT",
			"/v1/settings/" + encodeURIComponent(form.dataset.settingScope),
			{ key: form.dataset.key, value },
		);
		if (!saved) for (const b of buttons) b.disabled = false;
	};

	document.addEventListener("submit", (event) => {
		const form = event.target;
		if (!(form instanceof HTMLFormElement) || !form.dataset.settingScope) return;
		event.preventDefault();
		// 空の欄を 0 として書かないよう、数として読めたときだけ送る
		const value = form.elements.namedItem("value").valueAsNumber;
		if (!Number.isInteger(value) || value < 0 || value > 20) {
			showError("0 から 20 の整数を入れる");
			return;
		}
		putSetting(form, value);
	});

	document.addEventListener("click", (event) => {
		if (!(event.target instanceof Element)) return;
		const button = event.target.closest("button[data-setting-reset]");
		if (button) putSetting(button.closest("form"), null);
	});

	// --- 一覧・検索・キーボード ---

	document.addEventListener("submit", (event) => {
		const form = event.target;
		if (!(form instanceof HTMLFormElement) || !("search" in form.dataset)) return;
		event.preventDefault();
		const q = form.elements.namedItem("q").value.trim();
		location.assign(q ? "/recent?q=" + encodeURIComponent(q) : "/recent");
	});

	const typing = (el) =>
		el instanceof HTMLElement &&
		(el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));

	document.addEventListener("keydown", (event) => {
		// ⌘Enter / Ctrl+Enter で、返事を Reply として送る
		if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
			const form = event.target instanceof Element && event.target.closest("form[data-reply]");
			if (!form) return;
			event.preventDefault();
			const button =
				form.querySelector("[data-default]") ??
				document.querySelector('button[form="' + form.id + '"][data-default]');
			if (button) form.requestSubmit(button);
			return;
		}
		// j / k で一覧の次・前のタスクを開く
		if (event.metaKey || event.ctrlKey || event.altKey || typing(event.target)) return;
		if (event.key !== "j" && event.key !== "k") return;
		const rows = [...document.querySelectorAll("a[data-row]")];
		if (rows.length === 0) return;
		const at = rows.findIndex((r) => r.hasAttribute("aria-current"));
		const to = at < 0 ? rows[0] : rows[at + (event.key === "j" ? 1 : -1)];
		if (to) location.assign(to.href);
	});

	// 長い本文は畳んでおき、はみ出したときだけ「全文を読む」と「畳む」を切り替えられるようにする
	const initFolds = () => {
		for (const body of document.querySelectorAll("[data-fold]")) {
			const button = body.nextElementSibling;
			if (body.scrollHeight <= body.clientHeight + 4) {
				body.classList.remove("fold");
			} else if (button?.hasAttribute("data-unfold")) {
				button.hidden = false;
				button.addEventListener("click", () => {
					const folded = body.classList.toggle("fold");
					button.textContent = folded ? "全文を読む" : "畳む";
					if (folded) body.closest("article")?.scrollIntoView({ block: "nearest" });
				});
			}
		}
	};

	initFolds();
	showRemembered();
})();
`;
