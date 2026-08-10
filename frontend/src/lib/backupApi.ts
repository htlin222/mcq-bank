// 「備份我的紀錄」的抓取端(#123)。分頁靠 keyset 游標,一路撈到 `next` 為 null。
//
// 這裡不碰 zip、也不決定目錄結構(那在 backupLayout.ts,是純函式)。分工的理由
// 是後者要能單獨測 —— 「一題的作答/信心/筆記有沒有併對」跟網路無關。

import { api } from "./api";
import type { BackupMeta, BackupRows } from "./backupLayout";

export type BackupManifest = BackupMeta & {
	counts: Record<string, number>;
};

type Page<T> = { rows: T[]; next: string | null };

export function fetchManifest(): Promise<BackupManifest> {
	return api.get<BackupManifest>("/api/backup/manifest");
}

/**
 * 把一支端點整個撈完。`onRow` 回報累計列數,呼叫端拿它推進度條。
 *
 * 沒有設頁數上限:上限會在資料變多時**靜靜**把備份截斷,而使用者看到的仍是
 * 一個成功下載的檔案。真的跑不完應該是失敗,不是悄悄少一半。
 */
async function drain<T>(
	path: string,
	onRow?: (total: number) => void,
): Promise<T[]> {
	const out: T[] = [];
	let after = "";
	for (;;) {
		const q = after ? `?after=${encodeURIComponent(after)}` : "";
		const page = await api.get<Page<T>>(`/api/backup/${path}${q}`);
		// 形狀不對就明講。少了這一行,回應是 `{}` 時會炸在 `push(...undefined)`,
		// 使用者看到的是「Cannot read properties of undefined」。
		if (!Array.isArray(page?.rows)) {
			throw new Error(`備份中止:${path} 的回應沒有 rows 陣列`);
		}
		out.push(...page.rows);
		onRow?.(out.length);
		if (!page.next) return out;
		// 游標沒有前進代表伺服器端的 ORDER BY 跟游標欄位對不上 —— 再打下去
		// 就是無窮迴圈。寧可炸掉也不要讓使用者盯著一個永遠跑不完的進度條。
		if (page.next === after) {
			throw new Error(`備份中止:${path} 的分頁游標沒有前進(${after})`);
		}
		after = page.next;
	}
}

/** 進度回報:哪一段、已經拿到幾列。 */
export type BackupProgress = (label: string, rows: number) => void;

const PARTS: { key: keyof BackupRows; path: string; label: string }[] = [
	{ key: "questions", path: "questions", label: "題目與共筆詳解" },
	{ key: "progress", path: "progress", label: "複習進度" },
	{ key: "attempts", path: "attempts", label: "作答紀錄" },
	{ key: "confidence", path: "confidence", label: "信心紀錄" },
	{ key: "notes", path: "notes", label: "題目筆記" },
	{ key: "highlights", path: "highlights", label: "畫記" },
	{ key: "bookmarks", path: "bookmarks", label: "收藏" },
	{ key: "exams", path: "exams", label: "全真模擬" },
	{ key: "examAnswers", path: "exam-answers", label: "模擬考作答" },
	{ key: "lectureAnnotations", path: "lecture-annotations", label: "講義畫記" },
	{ key: "lectureNotes", path: "lecture-notes", label: "講義筆記" },
	{ key: "freeNotes", path: "free-notes", label: "其他筆記" },
];

/**
 * 循序抓完所有區塊。刻意**不併發**:一個人的備份是幾十 MB,十二支同時打會讓
 * 這個帳號自己把 D1 的並行度吃光,而其他人正在用同一個 Worker。慢一點沒關係,
 * 這是使用者主動按下、看著進度條等的操作。
 */
export async function fetchAllRows(onProgress?: BackupProgress): Promise<BackupRows> {
	const rows = {} as BackupRows;
	for (const p of PARTS) {
		onProgress?.(p.label, 0);
		rows[p.key] = await drain(p.path, (n) => onProgress?.(p.label, n));
	}
	return rows;
}
