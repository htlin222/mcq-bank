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
} from "./lib/lastPath";
import { useMe } from "./hooks/useMe";
import { Avatar } from "./components/Avatar";
import { NotificationBell } from "./components/NotificationBell";
import { FeedbackButton } from "./components/FeedbackButton";
import { OnlineUsers } from "./components/OnlineUsers";
import { ThemeToggle } from "./components/ThemeToggle";
import { ChatProvider } from "./chat/ChatProvider";
import { ChatToaster } from "./chat/ChatToaster";
import { ChatBell } from "./chat/ChatBell";
import { Home } from "./routes/Home";
import { Landing } from "./routes/Landing";
import { Chat } from "./routes/Chat";
import { ReviewIndex } from "./routes/ReviewIndex";
import { AnkiDeck } from "./routes/AnkiDeck";
import { YearList } from "./routes/YearList";
import { Question } from "./routes/Question";
import { Exam } from "./routes/Exam";
import { ExamResult } from "./routes/ExamResult";
import { ExamHistory } from "./routes/ExamHistory";
import { Profile } from "./routes/Profile";
import { WrongQuestions } from "./routes/Lists";
import { Bookmarks } from "./routes/Bookmarks";
import { Search } from "./routes/Search";
import { Challenges } from "./routes/Challenges";

// Lazy — keeps EmbedPDF's pdfium-wasm bundle off every other route.
const Lectures = lazy(() => import("./routes/Lectures"));
const LectureReader = lazy(() => import("./routes/LectureReader"));

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
		<div className="min-h-screen bg-ink-50 dark:bg-ink-900 text-ink-800 dark:text-ink-200 flex flex-col">
			<LastPathTracker />
			<ChatToaster />
			{/* Top bar */}
			<header className="sticky top-0 z-20 bg-white/95 dark:bg-ink-800/95 backdrop-blur border-b border-ink-200 dark:border-ink-700">
				<div className="max-w-7xl mx-auto px-4 sm:px-6 h-14 flex items-center gap-3">
					<Link
						to="/"
						className="font-serif text-xl text-ink-900 dark:text-ink-100 hover:text-accent transition whitespace-nowrap"
					>
						{config.brand.short_name}
					</Link>

					{/* Desktop nav — tail items fold into a 更多 dropdown as the
					    viewport narrows, so labels never wrap into two lines. */}
					<nav className="hidden sm:flex items-center gap-1 ml-6 text-sm">
						<NavItem to="/" end>
							首頁
						</NavItem>
						<NavItem to="/review">複習</NavItem>
						<NavItem to="/exam">全真</NavItem>
						<NavItem to="/search">搜尋</NavItem>
						<NavItem to="/bookmarks" className="hidden md:block">收藏</NavItem>
						<NavItem to="/wrong" className="hidden md:block">錯題</NavItem>
						<NavItem to="/lectures" className="hidden lg:block">講義</NavItem>
						<NavItem to="/challenges" className="hidden lg:block">答案挑戰</NavItem>
						<NavMore />
					</nav>

					<div className="ml-auto flex items-center gap-2">
						<OnlineUsers />
						<ChatBell />
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
					<Route path="/anki/:year" element={<AnkiDeck />} />
					<Route path="/year/:year" element={<YearList />} />
					<Route path="/q/:id" element={<Question />} />
					<Route path="/exam" element={<Exam />} />
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
					<Route path="/profile" element={<Profile />} />
					<Route path="/login" element={<Navigate to="/" replace />} />
					<Route path="*" element={<NotFound />} />
				</Routes>
			</main>

			{/* Mobile bottom nav */}
			<nav className="sm:hidden fixed bottom-0 left-0 right-0 bg-white dark:bg-ink-800 border-t border-ink-200 dark:border-ink-700 grid grid-cols-5 z-20 safe-bottom">
				<BottomItem to="/" Icon={HomeIcon} label="首頁" end />
				<BottomItem to="/review" Icon={BookOpen} label="複習" />
				<BottomItem to="/exam" Icon={PenLine} label="全真" />
				<BottomItem to="/search" Icon={SearchIcon} label="搜尋" />
				<BottomItem to="/bookmarks" Icon={Bookmark} label="收藏" />
			</nav>
		</div>
		</ChatProvider>
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
		<div ref={ref} className="relative lg:hidden">
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
					<NavLink to="/bookmarks" className={(s) => `md:hidden ${itemCls(s)}`}>收藏</NavLink>
					<NavLink to="/wrong" className={(s) => `md:hidden ${itemCls(s)}`}>錯題</NavLink>
					<NavLink to="/lectures" className={itemCls}>講義</NavLink>
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
		if (/^\/exam\/[^/]+$/.test(pathname)) saveSectionPath("exam", path);
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
