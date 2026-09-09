import { useCallback, useEffect, useRef, useState } from "react";
import {
	ChevronLeft,
	ChevronRight,
	Expand,
	Images,
	Pause,
	Play,
} from "lucide-react";
import { fetchSmearGallery, type SmearGalleryItem } from "../../lib/smearApi";
import {
	advance,
	initialGallery,
	readGalleryPaused,
	receivePrefetch,
	retreat,
	shouldAutoAdvance,
	shouldPrefetch,
	writeGalleryPaused,
	AUTO_ADVANCE_MS,
	BATCH_SIZE,
	type GalleryState,
} from "../../lib/smearGallery";
import { useIsEink } from "../../lib/theme";
import {
	GalleryCaption,
	GalleryCountdown,
	GalleryImage,
} from "./SmearGalleryParts";
import { SmearGalleryDetailDialog } from "./SmearGalleryDetailDialog";
import { prefetchDxNote, SmearScreensaver } from "./SmearScreensaver";

/**
 * 首頁的抹片輪播卡 —— 左圖右說明,自動十秒換一張,可暫停、可手動翻、可全螢幕
 * 當螢幕保護。
 *
 * **它跟練習模式的關係是刻意相反的。** 抹片練習的每一支端點都在防止正解外洩
 * (見 CLAUDE.md「抹片練習」那節的四道閘);這張卡的整個用途就是把答案講出來。
 * 定位是「滑手機式的被動複習」,不是測驗。所以:
 *
 *   - 用自己的端點 `/api/smear/gallery`(那支的檔頭寫明只給這裡用)
 *   - **畫在首頁兩個分頁共用的區域**,不進 SmearDashboard —— 筆試組的人也會
 *     在等車時掃兩眼,那正是它的價值
 *   - 不寫任何作答紀錄,不進 `smear_answers`,不影響任何統計
 *
 * **沒有資料就整張不畫。** fork 出去沒有匯入抹片內容的站,一張空卡片擺在倒數
 * 卡下面只是噪音。
 */
