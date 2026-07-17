// Skeleton placeholders. Use these wherever the app is fetching data and the
// destination shape is known — they make the loading moment feel like
// "content is on its way" rather than "the app is broken / blank".
//
// Design notes
// - Base block is `animate-pulse` (Tailwind built-in) with the ink palette so
//   it matches the paper/cream theme without strobing. No custom keyframes.
// - Always pass concrete width/height via utility classes so the skeleton
//   occupies the same box the real content will, avoiding layout jump.
// - Each shape skeleton mirrors the production component's outer styling
//   (rounded corners, border, padding) so the swap is visually seamless.
import type { HTMLAttributes } from "react";

/** Plain shimmering block. Always pass sizing utilities (h-4 w-full, …). */
export function Skeleton({
	className = "",
	...rest
}: HTMLAttributes<HTMLDivElement>) {
	return (
		<div
			aria-hidden="true"
			className={
				"animate-pulse rounded bg-ink-200/80 dark:bg-ink-700/60 " + className
			}
			{...rest}
		/>
	);
}

// ── Shape-specific skeletons ──────────────────────────────────────────────

/**
 * PDF-page placeholder. Fills the viewer area with a slide-aspect rectangle
 * carrying a few faux content lines, so the layout doesn't pop when the real
 * PDF canvas mounts. Used by both the LectureReader's pre-doc state and the
 * EmbedPDFViewer's pdfium-loading state.
 */
export function PDFPageSkeleton({ label = "載入講義中…" }: { label?: string }) {
	return (
		<div className="flex h-full w-full items-center justify-center bg-ink-50/60 p-4 sm:p-8 dark:bg-ink-900/40">
			<div className="w-full max-w-3xl">
				<div className="rounded-lg border border-ink-200 bg-white p-6 shadow-paper dark:border-ink-700 dark:bg-ink-800 sm:p-10">
					{/* Faux slide title */}
					<div className="mb-6 h-6 w-2/3 animate-pulse rounded bg-ink-200/80 dark:bg-ink-700/60" />
					{/* Faux bullet lines */}
					<div className="space-y-3">
						<div className="h-4 w-full animate-pulse rounded bg-ink-200/80 dark:bg-ink-700/60" />
						<div className="h-4 w-11/12 animate-pulse rounded bg-ink-200/80 dark:bg-ink-700/60" />
						<div className="h-4 w-5/6 animate-pulse rounded bg-ink-200/80 dark:bg-ink-700/60" />
						<div className="h-4 w-2/3 animate-pulse rounded bg-ink-200/80 dark:bg-ink-700/60" />
					</div>
					{/* Faux figure block */}
					<div className="mt-6 aspect-[16/9] w-full animate-pulse rounded bg-ink-200/60 dark:bg-ink-700/40" />
				</div>
				<p className="mt-3 text-center text-xs text-ink-400 dark:text-ink-500">
					{label}
				</p>
			</div>
		</div>
	);
}

/**
 * Lecture-card placeholder for the /lectures grid — same outer card chrome
 * as a real LectureCard so the skeleton grid is the same size as the loaded
 * one. The `count` prop lets the caller fill the visible grid area.
 */
export function LectureCardSkeleton() {
	return (
		<div className="flex flex-col rounded-lg border border-ink-200 bg-white p-4 dark:border-ink-700 dark:bg-ink-800">
			<Skeleton className="mb-2 h-5 w-3/4" />
			<Skeleton className="mb-4 h-4 w-1/2" />
			<div className="mt-auto pt-4">
				<Skeleton className="h-3 w-16" />
			</div>
		</div>
	);
}

export function LectureCardSkeletonGrid({ count = 6 }: { count?: number }) {
	return (
		<div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
			{Array.from({ length: count }, (_, i) => (
				<LectureCardSkeleton key={i} />
			))}
		</div>
	);
}

/** A list of search-result rows for the lecture search panel. */
export function LectureSearchResultSkeleton({ count = 4 }: { count?: number }) {
	return (
		<ul className="space-y-2">
			{Array.from({ length: count }, (_, i) => (
				<li
					key={i}
					className="rounded border border-ink-200 bg-white p-3 dark:border-ink-700 dark:bg-ink-800"
				>
					<div className="mb-1.5 flex items-baseline gap-3">
						<Skeleton className="h-4 w-40" />
						<Skeleton className="ml-auto h-3 w-10" />
					</div>
					<Skeleton className="mb-1 h-3 w-full" />
					<Skeleton className="h-3 w-4/5" />
				</li>
			))}
		</ul>
	);
}

/** Threaded-comment list placeholder — avatar circle + name + body lines. */
export function CommentListSkeleton({ count = 3 }: { count?: number }) {
	return (
		<ul className="space-y-4">
			{Array.from({ length: count }, (_, i) => (
				<li key={i} className="flex gap-3">
					<Skeleton className="h-9 w-9 shrink-0 rounded-full" />
					<div className="min-w-0 flex-1 space-y-2">
						<Skeleton className="h-3 w-32" />
						<Skeleton className="h-4 w-full" />
						<Skeleton className="h-4 w-5/6" />
					</div>
				</li>
			))}
		</ul>
	);
}

