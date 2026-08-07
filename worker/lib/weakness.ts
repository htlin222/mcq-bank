// 弱點分群的**確定性**路徑。
//
// 語意分群(cluster.ts + Vectorize)品質比較好,但它有一個致命的失敗模式:
// 索引沒有涵蓋到的題目會被靜默略過,而涵蓋不足時整頁就是空的 —— 使用者做了
// 一百題,看到的卻是「目前分不出明顯的弱點群」。實際發生過:回填停在
// 2026-07-19,而使用者最近的錯題全在之後才加入的 113/114 年,60 題裡一個
// 向量都沒有。
//
// 所以語意分群降級成「有就更好」,主題分群才是保底。輸入是 D1 的
// question_tags → tag_topics → video_topics 三段 join(白名單,不是
// question_tags 那 800 多個自由標籤 —— 直接 group by 會得到一堆噪音,
// 策展影片踩過這個坑)。
//
// 純函式:不碰 D1、不碰 Vectorize、不碰時間,所以可以測。

export type TopicRow = { slug: string; label: string; question_id: string };

export type WeakCluster = {
	label: string;
	size: number;
	/** 交錯練習的起點。 */
	anchor: string;
	question_ids: string[];
};

/**
 * @param rows  一題一標籤主題的展開列(同一題可能出現多次)
 * @param order 錯題 id,**最近答錯的排前面**。決定 anchor 取哪一題。
 */
export function groupByTopic(
	rows: TopicRow[],
	order: string[],
	opts: { min?: number; limit?: number } = {},
): WeakCluster[] {
	const min = opts.min ?? 2;
	const limit = opts.limit ?? 12;

	// 最近性排名。不在清單裡的排最後 —— 仍然算進群裡,只是不優先當 anchor。
	const rank = new Map<string, number>();
	order.forEach((id, i) => {
		if (!rank.has(id)) rank.set(id, i);
	});
	const rankOf = (id: string) => rank.get(id) ?? Number.POSITIVE_INFINITY;

	// Map 保插入順序,所以「第一個看到的」在 order 幫不上忙時是個穩定的退路。
	const bySlug = new Map<string, { label: string; ids: string[] }>();
	for (const r of rows) {
		if (!r?.slug || !r.question_id) continue;
		const g = bySlug.get(r.slug);
		if (!g) {
			bySlug.set(r.slug, { label: r.label || r.slug, ids: [r.question_id] });
		} else if (!g.ids.includes(r.question_id)) {
			// 同一題掛到同主題底下的好幾個標籤,只能算一次。
			g.ids.push(r.question_id);
		}
	}

	return [...bySlug.values()]
		.filter((g) => g.ids.length >= min)
		.map((g) => ({
			label: g.label,
			size: g.ids.length,
			anchor: g.ids.reduce((best, id) =>
				rankOf(id) < rankOf(best) ? id : best,
			),
			question_ids: g.ids,
		}))
		// 大的排前面;同大小依 label 排,否則同樣的輸入會給出不同的頁面順序。
		.sort((a, b) => b.size - a.size || a.label.localeCompare(b.label))
		.slice(0, limit);
}