export function SmearGalleryCard() {
	const eink = useIsEink();
	const [state, setState] = useState<GalleryState<SmearGalleryItem>>(() =>
		initialGallery<SmearGalleryItem>(),
	);
	const [loaded, setLoaded] = useState(false);
	const [paused, setPaused] = useState(readGalleryPaused);
	// 「有人正在讀,先別換」有兩個來源,而**它們不能是同一個 state**:
	//   卡片   指標停在卡上
	//   全螢幕 說明欄被捲下去了(見 SmearScreensaver 的 onInteract)
	//
	// ⚠️ 而且卡片那個訊號在全螢幕開著時必須整個讓開。React 的 portal 事件是沿
	// **React 樹**冒泡的,所以指標在全螢幕 overlay 裡的任何位置,都會被下面那顆
	// `<section>` 的 onMouseEnter 收到 —— 於是 `interacting` 永遠是 true、
	// 自動輪播在螢幕保護裡一次都不會跑,而畫面上唯一的線索是倒數不見了。
	// 這是實際踩到的:第一版全螢幕開起來之後倒數整個不出現。
	const [cardHover, setCardHover] = useState(false);
	const [saverReading, setSaverReading] = useState(false);
	const [documentHidden, setDocumentHidden] = useState(
		() => typeof document !== "undefined" && document.hidden,
	);
	const [fullscreen, setFullscreen] = useState(false);
	const [detailOpen, setDetailOpen] = useState(false);
	// 對話框開著就是明確的「我正在讀」——不擋的話,讀到一半底下的輪播照樣在跑,
	// 關掉對話框會發現圖已經換過好幾張了。
	const interacting = detailOpen || (fullscreen ? saverReading : cardHover);

	const item = state.batch[state.index] ?? null;

	// ── 取第一批 ─────────────────────────────────────────────────────────────
	useEffect(() => {
		let cancelled = false;
		fetchSmearGallery(BATCH_SIZE)
			.then((r) => {
				if (!cancelled) setState(initialGallery(r.items ?? []));
			})
			.catch(() => {
				/* 首頁的瀏覽性區塊,抓不到就整張不畫 —— 不彈錯誤打斷首頁 */
			})
			.finally(() => {
				if (!cancelled) setLoaded(true);
			});
		return () => {
			cancelled = true;
		};
	}, []);

	// 剩四張時去要下一批。⚠️ 這個 effect 每次換圖都會重跑,所以 `shouldPrefetch`
	// 必須「手上已經有 next 就回 false」—— 少了那一條,最後四張每換一次就打一趟
	// 請求。`prefetching` ref 再擋住「請求還在飛的時候又換了一張」那一格。
	const prefetching = useRef(false);
	useEffect(() => {
		if (!shouldPrefetch(state) || prefetching.current) return;
		prefetching.current = true;
		fetchSmearGallery(BATCH_SIZE)
			.then((r) => setState((s) => receivePrefetch(s, r.items ?? [])))
			.catch(() => {
				/* 下一批沒來就停在最後一張,見 advance() 的說明 */
			})
			.finally(() => {
				prefetching.current = false;
			});
	}, [state]);

	// ── 自動輪播 ─────────────────────────────────────────────────────────────
	// 計時器綁在「現在在看哪一張」上,所以**手動翻頁會重新計時** —— 否則按完
	// 下一張可能一秒後又自己跳一張,看起來像連點了兩下。
	//
	// ⚠️ 相依刻意寫成 `state.batch` / `state.index` 而不是整個 `state`:預抓
	// 回來時只有 `state.next` 變,而看的還是同一張圖。整包 state 進相依的話,
	// 那一張會被重新計時、停在畫面上將近二十秒 —— 而使用者只會覺得「有時候
	// 換得比較慢」,查不出原因。
	const auto = shouldAutoAdvance({
		paused,
		eink,
		documentHidden,
		interacting,
		hasItems: state.batch.length > 0,
	});
	//
	// `deadlineAt` 是「下一次換圖的時刻」,交給 GalleryCountdown 自己每秒去逼近。
	// **時刻而不是剩餘秒數** —— 秒數要由這一層每秒往下數,那等於每秒重繪整張卡
	// (圖、說明、控制列全部);一個時間戳只在換圖時變一次。
	const [deadlineAt, setDeadlineAt] = useState<number | null>(null);
	useEffect(() => {
		if (!auto) {
			setDeadlineAt(null);
			return;
		}
		setDeadlineAt(Date.now() + AUTO_ADVANCE_MS);
		const t = window.setTimeout(
			() => setState((s) => advance(s)),
			AUTO_ADVANCE_MS,
		);
		return () => window.clearTimeout(t);
	}, [auto, state.batch, state.index]);

	useEffect(() => {
		const onVis = () => setDocumentHidden(document.hidden);
		document.addEventListener("visibilitychange", onVis);
		return () => document.removeEventListener("visibilitychange", onVis);
	}, []);

	// ── 只預載「下一張」 ─────────────────────────────────────────────────────
	// 整批預載等於一進首頁就吃十幾 MB(view 尺寸長邊 1600)。只抓下一張,換過去
	// 就不會是一塊空白;全螢幕時預載 full 尺寸,跟畫面上真的會用到的那個一致。
	useEffect(() => {
		const nx = state.batch[state.index + 1] ?? state.next?.[0];
		if (!nx) return;
		const img = new Image();
		img.src = `/img/${fullscreen ? nx.image_key_full : nx.image_key_view}`;
	}, [state, fullscreen]);

	const goNext = useCallback(() => setState((s) => advance(s)), []);
	const goPrev = useCallback(() => setState((s) => retreat(s)), []);
	const togglePause = useCallback(
		() =>
			setPaused((p) => {
				writeGalleryPaused(!p);
				return !p;
			}),
		[],
	);

	if (!loaded || !item) return null;

	return (
		<section
			className="mb-8"
			aria-label="抹片隨手逛"
			data-smear-gallery
			// 指標停在卡上、或卡裡有東西拿著焦點時不自動換 —— 正在讀說明時被換走
			// 是這種卡片最容易被回報成「它自己跳掉了」的一件事。
			onMouseEnter={() => setCardHover(true)}
			onMouseLeave={() => setCardHover(false)}
			onFocusCapture={() => setCardHover(true)}
			onBlurCapture={() => setCardHover(false)}
		>
			<div className="border border-ink-200 dark:border-ink-700 rounded-lg overflow-hidden bg-white dark:bg-ink-800">
				<div className="flex items-center gap-2 px-4 py-2 border-b border-ink-100 dark:border-ink-700">
					<Images size={16} strokeWidth={1.75} className="text-accent shrink-0" />
					<h2 className="text-sm text-ink-700 dark:text-ink-200">抹片隨手逛</h2>
					<span className="text-xs text-ink-400 dark:text-ink-500 hidden sm:inline">
						答案直接寫在旁邊
					</span>
					<div className="ml-auto flex items-center gap-1">
						{/* 倒數在暫停鈕**左邊** —— 它回答的是「這顆鈕現在在數什麼」,
						    而按下暫停之後它會消失,那本身就是最直接的狀態回饋。 */}
						<GalleryCountdown deadline={deadlineAt} />
						<IconButton label="上一張" onClick={goPrev}>
							<ChevronLeft size={16} strokeWidth={1.75} />
						</IconButton>
						<IconButton label="下一張" onClick={goNext}>
							<ChevronRight size={16} strokeWidth={1.75} />
						</IconButton>
						{/* ⚠️ e-ink 下自動輪播是強制關的(殘影 + 每次換圖全屏刷新),
						    所以那個模式下不畫這顆 —— 留著就是一顆按了沒反應的鍵,同
						    CLAUDE.md 手把那節「按下去沒反應的鍵最傷」。 */}
						{!eink && (
							<IconButton
								label={paused ? "開始自動輪播" : "暫停自動輪播"}
								onClick={togglePause}
							>
								{paused ? (
									<Play size={16} strokeWidth={1.75} />
								) : (
									<Pause size={16} strokeWidth={1.75} />
								)}
							</IconButton>
						)}
						{/* pointerdown 就去拿詳解 —— 按下去到放開之間夠一趟 RTT,全螢幕
						    一開就是全文,不會先閃一下摘要再跳成整篇。 */}
						<IconButton
							label="全螢幕輪播"
							onPointerDown={() => prefetchDxNote(item.dx_id)}
							onClick={() => {
								setSaverReading(false);
								setFullscreen(true);
							}}
						>
							<Expand size={16} strokeWidth={1.75} />
						</IconButton>
					</div>
				</div>

				{/* <sm 上圖下說明 —— 390px 塞不下兩欄,硬排的話說明只剩十來個字寬。 */}
				<div className="grid sm:grid-cols-9">
					<GalleryImage
						item={item}
						sizeKey="image_key_view"
						className="sm:col-span-5 h-48 sm:h-64 bg-ink-100 dark:bg-ink-900"
					/>
					<div className="sm:col-span-4 p-4 min-w-0">
						<GalleryCaption
							item={item}
							onOpenDetail={() => setDetailOpen(true)}
						/>
					</div>
				</div>
			</div>

			{detailOpen && (
				<SmearGalleryDetailDialog
					item={item}
					onClose={() => setDetailOpen(false)}
				/>
			)}

			{fullscreen && (
				<SmearScreensaver
					item={item}
					paused={paused}
					eink={eink}
					deadline={deadlineAt}
					onInteract={setSaverReading}
					onNext={goNext}
					onPrev={goPrev}
					onTogglePause={togglePause}
					onClose={() => {
						setFullscreen(false);
						// 離開時把卡片那個訊號也清掉:指標多半停在剛才那顆 ⛶ 上,
						// 而 mouseenter 不會再放一次 —— 不清的話輪播就卡在暫停。
						setCardHover(false);
					}}
				/>
			)}
		</section>
	);
}

function IconButton({
	label,
	onClick,
	onPointerDown,
	children,
}: {
	label: string;
	onClick: () => void;
	onPointerDown?: () => void;
	children: React.ReactNode;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			onPointerDown={onPointerDown}
			aria-label={label}
			title={label}
			className="p-1.5 rounded text-ink-500 dark:text-ink-400 hover:text-accent hover:bg-ink-50 dark:hover:bg-ink-700 transition"
		>
			{children}
		</button>
	);
}
