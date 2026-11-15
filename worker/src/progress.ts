export type Progress = { done: number; total: number };

type Node = { id: string; parentId: string | null; state: string };

/**
 * 子を持つタスクごとに、子孫の末端タスクのうち done の数と、数える末端の数を返す。
 * 中間のタスクは子が片付くまで done にならず二重に数えてしまうので、末端だけを数える。
 * dropped の枝は、やめた作業なので分母からも外す
 */
export const progressOf = (nodes: Node[]): Map<string, Progress> => {
	const children = new Map<string, Node[]>();
	for (const n of nodes) {
		if (n.parentId === null) continue;
		children.set(n.parentId, [...(children.get(n.parentId) ?? []), n]);
	}
	const memo = new Map<string, Progress>();
	const visiting = new Set<string>();
	const leavesUnder = (id: string): Progress => {
		const cached = memo.get(id);
		if (cached) return cached;
		const sum: Progress = { done: 0, total: 0 };
		// 親が自分に戻る輪があっても止まるようにする
		if (visiting.has(id)) return sum;
		visiting.add(id);
		for (const child of children.get(id) ?? []) {
			if (child.state === "dropped") continue;
			if (children.has(child.id)) {
				const below = leavesUnder(child.id);
				sum.done += below.done;
				sum.total += below.total;
			} else {
				sum.total++;
				if (child.state === "done") sum.done++;
			}
		}
		visiting.delete(id);
		memo.set(id, sum);
		return sum;
	};
	const result = new Map<string, Progress>();
	for (const n of nodes) {
		if (children.has(n.id)) result.set(n.id, leavesUnder(n.id));
	}
	return result;
};
