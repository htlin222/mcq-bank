import { useState } from "react";
import { Play, Trash2, Eye, Clock } from "lucide-react";
import { api } from "../lib/api";

// 策展影片的卡片與清單。題目頁的「影片」tab 與 /videos 影片庫共用。
//
// iframe 是點擊後才掛上去的 —— 一個主題八張卡,預載八個 YouTube player
// 等於每次開題目頁就對 Google 發八次請求,也把頁面拖垮。

export type Video = {
	id: string;
	title: string;
	channel: string;
	duration_s: number;
	view_count: number;
	upload_date: string | null;
	thumb_key: string | null;
	ai_score: number | null;
	ai_reason: string | null;
};

export type VideoTopicGroup = {
	slug: string;
	label: string;
	kind: string;
	videos: Video[];
};

function fmtDuration(s: number): string {
	const m = Math.floor(s / 60);
	const sec = s % 60;
	if (m >= 60) return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
	return `${m}:${String(sec).padStart(2, "0")}`;
}

function fmtViews(n: number): string {
	if (n >= 100_000_000) return `${(n / 100_000_000).toFixed(1).replace(".0", "")} 億`;
	if (n >= 10_000) return `${(n / 10_000).toFixed(1).replace(".0", "")} 萬`;
	return n.toLocaleString("zh-TW");
}

function fmtYear(d: string | null): string | null {
	return d && d.length === 8 ? d.slice(0, 4) : null;
}

export function VideoCard({
	video,
	onRemoved,
}: {
	video: Video;
	onRemoved?: (id: string) => void;
}) {
	const [playing, setPlaying] = useState(false);
	const [removing, setRemoving] = useState(false);
	const year = fmtYear(video.upload_date);

	async function remove() {
		if (!confirm(`要把「${video.title}」從所有主題移除嗎?\n(可在影片庫的「已移除」還原)`))
			return;
		setRemoving(true);
		try {
			await api.del(`/api/videos/${video.id}`);
			onRemoved?.(video.id);
		} catch (e) {
			alert(`移除失敗:${e}`);
			setRemoving(false);
		}
	}

	return (
		<li
			className={
				"group relative bg-white dark:bg-ink-800 border border-ink-200 dark:border-ink-700 rounded-lg overflow-hidden transition hover:border-accent " +
				(removing ? "opacity-40 pointer-events-none" : "")
			}
		>
			{playing ? (
				<div className="relative w-full aspect-video bg-black">
					<iframe
						className="absolute inset-0 h-full w-full"
						src={`https://www.youtube-nocookie.com/embed/${video.id}?autoplay=1&rel=0`}
						title={video.title}
						allow="accelerometer; autoplay; clipboard-write; encrypted-media; picture-in-picture"
						allowFullScreen
					/>
				</div>
			) : (
				<button
					type="button"
					onClick={() => setPlaying(true)}
					className="relative block w-full aspect-video bg-ink-100 dark:bg-ink-900"
					aria-label={`播放 ${video.title}`}
				>
					{video.thumb_key ? (
						<img
							src={`/img/${video.thumb_key}`}
							alt=""
							loading="lazy"
							className="absolute inset-0 h-full w-full object-cover"
						/>
					) : null}
					<span className="absolute inset-0 flex items-center justify-center bg-black/20 opacity-0 transition group-hover:opacity-100">
						<span className="rounded-full bg-white/90 p-3 text-ink-900">
							<Play size={20} fill="currentColor" />
						</span>
					</span>
					<span className="absolute bottom-1.5 right-1.5 rounded bg-black/75 px-1.5 py-0.5 font-mono text-[11px] text-white">
						{fmtDuration(video.duration_s)}
					</span>
				</button>
			)}

			<div className="p-3">
				<a
					href={`https://www.youtube.com/watch?v=${video.id}`}
					target="_blank"
					rel="noopener noreferrer"
					className="block text-sm font-medium leading-snug text-ink-800 dark:text-ink-100 line-clamp-2 hover:text-accent"
					title={video.title}
				>
					{video.title}
				</a>
				<p className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] text-ink-500 dark:text-ink-400">
					<span className="truncate max-w-[10rem]">{video.channel}</span>
					<span className="inline-flex items-center gap-1">
						<Eye size={11} /> {fmtViews(video.view_count)}
					</span>
					{year && (
						<span className="inline-flex items-center gap-1">
							<Clock size={11} /> {year}
						</span>
					)}
				</p>
				{video.ai_reason && (
					<p className="mt-2 border-l-2 border-accent/40 pl-2 text-[11px] leading-relaxed text-ink-600 dark:text-ink-300">
						{video.ai_reason}
					</p>
				)}
			</div>

			{onRemoved && (
				<button
					type="button"
					onClick={remove}
					title="這支不好 — 從所有主題移除"
					className="absolute right-1.5 top-1.5 rounded-full bg-black/60 p-1.5 text-white opacity-0 transition hover:bg-red-600 focus:opacity-100 group-hover:opacity-100"
				>
					<Trash2 size={13} />
				</button>
			)}
		</li>
	);
}

// 一個主題一段。預設只展開前 COLLAPSED_N 支 —— 一題常對到 2–5 個主題,
// 全部攤開會是四十張卡。
const COLLAPSED_N = 3;

export function VideoTopicSection({
	group,
	onRemoved,
}: {
	group: VideoTopicGroup;
	onRemoved?: (id: string) => void;
}) {
	const [expanded, setExpanded] = useState(false);
	const shown = expanded ? group.videos : group.videos.slice(0, COLLAPSED_N);
	const hidden = group.videos.length - shown.length;

	return (
		<section className="mt-6 first:mt-0">
			<h3 className="mb-2.5 flex items-baseline gap-2 text-sm font-medium text-ink-700 dark:text-ink-200">
				{group.label}
				<span className="font-sans text-xs text-ink-400 dark:text-ink-500">
					({group.videos.length})
				</span>
			</h3>
			<ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
				{shown.map((v) => (
					<VideoCard key={v.id} video={v} onRemoved={onRemoved} />
				))}
			</ul>
			{hidden > 0 && (
				<button
					type="button"
					onClick={() => setExpanded(true)}
					className="mt-2 text-xs text-accent hover:underline"
				>
					顯示其餘 {hidden} 支
				</button>
			)}
		</section>
	);
}
