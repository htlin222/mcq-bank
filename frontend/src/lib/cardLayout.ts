// 「複製成圖卡」的版面計算(#173)。
//
// 這一支刻意不碰 canvas:量測由呼叫端注入,所以整個模組是純函式,
// node --test 載得起來。渲染在 renderCard.ts,結構抽取在 selectionBlocks.ts。

/** 一段選取抽出來的結構。來源是 DOM,不是文字 —— 見 selectionBlocks.ts。 */
export type Block =
	| { kind: "heading"; level: number; text: string }
	| { kind: "para"; text: string }
	| { kind: "li"; depth: number; ordered: boolean; ordinal: number; text: string };

/**
 * 量一段文字的寬度。canvas 只有瀏覽器裡才有,注入之後這個模組就測得到。
 * `weight` 是 CSS font-weight —— 項目符號比內文粗,寬度不同。
 */
export type Measure = (text: string, size: number, weight: number) => number;

// ── 禁則處理 ────────────────────────────────────────────────────────────
// 行首禁則:標點被推到下一行的開頭很醜(satori 與 OpenEvidence 的圖卡就是
// 這樣,見 #173 的討論)。
export const NO_LINE_START =
	"。、，．・：；？！）〕］｝〉》」』】”’ー~!?,.:;)]}>%℃";
// 行尾禁則:開括號類不能落單在行尾。
export const NO_LINE_END = "（〔［｛〈《「『【“‘([{<";

/** 麵包屑的分隔符。 */
export const CRUMB_SEP = " › ";

/** 清單符號,對齊 styles.css 的 disc / circle / square。 */
export const BULLETS = ["•", "◦", "▪"];

/** 字級階梯。到底就不再縮 —— 見下面 pickFontSize 的說明。 */
export const SIZE_LADDER = [34, 30, 27, 24];
export const BODY_WEIGHT = 500;
export const MARKER_WEIGHT = 600;
/** 每一層清單的縮排,以及符號與文字之間的距離。 */
export const LIST_INDENT = 30;
export const MARKER_GAP = 14;
/** 行高倍率。段落之間、清單項目之間的間距不同 —— 後者更緊。 */
export const LINE_HEIGHT = 1.6;
const PARA_GAP = 0.62;
const LIST_GAP = 0.34;

/**
 * 把一段文字切成「不可分割單元」:連續拉丁/數字(含黏在後面的 % . / : -)
 * 算一個,CJK 逐字。
 *
 * 斷行與禁則回退**共用**這一組單元,不是各切各的。逐字回退會把 `20%` 拆成
 * `2` / `0%` —— `%` 在行首禁則表裡,於是回退連拉兩次。那比標點落在行首更糟,
 * 而且只在百分比剛好卡在換行點時發生,會隨文字長度飄移。
 */
