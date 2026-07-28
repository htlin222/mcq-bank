import { useEffect, useState } from "react";
import { CheckCircle2, ExternalLink, Loader2, Plus, XCircle } from "lucide-react";
import {
	DEFAULT_MODEL,
	FALLBACK_MODELS,
	checkHealth,
	getKey,
	getModel,
	maskKey,
	setKey as persistKey,
	setModel as persistModel,
} from "../../lib/groq";
import { BUILTIN_PROMPTS, type AiPrompt } from "../../lib/aiPrompts";
import {
	createPrompt,
	deletePrompt,
	listPrompts,
	updatePrompt,
} from "../../lib/aiPromptsApi";

// Profile 上的「AI 助手 (BYOK)」設定卡。
//
// 金鑰與模型只寫 localStorage —— 這張卡不會把金鑰送去任何地方,連我們自己的
// Worker 都不會(見 lib/groq.ts 開頭)。提示詞則相反:存雲端,跨裝置共用。
// 兩者刻意分開,所以沒設金鑰的人一樣能先把提示詞寫好。

export function AiKeyCard() {
	return (
		<div
			id="profile-ai"
			className="scroll-mt-20 bg-white dark:bg-ink-800 border border-ink-200 dark:border-ink-700 rounded-lg p-6 sm:p-8 shadow-paper mt-6"
		>
			<h2 className="font-serif text-2xl text-ink-900 dark:text-ink-100 mb-2">
				AI 助手
			</h2>
			<p className="text-sm text-ink-600 dark:text-ink-300 leading-relaxed mb-6">
				用你自己的 Groq 金鑰,在任何一段選取的文字上按「✨ AI」跑提示詞。
			</p>

			<KeySection />

			<div className="mt-6 border-t border-ink-100 dark:border-ink-700 pt-5">
				<PromptSection />
			</div>
		</div>
	);
}

// ── 金鑰 + 健康檢查 + 模型 ──