/** Per-page note placeholder in the lecture panel — short stack of lines. */
export function NotesSkeleton() {
	return (
		<div className="space-y-2 py-4">
			<Skeleton className="h-4 w-full" />
			<Skeleton className="h-4 w-5/6" />
			<Skeleton className="h-4 w-2/3" />
		</div>
	);
}

/**
 * Full-page question detail placeholder — mirrors the two-pane layout so the
 * header chrome + question card + tab area are all in the right spot. Avoids
 * the "blank centered 載入中…" jolt when navigating between questions.
 */
// The desktop view mode is a persisted UI pref (Question.tsx's LAYOUT_KEY). The
// skeleton reads the same key so the first-load placeholder matches whichever
// layout is about to render — a two-column split vs. a single tabbed pane —
// instead of always drawing columns and then popping into tabs.
const LAYOUT_KEY = "review-layout-mode";

function readLayout(): "columns" | "tabs" {
	try {
		return localStorage.getItem(LAYOUT_KEY) === "tabs" ? "tabs" : "columns";
	} catch {
		return "columns";
	}
}

/** Header row: back link on the left, prev/next on the right. Shared by both. */
function SkeletonHeader() {
	return (
		<header className="mb-6 flex items-center justify-between gap-3 text-sm">
			<Skeleton className="h-4 w-24" />
			<div className="flex gap-3">
				<Skeleton className="h-4 w-12" />
				<Skeleton className="h-4 w-12" />
			</div>
		</header>
	);
}

/** Question-card body: id/badge row, stem lines, four option blocks. */
function QuestionCardSkeleton() {
	return (
		<div className="rounded-lg border border-ink-200 bg-white p-5 shadow-paper dark:border-ink-700 dark:bg-ink-800 sm:p-7">
			<div className="mb-3 flex items-center gap-2">
				<Skeleton className="h-4 w-16" />
				<Skeleton className="h-4 w-12" />
			</div>
			<Skeleton className="mb-2 h-4 w-full" />
			<Skeleton className="mb-2 h-4 w-full" />
			<Skeleton className="mb-5 h-4 w-3/4" />
			<div className="space-y-2">
				<Skeleton className="h-10 w-full" />
				<Skeleton className="h-10 w-full" />
				<Skeleton className="h-10 w-full" />
				<Skeleton className="h-10 w-full" />
			</div>
		</div>
	);
}

export function QuestionDetailSkeleton() {
	// Single full-width pane behind a 5-tab strip (題目/詳解/筆記/討論/相似題).
	if (readLayout() === "tabs") {
		return (
			<div className="mx-auto max-w-3xl px-4 py-6 sm:px-6 sm:py-8 md:max-w-4xl lg:max-w-5xl lg:px-8">
				<SkeletonHeader />
				<div className="mb-4 flex items-center gap-4 border-b border-ink-200 dark:border-ink-700 pb-px">
					<Skeleton className="h-7 w-16" />
					<Skeleton className="h-7 w-20" />
					<Skeleton className="h-7 w-16" />
					<Skeleton className="hidden h-7 w-16 md:block" />
					<Skeleton className="hidden h-7 w-16 md:block" />
				</div>
				<QuestionCardSkeleton />
			</div>
		);
	}

	// Two-column split: question card left, tabs + content right.
	return (
		<div className="mx-auto max-w-3xl px-4 py-6 sm:px-6 sm:py-8 md:max-w-4xl lg:max-w-6xl lg:px-8 xl:max-w-[88rem] 2xl:max-w-[104rem]">
			<SkeletonHeader />
			<div className="lg:grid lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:items-start lg:gap-8">
				{/* Left: question card */}
				<QuestionCardSkeleton />

				{/* Right: tabs + content area */}
				<div className="mt-8 lg:mt-0">
					<div className="mb-3 flex items-center gap-4 border-b border-ink-200 dark:border-ink-700">
						<Skeleton className="h-7 w-20" />
						<Skeleton className="h-7 w-20" />
						<Skeleton className="hidden h-7 w-24 lg:block" />
					</div>
					<div className="rounded-lg border border-ink-200 bg-white p-5 shadow-paper dark:border-ink-700 dark:bg-ink-800 sm:p-7">
						<Skeleton className="mb-2 h-4 w-full" />
						<Skeleton className="mb-2 h-4 w-full" />
						<Skeleton className="mb-2 h-4 w-11/12" />
						<Skeleton className="mb-2 h-4 w-5/6" />
						<Skeleton className="h-4 w-2/3" />
					</div>
				</div>
			</div>
		</div>
	);
}
