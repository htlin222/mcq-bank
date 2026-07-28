import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
	Check,
	Copy,
	Loader2,
	NotebookPen,
	Settings,
	Square,
} from "lucide-react";
import {
	BUILTIN_PROMPTS,
	renderPrompt,
	systemPrompt,
	type AiPrompt,
} from "../../lib/aiPrompts";
import { listPrompts } from "../../lib/aiPromptsApi";
import { GroqError, hasKey, streamChat } from "../../lib/groq";
import { markdownToHtml } from "../../lib/markdown-paste";
import { appendToNote } from "../../lib/noteAppend";

// 工具列「✨ AI」展開後的內容:先選提示詞,選了就串流結果。
//
// 整段對話都在瀏覽器裡跑 —— 金鑰從 localStorage 讀出來直接打 Groq,不經過
// 我們的 Worker(見 lib/groq.ts)。

type Props = {
	selection: string;
	context: string;
	/** 在題目頁時給 question id,才會出現「存到筆記」。 */
	questionId: string | null;
};

export function AiPanel({ selection, context, questionId }: Props) {
	const [custom, setCustom] = useState<AiPrompt[]>([]);
	const [chosen, setChosen] = useState<AiPrompt | null>(null);
	const [text, setText] = useState("");
	const [running, setRunning] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const abortRef = useRef<AbortController | null>(null);
	const bodyRef = useRef<HTMLDivElement>(null);

	const keySet = hasKey();

	// 自訂提示詞來自雲端。失敗不擋路:內建四則照樣能用。
	useEffect(() => {
		let alive = true;
		listPrompts()
			.then((p) => alive && setCustom(p))
			.catch(() => {});
		return () => {
			alive = false;
		};
	}, []);

	// 卸載時中止串流,否則使用者關掉工具列後請求還在燒額度。
	useEffect(() => () => abortRef.current?.abort(), []);

	// 串流時把視窗黏在底部,新內容才不會長在看不見的地方。
	useEffect(() => {
		if (running && bodyRef.current) {
			bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
		}
	}, [text, running]);

	async function run(prompt: AiPrompt) {
		setChosen(prompt);
		setText("");
		setError(null);
		setRunning(true);
		const ctrl = new AbortController();
		abortRef.current = ctrl;
		try {
			await streamChat({
				system: systemPrompt(),
				user: renderPrompt(prompt.body, { selection, context }),
				signal: ctrl.signal,
				onDelta: (d) => setText((t) => t + d),
			});
		} catch (e) {
			setError(e instanceof GroqError ? e.message : String(e));
		} finally {
			setRunning(false);
			abortRef.current = null;
		}
	}

	if (!keySet) {
		return (
			<div className="px-3 py-4 text-sm text-ink-600 dark:text-ink-300">
				<p className="mb-2">尚未設定 Groq 金鑰。</p>
				<Link
					to="/profile"
					className="inline-flex items-center gap-1.5 text-accent-600 dark:text-accent-400 hover:underline"
				>
					<Settings size={13} />
					到設定頁輸入金鑰
				</Link>
			</div>
		);
	}

	// 尚未挑提示詞 —— 列出可選的。
	if (!chosen) {
		return (
			<div className="py-1.5">
				<PromptGroup label="內建" prompts={BUILTIN_PROMPTS} onPick={run} />
				{custom.length > 0 && (
					<PromptGroup label="我的" prompts={custom} onPick={run} />
				)}
				<Link
					to="/profile"
					className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] text-ink-400 dark:text-ink-500 hover:text-ink-600 dark:hover:text-ink-300"
				>
					<Settings size={11} />
					管理提示詞
				</Link>
			</div>
		);
	}

	return (
		<div>
			<div className="flex items-center justify-between gap-2 px-3 py-1.5 border-b border-ink-100 dark:border-ink-700">
				<span className="text-xs font-medium text-ink-500 dark:text-ink-400">
					{chosen.title}
				</span>
				<div className="flex items-center gap-1">
					{running ? (
						<button
							type="button"
							onClick={() => abortRef.current?.abort()}
							className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded text-ink-500 hover:bg-ink-100 dark:hover:bg-ink-700"
						>
							<Square size={10} />
							停止
						</button>
					) : (
						<>
							<CopyButton text={text} />
							{questionId && text && (
								<SaveToNoteButton
									questionId={questionId}
									markdown={text}
									heading={`AI · ${chosen.title}`}
								/>
							)}
							<button
								type="button"
								onClick={() => setChosen(null)}
								className="text-[11px] px-1.5 py-0.5 rounded text-ink-500 hover:bg-ink-100 dark:hover:bg-ink-700"
							>
								換一個
							</button>
						</>
					)}
				</div>
			</div>

			<div ref={bodyRef} className="px-3 py-2.5 max-h-[46vh] overflow-y-auto">
				{error && (
					<p className="text-sm text-red-600 dark:text-red-400">{error}</p>
				)}
				{!error && !text && running && (
					<div className="flex items-center gap-2 text-sm text-ink-500">
						<Loader2 size={14} className="animate-spin" />
						思考中…
					</div>
				)}
				{text && (
					// AI 輸出經 marked 轉成 HTML。內容來自使用者自己的金鑰對 Groq
					// 的回應,不是他人可控的輸入,和貼上外部 HTML 不是同一件事。
					<div
						className="tiptap text-[13px] leading-relaxed"
						// biome-ignore lint/security/noDangerouslySetInnerHtml: 見上方註解
						dangerouslySetInnerHTML={{ __html: markdownToHtml(text) }}
					/>
				)}
			</div>
		</div>
	);
}

