// Vectorize 有沒有回填,只看 describe() 的筆數。
//
// 不在這裡呼叫嵌入模型:那一趟是免費額度的成本,而「索引是空的」這件事
// describe() 已經回答了。describe 失敗(索引沒建)與筆數 0 是同一種狀態。

export function semanticIndexEmpty(
	info:
		| { vectorCount?: number | null; vectorsCount?: number | null }
		| null
		| undefined,
): boolean {
	if (!info) return true;
	// 正式型別是 vectorCount;目前綁定的 VectorizeIndex(beta)是 vectorsCount。
	const n = Number(info.vectorCount ?? info.vectorsCount);
	return !Number.isFinite(n) || n <= 0;
}
