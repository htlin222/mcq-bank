import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft, Search as SearchIcon, Undo2 } from "lucide-react";
import { api } from "../lib/api";
import { VideoCard, type Video } from "../components/VideoList";

// 影片庫。兩個用途:按主題瀏覽,以及清垃圾 —— 「已移除」分頁可以還原誤刪。

type TopicSummary = {
	slug: string;
	label: string;
	kind: string;
	video_count: number;
	cover_key: string | null;
};

type RemovedVideo = {
	id: string;
	title: string;
	channel: string;
	thumb_key: string | null;
	removed_by: string;
	removed_at: number;
};

const KIND_LABEL: Record<string, string> = {
	treatment: "治療",
	mechanism: "機轉",
};

export default function Videos() {
	const { slug } = useParams<{ slug?: string }>();
	return slug ? <TopicDetail slug={slug} /> : <TopicIndex />;
}

// ---------- 主題列表 ----------

function TopicIndex() {
	const [topics, setTopics] = useState<TopicSummary[] | null>(null);
	const [q, setQ] = useState("");
	const [showRemoved, setShowRemoved] = useState(false);

	useEffect(() => {
		api
			.get<{ topics: TopicSummary[] }>("/api/videos/topics")
			.then((r) => setTopics(r.topics ?? []))
			.catch(() => setTopics([]));
	}, []);

	const filtered = useMemo(() => {
		if (!topics) return [];
		const needle = q.trim().toLowerCase();
		if (!needle) return topics;
		return topics.filter(
			(t) =>
				t.label.toLowerCase().includes(needle) ||
				t.slug.toLowerCase().includes(needle),
		);
	}, [topics, q]);

	const total = topics?.reduce((n, t) => n + t.video_count, 0) ?? 0;

	return (
		<div className="mx-auto max-w-5xl px-4 py-8">
			<header className="mb-6">
				<h1 className="font-serif text-2xl text-ink-800 dark:text-ink-100">
					教學影片庫
				</h1>
				<p className="mt-1 text-sm text-ink-500 dark:text-ink-400">
					{topics === null
						? "載入中…"
						: `${topics.length} 個主題 · ${total} 支影片。題目頁的「影片」tab 就是從這裡依標籤取出來的。`}
				</p>
			</header>

			<div className="mb-6 flex flex-wrap items-center gap-3">
				<label className="relative flex-1 min-w-[14rem]">
					<SearchIcon
						size={15}
						className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-400"
					/>
					<input
						value={q}
						onChange={(e) => setQ(e.target.value)}
						placeholder="搜尋主題…"
						className="w-full rounded border border-ink-200 bg-white py-2 pl-9 pr-3 text-sm dark:border-ink-700 dark:bg-ink-800"
					/>
				</label>
				<button
					type="button"
					onClick={() => setShowRemoved((v) => !v)}
					className={
						"rounded border px-3 py-2 text-sm transition " +
						(showRemoved
							? "border-accent text-accent"
							: "border-ink-200 text-ink-500 hover:text-accent dark:border-ink-700 dark:text-ink-400")
					}
				>
					已移除
				</button>
			</div>

			{showRemoved ? (
				<RemovedList />
			) : (
				<ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
					{filtered.map((t) => (
						<li key={t.slug}>
							<Link
								to={`/videos/${t.slug}`}
								className="group block overflow-hidden rounded-lg border border-ink-200 bg-white transition hover:border-accent dark:border-ink-700 dark:bg-ink-800"
							>
								<div className="aspect-video bg-ink-100 dark:bg-ink-900">
									{t.cover_key && (
										<img
											src={`/img/${t.cover_key}`}
											alt=""
											loading="lazy"
											className="h-full w-full object-cover"
										/>
									)}
								</div>
								<div className="p-2.5">
									<p className="text-sm font-medium leading-snug text-ink-800 line-clamp-2 group-hover:text-accent dark:text-ink-100">
										{t.label}
									</p>
									<p className="mt-1 text-[11px] text-ink-400 dark:text-ink-500">
										{KIND_LABEL[t.kind] ?? t.kind} · {t.video_count} 支
									</p>
								</div>
							</Link>
						</li>
					))}
					{topics !== null && filtered.length === 0 && (
						<li className="col-span-full text-sm text-ink-400 dark:text-ink-500">
							{topics.length === 0
								? "還沒有策展資料。跑 scripts/curate-videos.py 產生。"
								: "沒有符合的主題。"}
						</li>
					)}
				</ul>
			)}
		</div>
	);
}

