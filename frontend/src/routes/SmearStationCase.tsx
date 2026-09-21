import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { ArrowLeft, ArrowRight, Check } from "lucide-react";
import { SmearImage } from "../components/smear/SmearImage";
import {
	fetchStationCase,
	answerStationCase,
	SMEAR_MODALITY_LABELS,
	type SmearStationCase,
	type SmearStationVerdict,
} from "../lib/smearApi";

/**
 * 跑台作答頁。設計:docs/plans/2026-09-09-smear-station-design.md
 *
 * 一個迴圈:看圖 → 寫下你看到什麼 → 下一張(**沒有任何回饋**)→ … → 下診斷
 * → 一次揭曉全部。
 *
 * ⚠️ 「中途不回饋」不是省事,是刻意的。真的跑台不會看一張就有人告訴你對不對,
 * 而且 ASH 那批案例本來就沒有逐張說明 —— 兩種來源給不同節奏的話,使用者會
 * 以為某些案壞了。
 *
 * ⚠️ 揭曉前這一頁不該有任何說明文字存在於 DOM 裡。伺服器那邊 GET 就不回,
 * 這裡也不要為了「先抓起來比較快」去預抓 —— e2e 掃的是整頁原始碼。
 */
export function SmearStationCase() {
	const { id = "" } = useParams();
	const [data, setData] = useState<SmearStationCase | null>(null);
	const [err, setErr] = useState<string | null>(null);
	const [step, setStep] = useState(0);
	const [notes, setNotes] = useState<Record<string, string>>({});
	const [typed, setTyped] = useState("");
	const [verdict, setVerdict] = useState<SmearStationVerdict | null>(null);
	// ⚠️ 送出失敗跟載入失敗要分開。共用一個 err 的話,送出失敗會把整頁換成
	//    「載入失敗」—— 使用者整輪打的逐張筆記就這樣沒了,而且沒有重試。
	const [submitErr, setSubmitErr] = useState<string | null>(null);
	const [sending, setSending] = useState(false);
	const topRef = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		setData(null);
		setStep(0);
		setNotes({});
		setTyped("");
		setVerdict(null);
		// ⚠️ err 也要清。不清的話 `if (err) return` 會在換到下一案時照樣擋在前面
		//    (React Router 重用同一個元件,不重新掛載),而資料其實已經抓回來了。
		setErr(null);
		setSubmitErr(null);
		fetchStationCase(id)
			.then(setData)
			.catch((e) => setErr(String(e)));
	}, [id]);

	const steps = data?.steps ?? [];
	const atLast = step >= steps.length - 1;
	const cur = steps[step];

	const revealById = useMemo(() => {
		const m = new Map<number, string | null>();
		for (const r of verdict?.reveals ?? []) m.set(r.idx, r.reveal_note);
		return m;
	}, [verdict]);

	// 換一張圖要捲回頂端,否則長病史底下按「下一張」看起來像沒反應
	// —— 同 Question.tsx 的 goNote()。
	function go(next: number) {
		setStep(next);
		topRef.current?.scrollIntoView({ block: "start" });
	}

	async function submit() {
		if (sending) return;
		setSending(true);
		setSubmitErr(null);
		try {
			const v = await answerStationCase(id, {
				typed,
				notes,
				// steps_seen 是「看到第幾張才敢下診斷」,client 自報。它不計分,
				// 所以不需要防作弊 —— 同 play-2048 的「只防資料汙染」。
				steps_seen: step + 1,
			});
			setVerdict(v);
			topRef.current?.scrollIntoView({ block: "start" });
		} catch (e) {
			setSubmitErr(String(e));
		} finally {
			setSending(false);
		}
	}

	if (err) return <p className="p-4 text-sm text-accent dark:text-accent-light">載入失敗:{err}</p>;
	if (!data) return <p className="p-4 text-sm text-ink-500">載入中…</p>;

	return (
		<div className="max-w-3xl mx-auto px-4 py-5" ref={topRef}>
			<Link
				to="/smear/station"
				className="inline-flex items-center gap-1 text-sm text-ink-500 hover:text-accent"
			>
				<ArrowLeft size={15} /> 回跑台清單
			</Link>

			{data.history_md && (
				<section className="mt-3 rounded-lg border border-ink-200 dark:border-ink-700 p-4 eink:border-2">
					<h2 className="text-sm font-semibold mb-2">臨床病史</h2>
					<div className="text-sm leading-relaxed text-ink-700 dark:text-ink-200 space-y-1 min-w-0 break-words">
						{data.history_md.split("\n").map((l, i) => (
							<p key={i}>{l}</p>
						))}
					</div>
				</section>
			)}

			{!verdict && cur && (
				<section className="mt-4">
					<div className="flex items-center justify-between mb-2">
						<h2 className="text-sm font-semibold">
							第 {step + 1} / {steps.length} 張
							{cur.modality.length > 0 && (
								<span className="ml-2 font-normal text-ink-500">
									{cur.modality.map((m) => SMEAR_MODALITY_LABELS[m] ?? m).join(" / ")}
								</span>
							)}
						</h2>
						{cur.caption && <span className="text-xs text-ink-500">{cur.caption}</span>}
					</div>

					<SmearImage viewKey={cur.image_key_view} fullKey={cur.image_key_full} />

					<label className="block mt-3">
						<span className="text-sm font-medium">你看到什麼?</span>
						<textarea
							value={notes[String(cur.idx)] ?? ""}
							onChange={(e) => setNotes((n) => ({ ...n, [String(cur.idx)]: e.target.value }))}
							rows={3}
							placeholder="寫下這一張的所見。不會判分,下完診斷才會跟原文並排。"
							className="mt-1 w-full rounded-md border border-ink-300 dark:border-ink-600 bg-transparent
                         px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
						/>
					</label>

					<div className="mt-3 flex items-center gap-2">
						<button
							type="button"
							disabled={step === 0}
							onClick={() => go(step - 1)}
							className="rounded-md border border-ink-300 dark:border-ink-600 px-3 py-2 text-sm
                         disabled:opacity-40"
						>
							上一張
						</button>
						{!atLast && (
							<button
								type="button"
								onClick={() => go(step + 1)}
								className="inline-flex items-center gap-1 rounded-md bg-accent px-3 py-2 text-sm text-white"
							>
								下一張 <ArrowRight size={15} />
							</button>
						)}
					</div>

					<div className="mt-5 rounded-lg border border-ink-200 dark:border-ink-700 p-4 eink:border-2">
						<label className="block">
							<span className="text-sm font-semibold">你的診斷</span>
							<input
								value={typed}
								onChange={(e) => setTyped(e.target.value)}
								placeholder="拼出診斷名稱"
								className="mt-1 w-full rounded-md border border-ink-300 dark:border-ink-600
                           bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
							/>
						</label>
						<p className="mt-2 text-xs text-ink-500">
							不必看完全部才作答 —— 你看了幾張會一起記下來。
						</p>
						{submitErr && (
							<p className="mt-2 text-sm text-accent dark:text-accent-light">
								送出失敗:{submitErr} —— 你寫的內容還在,再按一次即可。
							</p>
						)}
						<button
							type="button"
							disabled={sending || typed.trim() === ""}
							onClick={submit}
							className="mt-3 inline-flex items-center gap-1 rounded-md bg-accent px-4 py-2
                         text-sm text-white disabled:opacity-40"
						>
							<Check size={15} /> 送出診斷並揭曉
						</button>
					</div>
				</section>
			)}

			{verdict && (
				<section className="mt-4 space-y-4">
					<div className="rounded-lg border-2 border-ink-300 dark:border-ink-600 p-4">
						<p className="text-sm">
							<strong className="font-semibold">
								{verdict.tier === "full"
									? "✓ 完全正確"
									: verdict.tier === "half"
										? "◐ 部分正確"
										: verdict.tier === "lay"
											? "~ 俗名"
											: "✗ 沒有命中"}
							</strong>
							{verdict.canonical && (
								<span className="ml-2 text-ink-600 dark:text-ink-300">
									正解:{verdict.canonical}
								</span>
							)}
						</p>
						{verdict.spellingErrors.length > 0 && (
							<p className="mt-1 text-xs text-ink-500">
								拼寫:
								{verdict.spellingErrors
									.map((s) => `${s.typed} → ${s.expected}`)
									.join("、")}
							</p>
						)}
					</div>

					<div>
						<h2 className="text-sm font-semibold mb-2">逐張對照</h2>
						<ul className="space-y-3">
							{steps.map((s) => (
								<li
									key={s.idx}
									className="rounded-lg border border-ink-200 dark:border-ink-700 p-3 eink:border-2"
								>
									<p className="text-xs text-ink-500 mb-2">
										第 {s.idx + 1} 張
										{s.caption ? ` · ${s.caption}` : ""}
									</p>
									<div className="grid gap-3 sm:grid-cols-2">
										<div className="min-w-0">
											<p className="text-xs font-medium text-ink-500 mb-1">你寫的</p>
											<p className="text-sm break-words whitespace-pre-wrap">
												{notes[String(s.idx)]?.trim() || "（沒寫）"}
											</p>
										</div>
										<div className="min-w-0">
											<p className="text-xs font-medium text-ink-500 mb-1">原文</p>
											<p className="text-sm break-words whitespace-pre-wrap">
												{revealById.get(s.idx) || "（這一張沒有附說明）"}
											</p>
										</div>
									</div>
								</li>
							))}
						</ul>
					</div>

					{verdict.discussion && verdict.discussion.length > 0 && (
						<div>
							<h2 className="text-sm font-semibold mb-2">整案討論</h2>
							<div className="space-y-2 text-sm leading-relaxed text-ink-700 dark:text-ink-200">
								{verdict.discussion.map((p, i) => (
									<p key={i} className="min-w-0 break-words">
										{p}
									</p>
								))}
							</div>
						</div>
					)}

					<div className="flex flex-wrap gap-2">
						<Link
							to={`/smear/dx/${encodeURIComponent(verdict.dx_id)}`}
							className="rounded-md border border-ink-300 dark:border-ink-600 px-3 py-2 text-sm"
						>
							看這個診斷的詳解
						</Link>
						<Link
							to="/smear/station"
							className="rounded-md bg-accent px-3 py-2 text-sm text-white"
						>
							下一個案例
						</Link>
					</div>

					{data.attribution && (
						<p className="text-xs text-ink-400">
							圖片來源:{data.attribution}
							{data.source_ref ? ` · ${data.source_ref}` : ""}
						</p>
					)}
				</section>
			)}
		</div>
	);
}
