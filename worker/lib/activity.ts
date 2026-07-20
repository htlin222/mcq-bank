// 每日活動量(每天做了幾題),依 UTC+8 分日。heatmap 與讀書進度預估共用,
// 兩張卡片的數字才不會打架。
//
// 注意這裡的「一天」是 UTC+8 的午夜,和 worker/lib/due-window.ts 的
// `dayWindow`(凌晨 4 點 rollover,服務 FSRS 佇列)刻意不同 —— 這裡要和
// SQL 的 strftime '+8 hours' 完全一致,否則 heatmap 的格子和卡片的「今天」
// 會差一格。

import type { D1Database } from "@cloudflare/workers-types";

export const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000;

/** UTC+8 的今天,'YYYY-MM-DD'。與 SQL 的 '+8 hours' 修飾子同一套曆法。 */
export function todayInTaipei(nowMs: number): string {
	return new Date(nowMs + TAIPEI_OFFSET_MS).toISOString().slice(0, 10);
}

export type DayCount = { d: string; n: number };

/**
 * 每日作答數,依 UTC+8 分日。SQL 原封搬自 `GET /api/review/heatmap`。
 *
 * 來源:`attempts`(每答一題一列)+ `fsrs_review_logs`。
 *   * 不讀 review_progress.last_seen_at —— 那是會被覆寫的彙總列,一天做 10 題
 *     只會算成 1 次(PR #19 修掉的既有 bug)。
 *   * 不讀 exam_answers —— 模擬考的作答現在也會寫進 attempts,留著會重複計。
 *   * fsrs_review_logs 保留:沒有 `chosen` 的純 FSRS 評分不會進 attempts,
 *     拿掉會漏。有 `chosen` 的 Anki 複習會被兩邊都算到 —— 這是刻意接受的重疊,
 *     拿掉任一邊失去的都比修正的多。
 *
 * `attempts` 自 migration 0023 才開始,且歷史刻意未回填(把 times_seen=5
 * 展開成 5 個捏造的時間戳會污染真相來源),所以更早的日子是空的。
 */
export async function dailyActivity(
	db: D1Database,
	email: string,
	sinceMs: number,
): Promise<DayCount[]> {
	const { results } = await db
		.prepare(
			`WITH a AS (
         SELECT created_at AS ts FROM attempts
           WHERE user_email = ? AND created_at >= ?
         UNION ALL
         SELECT reviewed_at FROM fsrs_review_logs
           WHERE user_email = ? AND reviewed_at >= ?
       )
       SELECT strftime('%Y-%m-%d', ts / 1000, 'unixepoch', '+8 hours') AS d,
              COUNT(*) AS n
       FROM a
       WHERE ts IS NOT NULL
       GROUP BY d
       ORDER BY d`,
		)
		.bind(email, sinceMs, email, sinceMs)
		.all<DayCount>();
	return results;
}
