import { useEffect, useRef, useState, lazy, Suspense } from "react";
import {
	Routes,
	Route,
	Link,
	NavLink,
	useNavigate,
	useLocation,
	Navigate,
} from "react-router-dom";
import type { LucideIcon } from "lucide-react";
import {
	Home as HomeIcon,
	BookOpen,
	PenLine,
	Bookmark,
	Search as SearchIcon,
	ChevronDown,
} from "lucide-react";
import { config } from "./config";
import {
	saveLastPath,
	saveSectionPath,
	clearSectionPath,
	saveYearPosition,
} from "./lib/lastPath";
import { useMe } from "./hooks/useMe";
import { useOnline } from "./hooks/useOnline";
import { migrateLocalHighlights } from "./lib/highlightStore";
import { migrateLocalExamFlags } from "./lib/examFlagStore";
import { Avatar } from "./components/Avatar";
import { NotificationBell } from "./components/NotificationBell";
import { ChallengeBell } from "./components/ChallengeBell";
import { FeedbackButton } from "./components/FeedbackButton";
import { OnlineUsers } from "./components/OnlineUsers";
import { ThemeToggle } from "./components/ThemeToggle";
import { PomodoroFab } from "./components/PomodoroFab";
import { ViewportModeFab } from "./components/ViewportModeFab";
import { UpdatePrompt } from "./components/UpdatePrompt";
import { ChatProvider } from "./chat/ChatProvider";
import { ChatToaster } from "./chat/ChatToaster";
import { AnnotationRegistryProvider } from "./components/AnnotationRegistry";
import { SelectionToolbar } from "./components/SelectionToolbar";
import { ChatBell } from "./chat/ChatBell";
import { Home } from "./routes/Home";
import { Landing } from "./routes/Landing";
import { Chat } from "./routes/Chat";
import { ReviewIndex } from "./routes/ReviewIndex";
import { NewYear } from "./routes/NewYear";
import { AnkiDeck } from "./routes/AnkiDeck";
import { DueQueue } from "./routes/DueQueue";
import { YearList } from "./routes/YearList";
import { Question } from "./routes/Question";
import { Drill } from "./routes/Drill";
import { WeaknessMap } from "./routes/WeaknessMap";
import { Exam } from "./routes/Exam";
import { ExamResult } from "./routes/ExamResult";
import { ExamHistory } from "./routes/ExamHistory";
import { CustomTest } from "./routes/CustomTest";
import { Profile } from "./routes/Profile";
import { Play } from "./routes/Play";
import { WrongQuestions } from "./routes/Lists";
import { Bookmarks } from "./routes/Bookmarks";
import { Search } from "./routes/Search";
import { Challenges } from "./routes/Challenges";
import Videos from "./routes/Videos";

// Lazy — keeps EmbedPDF's pdfium-wasm bundle off every other route.
const Lectures = lazy(() => import("./routes/Lectures"));
const LectureReader = lazy(() => import("./routes/LectureReader"));
// 跟講義閱讀器同一個理由 lazy:整包 TipTap 編輯器只有真的開筆記才需要。
const FreeNote = lazy(() => import("./routes/FreeNote"));

