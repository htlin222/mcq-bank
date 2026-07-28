import { createContext, useContext, useMemo, useRef } from "react";

// 讓「選字工具列」找得到畫記能力的接線板。
//
// 工具列只有一份、掛在 App 層,但「螢光標記」這個動作必須作用在某一個
// AnnotatableContent 的 ProseMirror 實例上。所以每個 AnnotatableContent 掛載時
// 把自己註冊進來,工具列拿到選取後反查 anchor 落在哪個 dom 裡,有找到才亮出
// 那顆按鈕。
//
// 註冊的是一個**可變的 ref 物件**而不是快照:`cloze` 會隨使用者切換防劇透而
// 改變,工具列必須讀到當下的值,不能讀到註冊那一刻的值。

export type AnnotationTarget = {
	/** 該編輯器的 DOM 根節點,用來判斷選取落在誰身上。 */
	dom: HTMLElement;
	/** 防劇透模式中不開放畫記。 */
	cloze: boolean;
	applyHighlight: (from: number, to: number) => void;
	clearHighlight: (from: number, to: number) => void;
	/** DOM 節點 + offset → ProseMirror 位置。取不到時回 null。 */
	posAt: (node: Node, offset: number) => number | null;
};

/** 點擊既有 `<mark>` 時,由 AnnotatableContent 推給工具列的請求。 */
export type MarkRequest = {
	target: AnnotationTarget;
	/** 該 mark 的 client rect,工具列拿來定位。 */
	rect: DOMRect;
	from: number;
	to: number;
	/** 該 mark 的文字,讓使用者可以直接對它查參考資料 / 問 AI。 */
	text: string;
};

type Registry = {
	register: (target: AnnotationTarget) => () => void;
	/** 反查某個 DOM 節點屬於哪個已註冊的編輯器。 */
	find: (node: Node | null) => AnnotationTarget | null;
	/** AnnotatableContent → 工具列。 */
	emitMark: (req: MarkRequest) => void;
	/** 工具列訂閱 mark 點擊;回傳取消訂閱函式。 */
	onMark: (cb: (req: MarkRequest) => void) => () => void;
};

const noop: Registry = {
	register: () => () => {},
	find: () => null,
	emitMark: () => {},
	onMark: () => () => {},
};

const Ctx = createContext<Registry>(noop);

export function useAnnotationRegistry(): Registry {
	return useContext(Ctx);
}

export function AnnotationRegistryProvider({
	children,
}: {
	children: React.ReactNode;
}) {
	// Set / listener 都放在 ref 裡:註冊與取消註冊不該觸發任何 re-render,
	// 否則每個詳解掛載都會把整棵 App 重畫一次。
	const targets = useRef(new Set<AnnotationTarget>());
	const listeners = useRef(new Set<(req: MarkRequest) => void>());

	const value = useMemo<Registry>(
		() => ({
			register(target) {
				targets.current.add(target);
				return () => {
					targets.current.delete(target);
				};
			},
			find(node) {
				if (!node) return null;
				for (const t of targets.current) {
					// dom 可能已從文件移除(元件卸載中);contains 對此回 false,
					// 正是我們要的。
					if (t.dom.contains(node)) return t;
				}
				return null;
			},
			emitMark(req) {
				for (const cb of listeners.current) cb(req);
			},
			onMark(cb) {
				listeners.current.add(cb);
				return () => {
					listeners.current.delete(cb);
				};
			},
		}),
		[],
	);

	return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
