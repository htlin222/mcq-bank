import { api } from "./api";
import { createQuestionStore, type QuestionStore } from "./questionStore";

export type Comment = {
	id: string;
	question_id: string;
	parent_id: string | null;
	author_email: string;
	display_name: string;
	avatar_key: string | null;
	content_json: string;
	created_at: number;
	helpful_count: number;
	voted_by_me: 0 | 1;
	// 該題有 status='promoted' 的挑戰,且本留言作者就是提案人 —— 社群已用
	// 行動認證過這個人的判斷,「最有幫助」時置頂。
	adopted: 0 | 1;
};

/**
 * 討論串的應用層快取。做法與失效時機完全比照 `questionCache`(見
 * `questionStore.ts` 的說明),因為病灶是同一個:切到「討論串」分頁 → 元件掛載
 * → 抓一次;切走 → 卸載;切回來 → 再抓一次。量過:同一題來回切三圈,留言端點
 * 被打了四次,而中間沒有任何人發言。
 *
 * ttl 60s、過期不丟(先畫舊的、背景重抓)—— 留言是別人隨時可能新增的內容,但
 * 「先看到上一秒的討論」永遠好過「盯著骨架等」。
 *
 * **失效寫在這個模組自己的變更函式裡**,不交給呼叫端記得。漏掉的症狀是「發完
 * 言、切走再切回來,自己那則不見了」——無聲,而且只有換分頁才看得到。
 */
export const commentCache: QuestionStore<Comment[]> = createQuestionStore<
	Comment[]
>((questionId) => api.get<Comment[]>(`/api/questions/${questionId}/comments`), {
	max: 40,
	ttlMs: 60_000,
});

/**
 * 這個 session 裡「使用者自己動過留言」的題目。
 *
 * 存在的理由是一個很容易錯過的互動:`seedEmptyComments()` 靠題目 payload 的
 * `comment_count` 判斷「這題沒有留言」,而那份 payload 是快取來的 —— 使用者剛發
 * 完言,它仍然寫著 0。少了這道閘,發完言切走再切回來,會把自己剛寫的那則蓋成
 * 空陣列,而且無聲。動過的題目一律走真的請求。
 */
const locallyMutated = new Set<string>();

/**
 * 大多數題目底下一則留言都沒有,而題目 payload 已經把這件事講了。零則就直接
 * 把空陣列寫進快取:點開「討論串」是同步命中,一次網路都不發。
 *
 * 只在**完全沒有快取**時才寫 —— 有快取的話那份比 `comment_count` 新。
 */
export function seedEmptyComments(questionId: string): void {
	if (locallyMutated.has(questionId)) return;
	if (commentCache.peek(questionId)) return;
	commentCache.set(questionId, []);
}

function markMutated(questionId: string): void {
	locallyMutated.add(questionId);
	commentCache.invalidate(questionId);
}

export async function postComment(
	questionId: string,
	body: { content_json: any; parent_id?: string },
	idempotencyKey: string,
): Promise<void> {
	await api.post(`/api/questions/${questionId}/comments`, body, idempotencyKey);
	markMutated(questionId);
}

export async function editComment(
	questionId: string,
	commentId: string,
	content_json: any,
): Promise<void> {
	await api.patch(`/api/questions/${questionId}/comments/${commentId}`, {
		content_json,
	});
	markMutated(questionId);
}

export async function deleteComment(
	questionId: string,
	commentId: string,
): Promise<void> {
	await api.del(`/api/questions/${questionId}/comments/${commentId}`);
	markMutated(questionId);
}

/**
 * 「有幫助」是樂觀更新,呼叫端只動自己的 state、不重抓整串(重抓會把展開中的
 * 回覆框與編輯草稿一併重置)。但快取裡那份的票數就過期了,所以這裡順手把它一起
 * 改掉 —— 否則切走再切回來,票數會倒退回按之前的數字。
 */
export async function toggleHelpful(
	questionId: string,
	commentId: string,
	wasMine: boolean,
): Promise<{ helpful_count: number }> {
	const r = wasMine
		? await api.del<{ helpful_count: number }>(
				`/api/comments/${commentId}/helpful`,
			)
		: await api.post<{ helpful_count: number }>(
				`/api/comments/${commentId}/helpful`,
				{},
			);
	const cached = commentCache.peek(questionId);
	if (cached) {
		commentCache.set(
			questionId,
			cached.map((c) =>
				c.id === commentId
					? {
							...c,
							helpful_count: r.helpful_count,
							voted_by_me: wasMine ? 0 : 1,
						}
					: c,
			),
		);
	}
	return r;
}