export default function App() {
	const { me, loading } = useMe();
	const navigate = useNavigate();

	// Intercept clicks on @-question-ref links inside TipTap content so they
	// route via react-router instead of triggering a full page reload.
	useEffect(() => {
		function onClick(e: MouseEvent) {
			if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey) return;
			const target = (e.target as Element | null)?.closest(
				"a[data-question-ref]",
			);
			if (!target) return;
			const id = target.getAttribute("data-question-ref");
			if (!id) return;
			e.preventDefault();
			navigate(`/q/${id}`);
		}
		document.addEventListener("click", onClick);
		return () => document.removeEventListener("click", onClick);
	}, [navigate]);

	// Once authenticated, upload any pre-sync localStorage 畫記 to the server
	// (once per device). No-op after the first run or if already migrated.
	// 考試標記同理,但舊資料在 sessionStorage,只救得到還開著的分頁。
	useEffect(() => {
		if (me?.email) {
			void migrateLocalHighlights();
			void migrateLocalExamFlags();
		}
	}, [me?.email]);

	// Boot splash while the first /api/me call resolves — avoids flashing the
	// Landing for a logged-in user, or Dashboard for an anonymous visitor.
	if (loading) {
		return <BootSplash />;
	}

	// Anonymous visitor: only Landing renders, no app chrome. The /login route
	// is a tiny redirect — the visitor hits it, CF Access (NOT bypassed for
	// /login) intercepts, runs email-OTP, sets the auth cookie, and bounces
	// them back here; useMe now succeeds and this branch flips to authed.
	if (!me) {
		return (
			<Routes>
				<Route path="/login" element={<LoginRedirect />} />
				<Route path="*" element={<Landing />} />
			</Routes>
		);
	}

	return (
		<ChatProvider>
		<AnnotationRegistryProvider>
		<div className="min-h-screen bg-ink-50 dark:bg-ink-900 text-ink-800 dark:text-ink-200 flex flex-col">
			<LastPathTracker />
			<ChatToaster />
			<OfflineBanner />
			{/* Top bar */}
			<header className="sticky top-0 z-30 bg-white/95 dark:bg-ink-800/95 backdrop-blur border-b border-ink-200 dark:border-ink-700">
				<div className="max-w-7xl mx-auto px-4 sm:px-6 h-14 flex items-center gap-3">
					{/* 品牌是這一列唯一可以讓步的東西,所以由它吸收壓縮(`min-w-0` +
					    `truncate`),其餘兩塊 `shrink-0`。這條是結構性保證:不管品牌
					    名多長、線上人數幾個,頁面都不會因為 header 而產生水平捲動
					    (#94)。斷點階梯是為了讓它「幾乎永遠用不到」,不是替代品。 */}
					<Link
						to="/"
						className="font-serif text-xl text-ink-900 dark:text-ink-100 hover:text-accent transition whitespace-nowrap min-w-0 truncate"
					>
						{config.brand.short_name}
					</Link>

					{/* Desktop nav — tail items fold into a 更多 dropdown as the
					    viewport narrows, so labels never wrap into two lines.
					    每一階都比「塞得下的寬度」晚一個斷點才出現。量出來的需求是:
					    4 項 + 更多 需要 ~704px、6 項需要 ~816px、8 項需要 ~936px,
					    而舊版分別在 640 / 768 / 1024 就放出來 —— 每個斷點**當下那一刻**
					    都是最擠的,於是 640、768 這兩個寬度必定溢出(320 則是連
					    品牌 + 工具列都塞不下)。底部列因此一路撐到 md,640–767 這段
					    由它負責導覽,上面那條就只剩品牌 + 工具列。 */}
					<nav className="hidden md:flex items-center gap-1 ml-6 text-sm shrink-0">
						<NavItem to="/" end>
							首頁
						</NavItem>
						<NavItem to="/review">複習</NavItem>
						<NavItem to="/exam">全真</NavItem>
						<NavItem to="/search">搜尋</NavItem>
						<NavItem to="/bookmarks" className="hidden lg:block">收藏</NavItem>
						<NavItem to="/wrong" className="hidden lg:block">錯題</NavItem>
						<NavItem to="/lectures" className="hidden xl:block">講義</NavItem>
						{/* 影片以前只活在 更多 裡,而 更多 在最寬的那一階整個消失 ——
						    於是 ≥xl 完全走不到 /videos。凡是只存在於下拉裡的項目,
						    下拉收起來的那一階都得在列上補一顆。 */}
						<NavItem to="/videos" className="hidden xl:block">影片</NavItem>
						<NavItem to="/challenges" className="hidden xl:block">答案挑戰</NavItem>
						<NavMore />
					</nav>

					<div className="ml-auto flex items-center gap-2 shrink-0">
						<OnlineUsers />
						<ChatBell />
						<ChallengeBell />
						<ThemeToggle />
						<FeedbackButton />
						<NotificationBell />
						{me && (
							<Link
								to="/profile"
								className="flex items-center gap-2 px-2 py-1 rounded hover:bg-ink-100 dark:hover:bg-ink-800"
							>
								<Avatar
									email={me.email}
									avatarKey={me.avatar_key}
									name={me.display_name}
									size={28}
								/>
								<span className="hidden lg:inline whitespace-nowrap text-sm text-ink-700 dark:text-ink-200">
									{me.display_name}
								</span>
							</Link>
						)}
					</div>
				</div>
			</header>

			{/* Main */}
			<main className="flex-1 pb-[var(--bottom-nav-h)]">
				<Routes>
					<Route path="/" element={<Home />} />
					<Route path="/review" element={<ReviewIndex />} />
					<Route path="/review/new-year" element={<NewYear />} />
					<Route path="/due" element={<DueQueue />} />
					<Route path="/anki/:year" element={<AnkiDeck />} />
					<Route path="/year/:year" element={<YearList />} />
					<Route path="/q/:id" element={<Question />} />
					<Route path="/drill/:anchor" element={<Drill />} />
					<Route path="/weakness-map" element={<WeaknessMap />} />
					<Route path="/exam" element={<Exam />} />
					{/* 必須排在 /exam/:sid 之前,否則 "new" 會被當成 session id */}
					<Route path="/exam/new" element={<CustomTest />} />
					<Route path="/exam/:sid" element={<Exam />} />
					<Route path="/exam/:sid/result" element={<ExamResult />} />
					<Route path="/exam-history" element={<ExamHistory />} />
					<Route path="/search" element={<Search />} />
					<Route path="/bookmarks" element={<Bookmarks />} />
					<Route path="/wrong" element={<WrongQuestions />} />
					<Route path="/challenges" element={<Challenges />} />
					<Route path="/chat" element={<Chat />} />
					<Route
						path="/lectures"
						element={
							<Suspense fallback={<BootSplash />}>
								<Lectures />
							</Suspense>
						}
					/>
					<Route
						path="/lectures/:slug"
						element={
							<Suspense fallback={<BootSplash />}>
								<LectureReader />
							</Suspense>
						}
					/>
					{/* 其他筆記(自由筆記)—— 入口在 /lectures?tab=note */}
					<Route
						path="/notes/:id"
						element={
							<Suspense fallback={<BootSplash />}>
								<FreeNote />
							</Suspense>
						}
					/>
					<Route path="/videos" element={<Videos />} />
					<Route path="/videos/:slug" element={<Videos />} />
					<Route path="/profile" element={<Profile />} />
					{/* 2048 休息小遊戲 —— 低調入口在個人頁,不進導覽列 */}
					<Route path="/play" element={<Play />} />
					<Route path="/login" element={<Navigate to="/" replace />} />
					<Route path="*" element={<NotFound />} />
				</Routes>
			</main>

			{/* 全站唯一的選字工具列:螢光標記 / 查參考資料 / AI / 存到 Telegram
			    同在一列(後兩顆按情境亮)。 */}
			<SelectionToolbar />

			{/* 番茄鐘 — 站內每一頁都在。右下角是它的位置,BackToTopFab 讓在左下。 */}
			<PomodoroFab />

			{/* 強制手機版面 — 疊在左下 BackToTopFab 上方。只在 (pointer: coarse) 的
			    裝置出現,桌機瀏覽器根本不理 viewport meta(見 lib/viewportMode.ts)。 */}
			<ViewportModeFab />

			{/* "有新版本" strip — only visible when a new SW is waiting. */}
			<UpdatePrompt />

			{/* Mobile bottom nav。撐到 md(不是 sm):640–767 這一段上面那條導覽
			    塞不下(見 header 的說明),由它接手導覽。斷點要跟 styles.css 的
			    `--bottom-nav-h` 一起改,否則 <main> 的下方留白會跟這條列對不上 ——
			    差的那一塊剛好會蓋住頁尾。 */}
			<nav className="md:hidden fixed bottom-0 left-0 right-0 bg-white dark:bg-ink-800 border-t border-ink-200 dark:border-ink-700 grid grid-cols-5 z-20 safe-bottom">
				<BottomItem to="/" Icon={HomeIcon} label="首頁" end />
				<BottomItem to="/review" Icon={BookOpen} label="複習" />
				<BottomItem to="/exam" Icon={PenLine} label="全真" />
				<BottomItem to="/search" Icon={SearchIcon} label="搜尋" />
				<BottomItem to="/bookmarks" Icon={Bookmark} label="收藏" />
			</nav>
		</div>
		</AnnotationRegistryProvider>
		</ChatProvider>
	);
}

