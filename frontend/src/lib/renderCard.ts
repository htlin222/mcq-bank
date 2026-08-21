// 把一段選取畫成 PNG 圖卡(#173)。
//
// 為什麼在瀏覽器裡畫,不在 Worker 上用 satori:free plan 一次請求 10ms CPU,
// 光柵化一張 1600×900 要幾百 ms;satori 不吃 woff2,中文要另外 subset TTF 放 R2;
// 而且 satori 不做禁則處理。瀏覽器這邊 canvas、measureText、字型全都現成。
//
// 視覺是站上 QuestionCard 那一行 `bg-white border-ink-200 rounded-lg shadow-paper`
// 搬到 canvas 上 —— 圖卡不該長得像另一個產品。
//
// **一律淺色,不跟深色模式。** 圖卡的用途是貼到別的地方,深色卡片在 LINE 的
// 白底聊天室裡很突兀;而且它長得就是站上的白卡,對深色模式使用者來說是「站台
// 的紙」而不是另一套配色。

import {
	type Block,
	CRUMB_SEP,
	type Measure,
	fitCrumbs,
	formatStamp,
	layoutBlocks,
	LINE_HEIGHT,
	MARKER_WEIGHT,
	BODY_WEIGHT,
	pickFontSize,
	SIZE_LADDER,
} from "./cardLayout";

// 站上的色票(frontend/tailwind.config.js)
const INK_50 = "#f7f5f2";
const INK_100 = "#ede9e2";
const INK_200 = "#d8d0c2";
const INK_300 = "#b8ac96";
const INK_400 = "#8a7d65";
const INK_500 = "#5d5240";
const INK_800 = "#1a160f";
const ACCENT = "#a8442a";
/** 頁尾的分隔符。用中點而不是麵包屑的 `›` —— 時間與站名不是階層關係,
 * 而站上「民國 114 年 · 第 32 題」用的就是中點。 */
const FOOTER_SEP = " · ";
const FONT_STACK = '"Inter", "Noto Sans TC", system-ui, sans-serif';

// 版面(設計尺寸;輸出乘上 SCALE)
const W = 1080;
const SCALE = 2;
const PAD_OUT = 28; // 米色外框 —— 卡片邊框貼齊 PNG 邊緣會像被裁掉
const PAD_IN = 56;
const RULE_W = 4; // 引言左側直線,呼應 .tiptap blockquote 的 border-l
const RULE_GAP = 28;
const RADIUS = 8; // rounded-lg
const CRUMB_H = 40;
const CRUMB_SIZE = 16;
const CRUMB_TICK_W = 18;
const CRUMB_TICK_GAP = 26;
const DIVIDER_GAP = 34;
const FOOTER_GAP = 26;
const FOOTER_SIZE = 15;
const FOOTER_H = 30;
const BOTTOM_TRIM = 18;

const TEXT_W = W - PAD_OUT * 2 - PAD_IN * 2 - RULE_W - RULE_GAP;
const CRUMB_W = W - PAD_OUT * 2 - PAD_IN * 2 - CRUMB_TICK_GAP;
/** 超過就不再縮字,改讓卡片變高(見 cardLayout.pickFontSize)。 */
const MAX_BODY_H = Math.round(12 * SIZE_LADDER[0] * LINE_HEIGHT);

export type CardInput = {
	blocks: Block[];
	crumbs: string[];
	/** 左下角:題目頁帶「民國 OOO 年 · 第 N 題」,其他頁面帶頁面名稱。 */
	source: string;
	/** 右下角的站名。 */
	site: string;
	/** 產生時間。注入而不是 new Date() —— 測試才鎖得住。 */
	now?: Date;
};

function roundRect(
	ctx: CanvasRenderingContext2D,
	x: number,
	y: number,
	w: number,
	h: number,
	r: number,
) {
	ctx.beginPath();
	ctx.moveTo(x + r, y);
	ctx.arcTo(x + w, y, x + w, y + h, r);
	ctx.arcTo(x + w, y + h, x, y + h, r);
	ctx.arcTo(x, y + h, x, y, r);
	ctx.arcTo(x, y, x + w, y, r);
	ctx.closePath();
}

function makeMeasure(ctx: CanvasRenderingContext2D): Measure {
	return (text, size, weight) => {
		ctx.font = `${weight} ${size}px ${FONT_STACK}`;
		return ctx.measureText(text).width;
	};
}

/**
 * 字型必須先載完再量。
 *
 * `measureText` 在 webfont 載完前回傳的是 fallback 字型的寬度,斷行位置會全錯、
 * 文字溢出卡片 —— 而且只有第一次按下去會發生,重現不易。
 */
async function ensureFonts(): Promise<void> {
	if (!("fonts" in document)) return;
	const probe = "測試Ag";
	await Promise.all([
		document.fonts.load(`${BODY_WEIGHT} ${SIZE_LADDER[0]}px ${FONT_STACK}`, probe),
		document.fonts.load(`${MARKER_WEIGHT} ${CRUMB_SIZE}px ${FONT_STACK}`, probe),
	]).catch(() => undefined);
}

