// 選取範圍 → 結構化區塊(#173)。
//
// **不能用 `getSelection().toString()`。** 實測同一段詳解(h3 + p + 巢狀 ul + ol):
//
//   chromium: "二、診斷準則…\nCAD 的診斷…\n\n慢性溶血性貧血的證據\n\n…"
//   webkit:   "二、診斷準則…\n\nCAD 的診斷…\n\n慢性溶血性貧血的證據\n\n…"
//
// `<ol>` 的序號整個消失、巢狀項目跟頂層分不出來、標題跟段落長得一樣,而且
// 兩個引擎連空行數量都不同 —— 任何靠空行猜結構的啟發式都會在 iOS 與桌機排出
// 不同版面,而 e2e 跑 WebKit、日常開發跑 Chromium,那種差異會活很久。
//
// 所以走 DOM。`TextSelection.range` 本來就是 cloned Range(工具列量位置用的
// 那一份),不必新增任何快照。

import type { Block } from "./cardLayout";

const BLOCK_SEL = "h1,h2,h3,h4,h5,h6,p,li,blockquote";
const HEADING_SEL = "h1,h2,h3,h4,h5,h6";
/** 筆記手風琴的標題按鈕(NoteContent)。 */
const NOTE_HEADING_SEL = "[data-note-heading]";

/** 把 range 的邊界夾到 node 上,回傳落在選取內的那一段文字。 */
function clipNode(range: Range, node: Node): string {
	const r = document.createRange();
	r.selectNodeContents(node);
	if (range.compareBoundaryPoints(Range.START_TO_START, r) > 0) {
		r.setStart(range.startContainer, range.startOffset);
	}
	if (range.compareBoundaryPoints(Range.END_TO_END, r) < 0) {
		r.setEnd(range.endContainer, range.endOffset);
	}
	return r.toString();
}

/**
 * 元素「自己的」文字,夾到選取範圍內。
 *
 * 一定要排除巢狀 `<ul>`/`<ol>` —— `li.textContent` 含子清單的字,直接取的話
 * 父項目會把子項目整段吃進去,畫出來是同一句話出現兩次(一次黏在父項目尾巴、
 * 一次在縮排的子項目)。
 */
function ownText(range: Range, el: Element): string {
	const parts: string[] = [];
	const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
		acceptNode(n) {
			for (let e = n.parentElement; e && e !== el; e = e.parentElement) {
				if (e.tagName === "UL" || e.tagName === "OL") return NodeFilter.FILTER_REJECT;
			}
			return NodeFilter.FILTER_ACCEPT;
		},
	});
	let n = walker.nextNode();
	while (n) {
		if (range.intersectsNode(n)) parts.push(clipNode(range, n));
		n = walker.nextNode();
	}
	return parts.join("").replace(/\s+/g, " ").trim();
}

function listDepth(li: Element): number {
	let d = -1;
	for (let e: Element | null = li; e; e = e.parentElement) {
		if (e.tagName === "UL" || e.tagName === "OL") d++;
	}
	return Math.max(0, d);
}

function scopeRoot(range: Range): Element | null {
	let root: Node | null = range.commonAncestorContainer;
	if (root.nodeType !== Node.ELEMENT_NODE) root = (root as Node).parentElement;
	return root as Element | null;
}

/** 選取範圍抽成區塊。順序即文件順序。 */
export function extractBlocks(range: Range): Block[] {
	const root = scopeRoot(range);
	if (!root) return [];
	// `querySelectorAll` 只找**後代**。選取整段落在單一 <p> 裡時,共同祖先就是
	// 那個 <p> 自己 —— 直接查會一個區塊都拿不到,卡片變空白。所以先往上走到
	// 一個本身不是區塊的容器。
	let scope = root.closest(".tiptap");
	if (!scope) {
		scope = root;
		while (scope.matches(BLOCK_SEL) && scope.parentElement) {
			scope = scope.parentElement;
		}
	}
	const blocks: Block[] = [];
	for (const el of Array.from(scope.querySelectorAll(BLOCK_SEL))) {
		if (!range.intersectsNode(el)) continue;
		// `<li>` 裡的 `<p>` 會重複計算 —— 以 li 為準。
		if (el.tagName === "P" && el.closest("li")) continue;
		const text = ownText(range, el);
		if (!text) continue;
		if (/^H[1-6]$/.test(el.tagName)) {
			blocks.push({ kind: "heading", level: Number(el.tagName[1]), text });
		} else if (el.tagName === "LI") {
			const list = el.parentElement;
			const ordered = list?.tagName === "OL";
			const start = ordered ? Number(list?.getAttribute("start") ?? 1) : 1;
			const index = list ? Array.from(list.children).indexOf(el) : 0;
			blocks.push({
				kind: "li",
				depth: listDepth(el),
				ordered: !!ordered,
				// 序號取自 DOM 位置,不重新從 1 數:使用者只選清單後半段時,
				// 序號要跟他螢幕上看到的一致。
				ordinal: start + Math.max(0, index),
				text,
			});
		} else {
			blocks.push({ kind: "para", text });
		}
	}
	return blocks;
}

