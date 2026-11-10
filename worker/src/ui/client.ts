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

	// 本文の無い書き込みも、REST は Content-Type が JSON のものだけを受ける
	const send = async (method, path, body) => {
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
			location.reload();
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
	const patch = (id, body) => send("PATCH", taskPath(id), body);

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
		}
		select.disabled = true;
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
		const siblings = button.parentElement.querySelectorAll("button");
		for (const b of siblings) b.disabled = true;
		const done =
			action === "keep"
				? await send("POST", taskPath(id) + "/triage")
				: await patch(id, { state: action });
		if (!done) for (const b of siblings) b.disabled = false;
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
		const syncWaiting = () => {
			const review = state.value === "review";
			waitingRow.hidden = !review;
			waitingOn.required = review;
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
			if (Object.keys(body).length === 0) {
				showError("変えた欄が無い");
				return;
			}
			const submit = form.querySelector("button[type=submit]");
			submit.disabled = true;
			if (!(await patch(form.dataset.task, body))) submit.disabled = false;
		});
	}
})();
`;