function PromptGroup({
	label,
	prompts,
	onPick,
}: {
	label: string;
	prompts: AiPrompt[];
	onPick: (p: AiPrompt) => void;
}) {
	return (
		<div className="py-0.5">
			<div className="px-3 py-1 text-[11px] font-medium text-ink-400 dark:text-ink-500">
				{label}
			</div>
			{prompts.map((p) => (
				<button
					key={p.id}
					type="button"
					onClick={() => onPick(p)}
					className="w-full text-left px-3 py-1.5 text-[13px] text-ink-700 dark:text-ink-200 hover:bg-ink-50 dark:hover:bg-ink-700/60 transition"
				>
					{p.title}
				</button>
			))}
		</div>
	);
}

function CopyButton({ text }: { text: string }) {
	const [done, setDone] = useState(false);
	if (!text) return null;
	return (
		<button
			type="button"
			onClick={() => {
				navigator.clipboard.writeText(text).then(
					() => {
						setDone(true);
						setTimeout(() => setDone(false), 1500);
					},
					() => {},
				);
			}}
			className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded text-ink-500 hover:bg-ink-100 dark:hover:bg-ink-700"
		>
			{done ? <Check size={11} /> : <Copy size={11} />}
			{done ? "已複製" : "複製"}
		</button>
	);
}

function SaveToNoteButton({
	questionId,
	markdown,
	heading,
}: {
	questionId: string;
	markdown: string;
	heading: string;
}) {
	const [state, setState] = useState<"idle" | "saving" | "done" | "error">(
		"idle",
	);
	return (
		<button
			type="button"
			disabled={state === "saving" || state === "done"}
			onClick={async () => {
				setState("saving");
				try {
					await appendToNote(questionId, markdown, heading);
					setState("done");
				} catch {
					setState("error");
				}
			}}
			className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded text-ink-500 hover:bg-ink-100 dark:hover:bg-ink-700 disabled:opacity-60"
		>
			{state === "saving" ? (
				<Loader2 size={11} className="animate-spin" />
			) : state === "done" ? (
				<Check size={11} />
			) : (
				<NotebookPen size={11} />
			)}
			{state === "done"
				? "已加到筆記"
				: state === "error"
					? "存檔失敗"
					: "存到筆記"}
		</button>
	);
}
