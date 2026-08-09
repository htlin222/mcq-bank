// 「我在這台裝置上答過什麼」的本地鏡像。
//
// 跟 attemptOutbox 是兩件事,不要合併:
//   - outbox   = **還沒送出去的**。送成功就刪。回答「有什麼要補送」。
//   - 這一支   = **答過的**。送成功也留著。回答「畫面該顯示什麼」。
//
// 為什麼需要後者:作答就算成功送達,下次讀回來仍可能拿到答題前的版本 ——
// `/api/questions/:id` 在 Service Worker 是 NetworkFirst + 3 秒 timeout,
// 而且快取存 7 天。弱訊號下(e-ink 平板的常態)回的就是舊的那份。
//
// `preserveLocalAnswer()` 本來就會擋這個,但它的「本地那份」來自 questionCache
// ——那是**記憶體**,整頁重載就空了。使用者的實際動作正好包含重載(關掉分頁、
// 隔天再開),於是保護剛好在最需要的時候失效。存進 localStorage 就跨得過重載。
//
// 容量:一題約 60 bytes,1000 題約 60KB,localStorage 有 5MB。不必淘汰。

const KEY = "mcq:local-answers:v1";

export type LocalAnswer = {
	chosen: string;
	correct: 0 | 1;
	at: number;
};

type Store = Record<string, LocalAnswer>;

function read(): Store {
	try {
		const raw = localStorage.getItem(KEY);
		if (!raw) return {};
		const v = JSON.parse(raw);
		return v && typeof v === "object" && !Array.isArray(v) ? (v as Store) : {};
	} catch {
		return {}; // 壞掉的 JSON、Safari 私密瀏覽
	}
}

function write(s: Store): void {
	try {
		localStorage.setItem(KEY, JSON.stringify(s));
	} catch {
		/* 配額滿:當次仍然正確(記憶體那層還在),只是跨不過重載 */
	}
}

/** 作答後記下來。**送出成功也要記** —— 這支不是待送佇列。 */
export function recordAnswer(questionId: string, chosen: string, correct: boolean): void {
	const s = read();
	s[questionId] = { chosen, correct: correct ? 1 : 0, at: Date.now() };
	write(s);
}

/** 「清除本題作答紀錄」時要一起忘掉,否則下次讀回來又被本地救回去。 */
export function forgetAnswer(questionId: string): void {
	const s = read();
	if (!(questionId in s)) return;
	delete s[questionId];
	write(s);
}

export function getAnswer(questionId: string): LocalAnswer | undefined {
	return read()[questionId];
}

export function count(): number {
	return Object.keys(read()).length;
}

export function clearAll(): void {
	write({});
}