// A thin strip rather than a toast: it has to stay visible for as long as the
// condition holds, and it must not cover the text someone is trying to read
// on the train.
function OfflineBanner() {
	const online = useOnline();
	if (online) return null;
	return (
		<div
			role="status"
			className="sticky top-14 z-20 border-l-4 border-accent bg-ink-100 dark:bg-ink-800 px-4 py-1.5 text-xs text-ink-700 dark:text-ink-200"
		>
			離線中 · 可閱讀已看過的內容,編輯功能暫停
		</div>
	);
}

function NavItem({
	to,
	end,
	className = "",
	children,
}: {
	to: string;
	end?: boolean;
	className?: string;
	children: React.ReactNode;
}) {
	return (
		<NavLink
			to={to}
			end={end}
			className={({ isActive }) =>
				`px-3 py-1.5 rounded whitespace-nowrap transition ${className} ${
					isActive
						? "text-accent font-medium"
						: "text-ink-600 dark:text-ink-300 hover:text-ink-900 dark:hover:text-ink-100 hover:bg-ink-100 dark:hover:bg-ink-700"
				}`
			}
		>
			{children}
		</NavLink>
	);
}

// Overflow menu for nav items hidden at narrow widths. Menu entries that are
// already visible inline carry the inverse `md:hidden` so nothing shows twice.
function NavMore() {
	const [open, setOpen] = useState(false);
	const ref = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!open) return;
		function onDoc(e: MouseEvent) {
			if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
		}
		document.addEventListener("mousedown", onDoc);
		return () => document.removeEventListener("mousedown", onDoc);
	}, [open]);

	const itemCls = ({ isActive }: { isActive: boolean }) =>
		`block px-3 py-1.5 whitespace-nowrap ${
			isActive
				? "text-accent font-medium"
				: "text-ink-700 dark:text-ink-300 hover:bg-ink-100 dark:hover:bg-ink-700"
		}`;

	return (
		<div ref={ref} className="relative xl:hidden">
			<button
				onClick={() => setOpen((v) => !v)}
				className="px-2.5 py-1.5 rounded flex items-center gap-0.5 whitespace-nowrap text-ink-600 dark:text-ink-300 hover:text-ink-900 dark:hover:text-ink-100 hover:bg-ink-100 dark:hover:bg-ink-700 transition"
			>
				更多
				<ChevronDown size={14} className={`transition-transform ${open ? "rotate-180" : ""}`} />
			</button>
			{open && (
				<div
					onClick={() => setOpen(false)}
					className="absolute left-0 top-full mt-1 w-32 bg-white dark:bg-ink-800 border border-ink-200 dark:border-ink-700 rounded-lg shadow-lg py-1 z-30"
				>
					{/* 這兩條的 `lg:hidden` 必須跟上面 NavItem 的 `lg:block` 對齊 ——
					    一邊改了另一邊沒改,不是重複出現就是整條到不了,而且無聲。 */}
					<NavLink to="/bookmarks" className={(s) => `lg:hidden ${itemCls(s)}`}>收藏</NavLink>
					<NavLink to="/wrong" className={(s) => `lg:hidden ${itemCls(s)}`}>錯題</NavLink>
					<NavLink to="/lectures" className={itemCls}>講義</NavLink>
					<NavLink to="/videos" className={itemCls}>影片</NavLink>
					<NavLink to="/challenges" className={itemCls}>答案挑戰</NavLink>
				</div>
			)}
		</div>
	);
}