/**
 * 筆記(個人筆記 / 其他筆記)的標題路徑。
 *
 * `NoteContent` 把**每一個**標題渲染成 `<button data-note-heading>` 而不是
 * `h1..h6` —— 手風琴需要它可點、可聚焦(手把導覽也靠這個屬性走訪)。所以
 * 「掃 h1..h6」那條路在筆記裡永遠是空手,這正是回報的症狀:在筆記裡複製成
 * 圖卡時麵包屑整條不見。
 *
 * 好消息是筆記的階層**真的巢狀在 DOM 裡**(區段的子節點渲染在區段內),比
 * 扁平的標題序列更可靠 —— 不必猜哪個標題是祖先,往上走就是了。
 *
 * 區段的形狀是「外層 div > 第一個子元素是標題按鈕」,所以認 `firstElementChild`
 * 而不是認 class(那會跟著樣式一起腐爛)。
 */
function accordionPath(range: Range): string[] {
	const out: string[] = [];
	for (let el = scopeRoot(range); el; el = el.parentElement) {
		const head = el.firstElementChild;
		if (head?.matches(NOTE_HEADING_SEL)) {
			const text = (head.textContent ?? "").replace(/\s+/g, " ").trim();
			if (text) out.unshift(text);
		}
	}
	return out;
}

/**
 * 標題路徑(麵包屑):最上層 › … › 最近的一層。
 *
 * `h1..h6` 在 HTML 裡是**扁平序列**,沒有巢狀結構可問,所以得自己還原:從
 * 「目前所在的標題」往回走,只收層級**更淺**的,收到就把門檻降下去。
 * 直接「往前收所有標題」會把同級的**兄弟**節章一起串進來 —— 例如在
 * 「二、診斷準則」底下選取時,前面那個「一、臨床線索」不是祖先。
 *
 * 「目前所在」= 選取範圍內的第一個標題,沒有的話才是選取之前最後一個。
 */
export function headingPath(range: Range): string[] {
	// 筆記優先:那裡沒有 h1..h6,而巢狀結構本身就是階層。
	const sections = accordionPath(range);
	if (sections.length) return sections;

	const root = scopeRoot(range);
	if (!root) return [];
	const scope = root.closest(".tiptap");
	// 找不到內容容器時**不要**退回整份文件。頁面上到處都有標題(題幹、分頁、
	// 卡片標題),掃 body 會給出一條看起來合理、其實跟選取無關的路徑 ——
	// 那比沒有麵包屑更糟,因為它是錯的而且沒有人會懷疑。
	if (!scope) return [];
	const heads = Array.from(scope.querySelectorAll(HEADING_SEL));
	const level = (h: Element) => Number(h.tagName[1]);
	const text = (h: Element) => (h.textContent ?? "").replace(/\s+/g, " ").trim();

	let current: Element | null = heads.find((h) => range.intersectsNode(h)) ?? null;
	if (!current) {
		for (const h of heads) {
			const r = document.createRange();
			r.selectNodeContents(h);
			if (r.compareBoundaryPoints(Range.END_TO_START, range) <= 0) current = h;
		}
	}
	if (!current) return [];

	const path = [text(current)];
	let last = level(current);
	for (let i = heads.indexOf(current) - 1; i >= 0; i--) {
		if (level(heads[i]) < last) {
			path.unshift(text(heads[i]));
			last = level(heads[i]);
		}
	}
	return path.filter(Boolean);
}

/**
 * 圖卡要畫的內容。標題若落在選取範圍內,會成為麵包屑的最後一段並**從內文移除**
 * —— 否則同一行字會出現兩次(一次在麵包屑、一次在正文第一行)。
 */
export function cardContent(range: Range): { crumbs: string[]; blocks: Block[] } {
	const blocks = extractBlocks(range).filter((b) => b.kind !== "heading");
	// 選取落在沒有區塊標籤的地方(題幹是一個純 div)時什麼都抽不到 ——
	// 退回單段純文字,而不是給出一張空白卡片。
	if (!blocks.length) {
		const text = range.toString().replace(/\s+/g, " ").trim();
		if (text) blocks.push({ kind: "para", text });
	}
	return { crumbs: headingPath(range), blocks };
}
