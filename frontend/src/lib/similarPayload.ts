// /api/questions/:id/similar 的回應。
// 新形狀是 { items, index_empty }。舊的純陣列(以及 e2e 缺 fixture 時的 {})
// 都要收成清單,缺欄位不等於「索引是空的」—— 那句話只能在伺服器明講時出現。

export const SEMANTIC_INDEX_EMPTY = "語意索引尚未回填";

export function readSimilarPayload(raw: unknown): {
	items: unknown[];
	indexEmpty: boolean;
} {
	if (Array.isArray(raw)) return { items: raw, indexEmpty: false };
	if (raw && typeof raw === "object") {
		const o = raw as { items?: unknown; index_empty?: unknown };
		return {
			items: Array.isArray(o.items) ? o.items : [],
			indexEmpty: o.index_empty === true,
		};
	}
	return { items: [], indexEmpty: false };
}
