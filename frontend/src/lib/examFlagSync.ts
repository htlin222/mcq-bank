// 考試標記(mark for review)的本機/server 對帳。逐題 last-write-wins:
// 本機較新就回報要上推,server 較新(或時間戳相等)就採 server。
// 純函式,不碰 DOM/網路 —— 比照 highlightSync.ts 的 pickHighlight。

export type LocalFlag = { flagged: boolean; t?: number };
export type LocalFlags = Record<string, LocalFlag>;
export type ServerFlag = {
	question_id: string;
	flagged: boolean;
	flagged_at: number | null;
};
export type MergedFlags = {
	flags: Record<string, { flagged: boolean; t: number }>;
	/** 本機較新、需要 PUT 上去的 question_id(已排序,方便測試與重試) */
	push: string[];
};

export function mergeFlags(
	local: LocalFlags,
	server: ServerFlag[],
): MergedFlags {
	const flags: MergedFlags["flags"] = {};
	const push: string[] = [];

	// server 先落底:0028 之前的列沒有 flagged_at → 視為 0,任何本機時間戳都較新。
	for (const s of server) {
		flags[s.question_id] = { flagged: s.flagged, t: s.flagged_at ?? 0 };
	}

	for (const [qid, l] of Object.entries(local)) {
		const lt = l.t ?? 0; // 舊本機資料沒有時間戳 → 最舊
		const cur = flags[qid];
		if (!cur) {
			flags[qid] = { flagged: l.flagged, t: lt };
			// 本機的「未標記」就是預設值,推上去只是白花一次寫入。
			if (l.flagged) push.push(qid);
		} else if (lt > cur.t) {
			flags[qid] = { flagged: l.flagged, t: lt };
			push.push(qid);
		}
	}

	push.sort();
	return { flags, push };
}