function BottomItem({
	to,
	Icon,
	label,
	end,
}: {
	to: string;
	Icon: LucideIcon;
	label: string;
	end?: boolean;
}) {
	return (
		<NavLink
			to={to}
			end={end}
			className={({ isActive }) =>
				`flex flex-col items-center justify-center h-14 text-[11px] gap-0.5 ${
					isActive ? "text-accent" : "text-ink-500 dark:text-ink-400"
				}`
			}
		>
			<Icon size={20} />
			<span>{label}</span>
		</NavLink>
	);
}

// Persist the current route so Home can offer 「繼續上次」 after the tab (or
// browser) is closed and reopened on the same device. Skips the home page
// itself — resuming to "home" is meaningless.
function LastPathTracker() {
	const location = useLocation();
	useEffect(() => {
		const { pathname, search } = location;
		if (pathname === "/" || pathname === "/login") return;
		const path = pathname + search;
		saveLastPath(path);
		// Section memories drive the 「你上次停在…」 chips on 複習 / 全真.
		if (/^\/(q|year)\//.test(pathname)) saveSectionPath("review", path);
		// Per-year memory: opening a question also records it as that year's
		// last-seen question, so /year/:year can offer 「你上次停在…」.
		const qm = /^\/q\/((\d{3})-\d{3})$/.exec(pathname);
		if (qm) saveYearPosition(Number(qm[2]), qm[1]);
		// /exam/new 是出卷表單,不是進行中的 session — 別存成可續答的位置。
		if (/^\/exam\/[^/]+$/.test(pathname) && pathname !== "/exam/new")
			saveSectionPath("exam", path);
		// Reaching the result page means the exam is over — nothing to resume.
		if (/^\/exam\/[^/]+\/result$/.test(pathname)) clearSectionPath("exam");
	}, [location]);
	return null;
}

function NotFound() {
	return (
		<div className="max-w-md mx-auto px-4 py-20 text-center">
			<h1 className="font-serif text-4xl text-ink-900 dark:text-ink-100 mb-3">
				404
			</h1>
			<p className="text-ink-500 dark:text-ink-400">找不到頁面</p>
			<Link
				to="/"
				className="text-accent hover:text-accent-dark text-sm mt-4 inline-block"
			>
				回首頁
			</Link>
		</div>
	);
}

function BootSplash() {
	return (
		<div className="min-h-screen bg-ink-50 dark:bg-ink-900 flex items-center justify-center">
			<div className="font-serif text-3xl text-ink-400 dark:text-ink-600 animate-pulse">
				{config.brand.short_name}
			</div>
		</div>
	);
}

function LoginRedirect() {
	// The visitor hit /login while unauthed; by the time React mounts this,
	// CF Access has already set the cookie. Send them home — App.tsx will
	// re-render the authed branch as useMe resolves.
	return <Navigate to="/" replace />;
}