// ---------- 已移除 ----------

function RemovedList() {
	const [rows, setRows] = useState<RemovedVideo[] | null>(null);

	useEffect(() => {
		api
			.get<{ videos: RemovedVideo[] }>("/api/videos/removed")
			.then((r) => setRows(r.videos ?? []))
			.catch(() => setRows([]));
	}, []);

	async function restore(id: string) {
		await api.post(`/api/videos/${id}/restore`);
		setRows((rs) => (rs ?? []).filter((r) => r.id !== id));
	}

	if (rows === null) return <p className="text-sm text-ink-400">載入中…</p>;
	if (rows.length === 0)
		return (
			<p className="text-sm text-ink-400 dark:text-ink-500">
				沒有被移除的影片。
			</p>
		);

	return (
		<ul className="space-y-2">
			{rows.map((r) => (
				<li
					key={r.id}
					className="flex items-center gap-3 rounded border border-ink-200 bg-white p-2.5 dark:border-ink-700 dark:bg-ink-800"
				>
					<div className="h-12 w-20 shrink-0 overflow-hidden rounded bg-ink-100 dark:bg-ink-900">
						{r.thumb_key && (
							<img
								src={`/img/${r.thumb_key}`}
								alt=""
								className="h-full w-full object-cover"
							/>
						)}
					</div>
					<div className="min-w-0 flex-1">
						<p className="truncate text-sm text-ink-700 dark:text-ink-200">
							{r.title}
						</p>
						<p className="text-[11px] text-ink-400 dark:text-ink-500">
							{r.channel} · {r.removed_by} 於{" "}
							{new Date(r.removed_at).toLocaleDateString("zh-TW")} 移除
						</p>
					</div>
					<button
						type="button"
						onClick={() => restore(r.id)}
						className="inline-flex shrink-0 items-center gap-1.5 rounded border border-ink-200 px-3 py-1.5 text-xs text-ink-600 transition hover:border-accent hover:text-accent dark:border-ink-700 dark:text-ink-300"
					>
						<Undo2 size={13} /> 還原
					</button>
				</li>
			))}
		</ul>
	);
}

// ---------- 單一主題 ----------

function TopicDetail({ slug }: { slug: string }) {
	const [data, setData] = useState<{
		topic: TopicSummary;
		videos: Video[];
	} | null>(null);
	const [missing, setMissing] = useState(false);

	useEffect(() => {
		setData(null);
		setMissing(false);
		api
			.get<{ topic: TopicSummary; videos: Video[] }>(
				`/api/videos/topics/${slug}`,
			)
			.then(setData)
			.catch(() => setMissing(true));
	}, [slug]);

	function drop(id: string) {
		setData((d) =>
			d ? { ...d, videos: d.videos.filter((v) => v.id !== id) } : d,
		);
	}

	return (
		<div className="mx-auto max-w-5xl px-4 py-8">
			<Link
				to="/videos"
				className="mb-4 inline-flex items-center gap-1.5 text-sm text-ink-500 hover:text-accent dark:text-ink-400"
			>
				<ArrowLeft size={15} /> 影片庫
			</Link>
			{missing ? (
				<p className="text-sm text-ink-400">找不到這個主題。</p>
			) : data === null ? (
				<p className="text-sm text-ink-400">載入中…</p>
			) : (
				<>
					<h1 className="font-serif text-2xl text-ink-800 dark:text-ink-100">
						{data.topic.label}
					</h1>
					<p className="mt-1 mb-6 text-sm text-ink-500 dark:text-ink-400">
						{KIND_LABEL[data.topic.kind] ?? data.topic.kind} ·{" "}
						{data.videos.length} 支
					</p>
					<ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
						{data.videos.map((v) => (
							<VideoCard key={v.id} video={v} onRemoved={drop} />
						))}
					</ul>
				</>
			)}
		</div>
	);
}