/** 畫出圖卡的 canvas。`renderCard` 用它,e2e 也直接用它驗版面。 */
export async function drawCard(input: CardInput): Promise<HTMLCanvasElement> {
	await ensureFonts();
	const probe = document.createElement("canvas").getContext("2d");
	if (!probe) throw new Error("canvas 2d context unavailable");
	const measure = makeMeasure(probe);

	const size = pickFontSize(input.blocks, TEXT_W, MAX_BODY_H, measure);
	const laid = layoutBlocks(input.blocks, { size, textWidth: TEXT_W, measure });
	const crumbs = input.crumbs.length
		? fitCrumbs(input.crumbs, CRUMB_W, CRUMB_SIZE, measure)
		: [];

	const crumbH = crumbs.length ? CRUMB_H : 0;
	const cardH =
		PAD_IN +
		crumbH +
		laid.height +
		DIVIDER_GAP +
		FOOTER_GAP +
		FOOTER_H +
		PAD_IN -
		BOTTOM_TRIM;
	const H = cardH + PAD_OUT * 2;

	const cv = document.createElement("canvas");
	cv.width = W * SCALE;
	cv.height = H * SCALE;
	const ctx = cv.getContext("2d");
	if (!ctx) throw new Error("canvas 2d context unavailable");
	ctx.scale(SCALE, SCALE);
	ctx.textBaseline = "alphabetic";
	ctx.textAlign = "left";

	ctx.fillStyle = INK_50;
	ctx.fillRect(0, 0, W, H);

	ctx.save();
	ctx.shadowColor = "rgba(60, 50, 30, 0.10)";
	ctx.shadowBlur = 16;
	ctx.shadowOffsetY = 4;
	ctx.fillStyle = "#ffffff";
	roundRect(ctx, PAD_OUT, PAD_OUT, W - PAD_OUT * 2, cardH, RADIUS);
	ctx.fill();
	ctx.restore();
	ctx.strokeStyle = INK_200;
	ctx.lineWidth = 1;
	roundRect(ctx, PAD_OUT + 0.5, PAD_OUT + 0.5, W - PAD_OUT * 2 - 1, cardH - 1, RADIUS);
	ctx.stroke();

	const left = PAD_OUT + PAD_IN;
	const right = W - PAD_OUT - PAD_IN;
	let y = PAD_OUT + PAD_IN;

	if (crumbs.length) {
		ctx.fillStyle = ACCENT;
		ctx.fillRect(left, y + 3, CRUMB_TICK_W, 2);
		let x = left + CRUMB_TICK_GAP;
		crumbs.forEach((part, i) => {
			if (i) {
				ctx.font = `${MARKER_WEIGHT} ${CRUMB_SIZE}px ${FONT_STACK}`;
				ctx.fillStyle = INK_300;
				ctx.fillText(CRUMB_SEP, x, y + 9);
				x += measure(CRUMB_SEP, CRUMB_SIZE, MARKER_WEIGHT);
			}
			// 最後一段是使用者實際在讀的那一節 —— 給它較深的顏色。
			ctx.font = `${MARKER_WEIGHT} ${CRUMB_SIZE}px ${FONT_STACK}`;
			ctx.fillStyle = i === crumbs.length - 1 ? INK_500 : INK_400;
			ctx.fillText(part, x, y + 9);
			x += measure(part, CRUMB_SIZE, MARKER_WEIGHT);
		});
		y += crumbH;
	}

	const bodyTop = y;
	ctx.fillStyle = ACCENT;
	ctx.fillRect(left, bodyTop + 4, RULE_W, Math.max(0, laid.height - Math.round(size * 0.46)));

	const tx = left + RULE_W + RULE_GAP;
	for (const row of laid.rows) {
		const baseline = bodyTop + row.y + Math.round(size * 0.96);
		if (row.marker) {
			ctx.font = `${MARKER_WEIGHT} ${size}px ${FONT_STACK}`;
			ctx.fillStyle = INK_400;
			ctx.fillText(row.marker, tx + row.markerX, baseline);
		}
		ctx.font = `${BODY_WEIGHT} ${size}px ${FONT_STACK}`;
		ctx.fillStyle = INK_800;
		ctx.fillText(row.text, tx + row.x, baseline);
	}
	y = bodyTop + laid.height + DIVIDER_GAP;

	ctx.strokeStyle = INK_100;
	ctx.beginPath();
	ctx.moveTo(left, y + 0.5);
	ctx.lineTo(right, y + 0.5);
	ctx.stroke();

	y += FOOTER_GAP;
	const baseline = y + FOOTER_SIZE;
	ctx.font = `${BODY_WEIGHT} ${FOOTER_SIZE}px ${FONT_STACK}`;
	ctx.fillStyle = INK_400;
	ctx.fillText(input.source, left, baseline);

	// 右下角:產生時間 · 站名。時間在這裡是有意義的 —— 共筆詳解會被改,
	// 這張卡是「那個時間點的說法」。
	const stamp = formatStamp(input.now ?? new Date());
	const stampW = measure(stamp, FOOTER_SIZE, BODY_WEIGHT);
	const sepW = measure(FOOTER_SEP, FOOTER_SIZE, BODY_WEIGHT);
	const siteW = measure(input.site, FOOTER_SIZE, MARKER_WEIGHT);
	let rx = right - (stampW + sepW + siteW);
	ctx.font = `${BODY_WEIGHT} ${FOOTER_SIZE}px ${FONT_STACK}`;
	ctx.fillStyle = INK_400;
	ctx.fillText(stamp, rx, baseline);
	rx += stampW;
	ctx.fillStyle = INK_300;
	ctx.fillText(FOOTER_SEP, rx, baseline);
	rx += sepW;
	ctx.font = `${MARKER_WEIGHT} ${FOOTER_SIZE}px ${FONT_STACK}`;
	ctx.fillStyle = ACCENT;
	ctx.fillText(input.site, rx, baseline);

	return cv;
}

/**
 * 圖卡的 PNG。
 *
 * **剪貼簿只收 `image/png`** —— jpeg 與 svg 都會被拒。
 */
export async function renderCard(input: CardInput): Promise<Blob> {
	const cv = await drawCard(input);
	return new Promise((resolve, reject) => {
		cv.toBlob((blob) => {
			if (blob) resolve(blob);
			else reject(new Error("toBlob returned null"));
		}, "image/png");
	});
}
