/**
 * 画面の書き込みは、この script が既存の REST（PATCH /v1/tasks/:id）を呼んで行う。
 * HTML の form は PATCH も JSON も送れないので、ここだけ script にしている
 */
export const CLIENT_JS = `"use strict";
(() => {
	const alertBox = document.getElementById("alert");
	const showError = (message) => {
		alertBox.textContent = message;
		alertBox.hidden = false;
		alertBox.scrollIntoView({ block: "nearest" });
	};

	const patch = async (id, body) => {
		let res;
		try {
			res = await fetch("/v1/tasks/" + encodeURIComponent(id), {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
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
			const body = {
				state: state.value,
				assignee_id: form.elements.namedItem("assignee_id").value || null,
				labels: [...new Set(labels)],
			};
			if (state.value === "review") body.waiting_on = waitingOn.value.trim();
			const submit = form.querySelector("button[type=submit]");
			submit.disabled = true;
			if (!(await patch(form.dataset.task, body))) submit.disabled = false;
		});
	}
})();
`;
