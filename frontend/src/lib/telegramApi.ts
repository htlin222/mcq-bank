import { useEffect, useState } from "react";
import { api } from "./api";

// Telegram 綁定狀態 + 「存到 Telegram」。
//
// 狀態被兩處共用:個人頁的綁定卡片,和選字工具列的第四顆按鈕。工具列每次選取
// 都會重建,所以狀態快取在模組層(一個 session 一次請求),不是元件 state。

export type TgStatus = {
	/** bot 有設 token + username(伺服器端)。false 時整個功能不存在。 */
	configured: boolean;
	bot_username: string | null;
	/** 這個帳號已綁過某個 Telegram chat。 */
	linked: boolean;
	subscribed: boolean;
	username: string | null;
};

let cached: Promise<TgStatus | null> | null = null;

/**
 * 取綁定狀態。預設吃模組層快取 —— 綁定狀態在一次 session 內幾乎不變,而選字
 * 工具列會問很多次。`force` 用在剛做完綁定/解綁、或輪詢等待使用者在 Telegram
 * 那頭按 START 時。
 *
 * 請求失敗回 null(未登入、離線),呼叫端一律當成「沒有這個功能」。
 */
export function tgStatus(force = false): Promise<TgStatus | null> {
	if (force || !cached) {
		cached = api.get<TgStatus>("/api/telegram/status").catch(() => null);
	}
	return cached;
}

export function invalidateTgStatus(): void {
	cached = null;
}

/** 已綁定才回 true;還在查、查失敗、未綁定都是 false。 */
export function useTgLinked(): boolean {
	const [linked, setLinked] = useState(false);
	useEffect(() => {
		let alive = true;
		tgStatus().then((s) => {
			if (alive) setLinked(!!s?.configured && !!s.linked);
		});
		return () => {
			alive = false;
		};
	}, []);
	return linked;
}

/**
 * 把一段選取推到使用者自己的 Telegram 聊天室。訊息由伺服器組(出處與回站
 * 連結都在那裡 —— 前端不該自己拼站台網域)。
 */
export function sendSelectionToTelegram(
	text: string,
	questionId: string,
): Promise<{ ok: true }> {
	return api.post<{ ok: true }>("/api/telegram/send-note", {
		text,
		question_id: questionId,
	});
}