function toUnits(text: string): string[] {
	return text.match(/[A-Za-z0-9][A-Za-z0-9'’\-.%/:]*|\s+|[\s\S]/g) ?? [];
}

/** CJK + 拉丁混排斷行,含禁則處理。 */
export function layoutLines(
	text: string,
	maxWidth: number,
	size: number,
	measure: Measure,
): string[] {
	const out: string[] = [];
	for (const para of text.split("\n")) {
		if (!para) {
			out.push("");
			continue;
		}
		const units = toUnits(para);
		const width = (arr: string[]) =>
			measure(arr.join(""), size, BODY_WEIGHT);
		let line: string[] = [];
		for (const u of units) {
			if (!line.length || width([...line, u]) <= maxWidth) {
				line.push(u);
				continue;
			}
			const carry = [u];
			while (line.length > 1 && NO_LINE_START.includes(carry[0][0])) {
				carry.unshift(line.pop() as string);
			}
			while (
				line.length > 1 &&
				NO_LINE_END.includes(line[line.length - 1].slice(-1))
			) {
				carry.unshift(line.pop() as string);
			}
			out.push(line.join("").replace(/\s+$/, ""));
			while (carry.length && /^\s+$/.test(carry[0])) carry.shift();
			line = carry;
		}
		if (line.length) out.push(line.join("").replace(/\s+$/, ""));
	}
	return out;
}

/**
 * 麵包屑塞不下時從**中段**省略。
 *
 * 最後一段永遠留著 —— 那是使用者實際在讀的那一節;第一段其次(最廣的定位)。
 * 中間那些資訊量最低,先犧牲。實測 114 年 856 條真實標題路徑:96.4% 整條放得下,
 * 1.8% 需要中段省略,1.9% 只留得下最後一段。
 */
export function fitCrumbs(
	crumbs: string[],
	maxWidth: number,
	size: number,
	measure: Measure,
): string[] {
	if (!crumbs.length) return [];
	const fits = (parts: string[]) =>
		measure(parts.join(CRUMB_SEP), size, MARKER_WEIGHT) <= maxWidth;
	if (fits(crumbs)) return crumbs;

	const head = crumbs[0];
	const tail = crumbs[crumbs.length - 1];
	// 中段由多到少地丟,保留越多越好。
	for (let keep = crumbs.length - 2; keep >= 1; keep--) {
		const candidate = [head, ...crumbs.slice(1, keep), "…", tail];
		if (fits(candidate)) return candidate;
	}
	if (crumbs.length > 1 && fits([head, "…", tail])) return [head, "…", tail];

	// 連「首 › … › 尾」都放不下 —— 只留最後一段,必要時截字。
	let t = tail;
	while (t.length > 4 && measure(`${t}…`, size, MARKER_WEIGHT) > maxWidth) {
		t = t.slice(0, -1);
	}
	return [t === tail ? t : `${t}…`];
}

export type Row = {
	text: string;
	/** 相對於文字欄左緣。 */
	x: number;
	y: number;
	/** 只有區塊的第一行才有(掛號縮排:第二行對齊文字,不對齊符號)。 */
	marker: string | null;
	markerX: number;
};

export type LayoutOpts = {
	size: number;
	/** 文字欄寬度(已扣掉卡片內距與引言直線)。 */
	textWidth: number;
	measure: Measure;
};

/** 把區塊排成可畫的行。 */
export function layoutBlocks(
	blocks: Block[],
	{ size, textWidth, measure }: LayoutOpts,
): { rows: Row[]; height: number } {
	const lh = Math.round(size * LINE_HEIGHT);
	const rows: Row[] = [];
	let h = 0;
	blocks.forEach((b, i) => {
		const isLi = b.kind === "li";
		const indent = isLi ? (b.depth + 1) * LIST_INDENT : 0;
		const marker = isLi
			? b.ordered
				? `${b.ordinal}.`
				: BULLETS[Math.min(b.depth, BULLETS.length - 1)]
			: null;
		const markerW = marker ? measure(marker, size, MARKER_WEIGHT) : 0;
		const bodyX = indent + (marker ? markerW + MARKER_GAP : 0);
		const avail = textWidth - bodyX;
		if (i > 0) {
			const tight = isLi && blocks[i - 1].kind === "li";
			h += Math.round(size * (tight ? LIST_GAP : PARA_GAP));
		}
		layoutLines(b.text, avail, size, measure).forEach((line, j) => {
			rows.push({
				text: line,
				x: bodyX,
				y: h,
				marker: j === 0 ? marker : null,
				markerX: indent,
			});
			h += lh;
		});
	});
	return { rows, height: h };
}

/**
 * 選字級。字多就降一級,**降到 SIZE_LADDER 最後一格就不再縮,改讓卡片變高**。
 *
 * 一張長圖在聊天室裡可以捲,一張小字圖不能放大 —— 實測 600 字若繼續縮到 21px,
 * 貼進 LINE 用 400px 顯示時等效只剩 7.8px。所以下限比「不超過 maxHeight」優先。
 */
export function pickFontSize(
	blocks: Block[],
	textWidth: number,
	maxHeight: number,
	measure: Measure,
): number {
	for (const size of SIZE_LADDER) {
		if (layoutBlocks(blocks, { size, textWidth, measure }).height <= maxHeight) {
			return size;
		}
	}
	return SIZE_LADDER[SIZE_LADDER.length - 1];
}

/** 卡片右下角的產生時間 `yyyy-mm-dd hh:mm`(本地時間)。 */
export function formatStamp(d: Date): string {
	const p = (n: number) => String(n).padStart(2, "0");
	return (
		`${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
		`${p(d.getHours())}:${p(d.getMinutes())}`
	);
}

/**
 * 卡片左下角的出處。
 *
 * 年份與題號一律從 question id 的兩段推,**不查 `questions.number`** ——
 * 114 共同區有 18 題的 number 與 id 尾碼錯位,拿 number 顯示會標到別題
 * (同 worker/lib/telegram.ts 的 formatSelectionNote)。
 * 不是題目頁時退回頁面標題;都沒有就留空,不亂編。
 */
export function cardSourceLabel(pathname: string, fallback = ""): string {
	const m = /^\/q\/(\d{2,4})-(\d{1,4})/.exec(pathname);
	if (m) return `民國 ${m[1]} 年 · 第 ${Number(m[2])} 題`;
	return fallback.trim();
}