function KeySection() {
	const [key, setKey] = useState("");
	const [editing, setEditing] = useState(false);
	const [model, setModel] = useState(DEFAULT_MODEL);
	const [models, setModels] = useState<string[]>(FALLBACK_MODELS);
	const [checking, setChecking] = useState(false);
	const [result, setResult] = useState<
		{ ok: boolean; message: string } | null
	>(null);

	useEffect(() => {
		const k = getKey();
		setKey(k);
		setEditing(!k); // 還沒設過就直接開著輸入框,少一次點擊
		setModel(getModel());
	}, []);

	async function test() {
		setChecking(true);
		setResult(null);
		const r = await checkHealth(key);
		if (r.ok) {
			setResult({
				ok: true,
				message: `連線正常 · 找到 ${r.models.length} 個可用模型`,
			});
			if (r.models.length) {
				setModels(r.models);
				// 帳號沒有目前選定的模型時(常見於 Groq 下架舊版),自動落回
				// 第一個可用的,不要讓使用者卡在一個永遠 404 的設定上。
				if (!r.models.includes(model)) {
					const next = r.models.includes(DEFAULT_MODEL)
						? DEFAULT_MODEL
						: r.models[0];
					setModel(next);
					persistModel(next);
				}
			}
		} else {
			setResult({ ok: false, message: r.message });
		}
		setChecking(false);
	}

	function save(next: string) {
		setKey(next);
		persistKey(next.trim());
		setResult(null);
	}

	return (
		<div>
			<label className="block text-sm font-medium text-ink-700 dark:text-ink-200 mb-1.5">
				Groq API Key
			</label>

			<div className="flex flex-wrap items-center gap-2">
				{editing ? (
					<input
						type="password"
						value={key}
						autoComplete="off"
						spellCheck={false}
						onChange={(e) => save(e.target.value)}
						placeholder="gsk_…"
						className="flex-1 min-w-[16rem] px-3 py-2 border border-ink-200 dark:border-ink-600 dark:bg-ink-900 rounded font-mono text-sm focus:outline-none focus:border-accent text-ink-900 dark:text-ink-100 placeholder:text-ink-400"
					/>
				) : (
					<code className="flex-1 min-w-[16rem] px-3 py-2 border border-ink-200 dark:border-ink-600 dark:bg-ink-900 rounded font-mono text-sm text-ink-600 dark:text-ink-300">
						{maskKey(key)}
					</code>
				)}

				{!editing && (
					<button
						type="button"
						onClick={() => setEditing(true)}
						className="px-3 py-2 border border-ink-300 dark:border-ink-600 text-ink-700 dark:text-ink-200 hover:bg-ink-50 dark:hover:bg-ink-700 rounded text-sm transition"
					>
						更換
					</button>
				)}

				<button
					type="button"
					onClick={test}
					disabled={checking || !key.trim()}
					className="inline-flex items-center gap-1.5 px-3 py-2 bg-ink-900 hover:bg-ink-700 dark:bg-ink-700 dark:hover:bg-ink-600 text-white rounded text-sm font-medium transition disabled:opacity-40"
				>
					{checking && <Loader2 size={14} className="animate-spin" />}
					測試
				</button>

				{key && (
					<button
						type="button"
						onClick={() => {
							save("");
							setEditing(true);
						}}
						className="text-sm text-ink-500 dark:text-ink-400 hover:text-red-600 underline underline-offset-2"
					>
						清除金鑰
					</button>
				)}
			</div>

			<p className="mt-2 text-xs text-ink-500 dark:text-ink-400 leading-relaxed">
				金鑰只存在<strong>這台裝置的瀏覽器</strong>,不會上傳到伺服器。
				換裝置或清除瀏覽器資料後需要重新輸入。
			</p>

			<p className="mt-1.5 text-xs text-ink-500 dark:text-ink-400">
				還沒有金鑰?到{" "}
				<a
					href="https://console.groq.com/keys"
					target="_blank"
					rel="noreferrer"
					className="inline-flex items-center gap-0.5 text-accent hover:text-accent-dark underline underline-offset-2"
				>
					console.groq.com/keys
					<ExternalLink size={10} />
				</a>{" "}
				免費申請(需註冊帳號,免費額度足夠日常使用)。詳細用法見{" "}
				<a
					href="https://console.groq.com/docs/api-reference"
					target="_blank"
					rel="noreferrer"
					className="inline-flex items-center gap-0.5 text-accent hover:text-accent-dark underline underline-offset-2"
				>
					API 文件
					<ExternalLink size={10} />
				</a>
				。
			</p>

			{result && (
				<p
					className={`mt-3 inline-flex items-center gap-1.5 text-sm ${
						result.ok
							? "text-emerald-700 dark:text-emerald-400"
							: "text-red-600 dark:text-red-400"
					}`}
				>
					{result.ok ? <CheckCircle2 size={15} /> : <XCircle size={15} />}
					{result.message}
				</p>
			)}

			<div className="mt-5">
				<label className="block text-sm font-medium text-ink-700 dark:text-ink-200 mb-1.5">
					模型
				</label>
				<select
					value={model}
					onChange={(e) => {
						setModel(e.target.value);
						persistModel(e.target.value);
					}}
					className="px-3 py-2 border border-ink-200 dark:border-ink-600 dark:bg-ink-900 rounded text-sm font-mono text-ink-900 dark:text-ink-100 focus:outline-none focus:border-accent"
				>
					{/* 目前選定的若不在清單裡(還沒測試過、或帳號已無此模型),
					    仍要列出來,否則 select 會顯示成別的值誤導使用者。 */}
					{(models.includes(model) ? models : [model, ...models]).map((m) => (
						<option key={m} value={m}>
							{m}
						</option>
					))}
				</select>
				<p className="mt-1.5 text-xs text-ink-400 dark:text-ink-500">
					按「測試」後會換成你帳號實際可用的清單。
				</p>
			</div>
		</div>
	);
}

// ── 提示詞 ──

