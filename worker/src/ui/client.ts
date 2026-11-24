/**
 * 画面の書き込みは、この script が既存の REST を呼んで行う。
 * HTML の form は PATCH も PUT も JSON も送れないので、ここだけ script にしている
 */
export const CLIENT_JS = `"use strict";
(() => {
	const alertBox = document.getElementById("alert");
	const showError = (message) => {
		alertBox.textContent = message;
		alertBox.hidden = false;
		alertBox.scrollIntoView({ block: "nearest" });
	};

	// 本文の無い書き込みも、REST は Content-Type が JSON のものだけを受ける。
	// next があれば、書けた後にそこを開く（返事や仕分けの後に、一覧の次のタスクへ進む）
	const send = async (method, path, body, next) => {
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
		if (res.ok) {
			if (next) location.assign(next);
			else location.reload();
			return true;
		}
		let message = "更新できなかった（" + res.status + "）";
		try {
			const json = await res.json();
			if (json.message) message = json.message;
		} catch {}
		showError(message);
		return false;
	};

	const taskPath = (id) => "/v1/tasks/" + encodeURIComponent(id);

	// 状態を変えたタスクは、今の一覧から外れて見失いやすい。
	// 直前の変更を覚えておき、次の画面で「何をどうしたか」と「元に戻す」を出す
	const LAST = "chakai:last-change";
	const remember = (change) => {
		try {
			sessionStorage.setItem(LAST, JSON.stringify(change));
		} catch {}
	};
	const pageTitle = () =>
		document.querySelector(".titles h1")?.textContent ?? "タスク";

	const showLastChange = () => {
		let change;
		try {
			change = JSON.parse(sessionStorage.getItem(LAST) ?? "null");
			sessionStorage.removeItem(LAST);
		} catch {}
		if (!change || !change.id || change.from === change.to) return;
		const bar = document.createElement("div");
		bar.className = "toast";
		bar.setAttribute("role", "status");
		const text = document.createElement("span");
		text.className = "what";
		text.textContent = "「" + change.title + "」を " + change.to + " にした";
		const open = document.createElement("a");
		open.href = "/tasks/" + encodeURIComponent(change.id);
		open.textContent = "開く";
		const undo = document.createElement("button");
		undo.type = "button";
		undo.textContent = "元に戻す（" + change.from + "）";
		undo.addEventListener("click", async () => {
			undo.disabled = true;
			const body = { state: change.from, note: "元に戻した" };
			if (change.from === "review") body.waiting_on = change.waiting || "元に戻した";
			const done = await patch(change.id, body, open.href);
			if (!done) undo.disabled = false;
		});
		bar.append(text, open, undo);
		document.getElementById("alert")?.after(bar);
	};
	const patch = (id, body, next) => send("PATCH", taskPath(id), body, next);

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
		remember({
			id,
			title: select.closest(".row")?.querySelector(".title")?.textContent ?? "タスク",
			from: select.dataset.current,
			to: select.value,
			waiting: select.dataset.waiting,
		});
		if (!(await patch(id, body))) {
			select.disabled = false;
			select.value = select.dataset.current;
		}
	});

	document.addEventListener("click", async (event) => {
		if (!(event.target instanceof Element)) return;
		const button = event.target.closest("button[data-move]");
		if (!button) return;
		button.disabled = true;
		const moved = await patch(button.dataset.move, {
			order: { [button.dataset.dir]: button.dataset.anchor },
		});
		if (!moved) button.disabled = false;
	});

	document.addEventListener("click", async (event) => {
		if (!(event.target instanceof Element)) return;
		const button = event.target.closest("button[data-triage]");
		if (!button) return;
		const id = button.dataset.triage;
		const action = button.dataset.action;
		const siblings = document.querySelectorAll("button[data-triage]");
		for (const b of siblings) b.disabled = true;
		const next = button.dataset.next;
		if (action !== "keep") {
			remember({ id, title: pageTitle(), from: "backlog", to: action });
		}
		const done =
			action === "keep"
				? await send("POST", taskPath(id) + "/triage", undefined, next)
				: await patch(id, { state: action }, next);
		if (!done) for (const b of siblings) b.disabled = false;
	});

	// 返事を空で送ったときの一言。review を出るには note が要り、
	// 「このまま進めてよい」がいちばん多い返事なので、これを既定にする
	const DEFAULT_REPLY = "それで進めて";

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
		remember({
			id: form.dataset.reply,
			title: pageTitle(),
			from: "review",
			to: submitter.value,
			waiting: form.dataset.question,
		});
		const buttons = document.querySelectorAll(
			"button[name=to], [data-reply] button",
		);
		for (const b of buttons) b.disabled = true;
		const sent = await patch(
			form.dataset.reply,
			{ state: submitter.value, note },
			form.dataset.next,
		);
		if (!sent) for (const b of buttons) b.disabled = false;
	});

	showLastChange();

	document.addEventListener("submit", (event) => {
		const form = event.target;
		if (!(form instanceof HTMLFormElement) || !("search" in form.dataset)) return;
		event.preventDefault();
		const q = form.elements.namedItem("q").value.trim();
		location.assign(q ? "/recent?q=" + encodeURIComponent(q) : "/recent");
	});

	// 長い本文は畳んでおき、はみ出したときだけ「全文を読む」と「畳む」を切り替えられるようにする
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

	const form = document.getElementById("edit");
	if (form) {
		const state = form.elements.namedItem("state");
		const waitingOn = form.elements.namedItem("waiting_on");
		const waitingRow = document.getElementById("waiting-row");
		const note = form.elements.namedItem("note");
		const syncWaiting = () => {
			const review = state.value === "review";
			waitingRow.hidden = !review;
			waitingOn.required = review;
			note.required = form.dataset.state === "review" && !review;
		};
		state.addEventListener("change", syncWaiting);
		syncWaiting();

		form.addEventListener("submit", async (event) => {
			event.preventDefault();
			const labels = [...form.querySelectorAll("input[name=label]:checked")].map(
				(input) => input.value,
			);
			for (const name of form.elements.namedItem("new_labels").value.split(/[,、]/)) {
				if (name.trim()) labels.push(name.trim());
			}
			// 開いた後に他の actor が変えた欄を、古い値で上書きしないよう、変えた欄だけを送る
			const body = {};
			const chosen = [...new Set(labels)].sort();
			if (state.value !== form.dataset.state) body.state = state.value;
			const assignee = form.elements.namedItem("assignee_id").value;
			if (assignee !== form.dataset.assignee) body.assignee_id = assignee || null;
			if (JSON.stringify(chosen) !== form.dataset.labels) body.labels = chosen;
			if (
				state.value === "review" &&
				(body.state || waitingOn.value.trim() !== form.dataset.waiting)
			) {
				body.waiting_on = waitingOn.value.trim();
			}
			if (note.value.trim()) body.note = note.value.trim();
			if (Object.keys(body).length === 0) {
				showError("変えた欄が無い");
				return;
			}
			const submit = form.querySelector("button[type=submit]");
			submit.disabled = true;
			if (body.state) {
				remember({
					id: form.dataset.task,
					title: pageTitle(),
					from: form.dataset.state,
					to: body.state,
					waiting: form.dataset.waiting,
				});
			}
			if (!(await patch(form.dataset.task, body))) submit.disabled = false;
		});
	}
})();
`;