function PromptSection() {
	const [custom, setCustom] = useState<AiPrompt[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [drafting, setDrafting] = useState(false);

	useEffect(() => {
		listPrompts()
			.then(setCustom)
			.catch(() => setError("載入提示詞失敗"))
			.finally(() => setLoading(false));
	}, []);

	async function add(title: string, body: string) {
		try {
			const p = await createPrompt(title, body);
			setCustom((prev) => [...prev, p]);
			setDrafting(false);
			setError(null);
		} catch (e) {
			setError(errorText(e));
		}
	}

	async function edit(id: string, title: string, body: string) {
		try {
			await updatePrompt(id, title, body);
			setCustom((prev) =>
				prev.map((p) => (p.id === id ? { ...p, title, body } : p)),
			);
			setError(null);
		} catch (e) {
			setError(errorText(e));
		}
	}

	async function remove(id: string) {
		try {
			await deletePrompt(id);
			setCustom((prev) => prev.filter((p) => p.id !== id));
		} catch (e) {
			setError(errorText(e));
		}
	}

	return (
		<div>
			<p className="text-xs font-medium uppercase tracking-wide text-ink-400 dark:text-ink-500 mb-3">
				提示詞
			</p>

			<div className="mb-4">
				<p className="text-xs text-ink-500 dark:text-ink-400 mb-1.5">內建</p>
				<div className="flex flex-wrap gap-1.5">
					{BUILTIN_PROMPTS.map((p) => (
						<span
							key={p.id}
							title={p.body}
							className="px-2 py-1 rounded bg-ink-50 dark:bg-ink-900 border border-ink-200 dark:border-ink-700 text-xs text-ink-600 dark:text-ink-300"
						>
							{p.title}
						</span>
					))}
				</div>
			</div>

			<p className="text-xs text-ink-500 dark:text-ink-400 mb-1.5">我的</p>

			{loading && (
				<p className="text-sm text-ink-400">載入中…</p>
			)}

			{!loading && custom.length === 0 && !drafting && (
				<p className="text-sm text-ink-400 dark:text-ink-500">
					還沒有自訂提示詞。
				</p>
			)}

			<div className="space-y-2">
				{custom.map((p) => (
					<PromptRow
						key={p.id}
						prompt={p}
						onSave={(t, b) => edit(p.id, t, b)}
						onDelete={() => remove(p.id)}
					/>
				))}
			</div>

			{drafting ? (
				<div className="mt-2">
					<PromptEditor
						initialTitle=""
						initialBody=""
						onSave={add}
						onCancel={() => setDrafting(false)}
					/>
				</div>
			) : (
				<button
					type="button"
					onClick={() => setDrafting(true)}
					className="mt-3 inline-flex items-center gap-1 text-sm text-accent hover:text-accent-dark"
				>
					<Plus size={14} />
					新增提示詞
				</button>
			)}

			{error && (
				<p className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</p>
			)}
		</div>
	);
}

function PromptRow({
	prompt,
	onSave,
	onDelete,
}: {
	prompt: AiPrompt;
	onSave: (title: string, body: string) => void;
	onDelete: () => void;
}) {
	const [open, setOpen] = useState(false);

	if (open) {
		return (
			<PromptEditor
				initialTitle={prompt.title}
				initialBody={prompt.body}
				onSave={(t, b) => {
					onSave(t, b);
					setOpen(false);
				}}
				onCancel={() => setOpen(false)}
			/>
		);
	}

	return (
		<div className="flex items-center gap-2 px-3 py-2 border border-ink-200 dark:border-ink-700 rounded">
			<span className="flex-1 text-sm text-ink-800 dark:text-ink-200 truncate">
				{prompt.title}
			</span>
			<button
				type="button"
				onClick={() => setOpen(true)}
				className="text-xs text-ink-500 hover:text-accent underline underline-offset-2"
			>
				編輯
			</button>
			<button
				type="button"
				onClick={() => {
					if (confirm(`刪除提示詞「${prompt.title}」?`)) onDelete();
				}}
				className="text-xs text-ink-500 hover:text-red-600 underline underline-offset-2"
			>
				刪除
			</button>
		</div>
	);
}

function PromptEditor({
	initialTitle,
	initialBody,
	onSave,
	onCancel,
}: {
	initialTitle: string;
	initialBody: string;
	onSave: (title: string, body: string) => void;
	onCancel: () => void;
}) {
	const [title, setTitle] = useState(initialTitle);
	const [body, setBody] = useState(initialBody);
	const valid = title.trim().length > 0 && body.trim().length > 0;

	return (
		<div className="p-3 border border-ink-300 dark:border-ink-600 rounded space-y-2">
			<input
				value={title}
				maxLength={30}
				onChange={(e) => setTitle(e.target.value)}
				placeholder="名稱,例如「鑑別診斷」"
				className="w-full px-2.5 py-1.5 border border-ink-200 dark:border-ink-600 dark:bg-ink-900 rounded text-sm text-ink-900 dark:text-ink-100 focus:outline-none focus:border-accent"
			/>
			<textarea
				value={body}
				maxLength={2000}
				rows={4}
				onChange={(e) => setBody(e.target.value)}
				placeholder="提示詞內容…"
				className="w-full px-2.5 py-1.5 border border-ink-200 dark:border-ink-600 dark:bg-ink-900 rounded text-sm resize-y text-ink-900 dark:text-ink-100 focus:outline-none focus:border-accent"
			/>
			<p className="text-xs text-ink-400 dark:text-ink-500">
				可用變數:<code className="font-mono">{"{{selection}}"}</code> 選取的文字、
				<code className="font-mono">{"{{context}}"}</code> 選取所在的段落。
				兩者都沒寫時,選取文字會自動附在結尾。
			</p>
			<div className="flex items-center gap-2 justify-end">
				<button
					type="button"
					onClick={onCancel}
					className="px-3 py-1.5 text-sm text-ink-500 hover:text-ink-700 dark:hover:text-ink-300"
				>
					取消
				</button>
				<button
					type="button"
					disabled={!valid}
					onClick={() => onSave(title.trim(), body.trim())}
					className="px-3 py-1.5 bg-accent hover:bg-accent-dark text-white rounded text-sm font-medium disabled:opacity-40"
				>
					儲存
				</button>
			</div>
		</div>
	);
}

function errorText(e: unknown): string {
	const data = (e as { data?: { error?: string } })?.data;
	return data?.error ?? "操作失敗,請稍後再試";
}
