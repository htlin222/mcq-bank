import { useState } from "react";
import { Archive } from "lucide-react";
import { zip } from "fflate";
import {
	fetchAllRows,
	fetchManifest,
	type BackupManifest,
} from "../../lib/backupApi";
import { buildBackupFiles } from "../../lib/backupLayout";

// 「備份我的紀錄」(#123)—— 把這個帳號的全部紀錄倒成一份巢狀 JSON 的 zip,
// 附一份 CLAUDE.md 讓 Claude 打開就看得懂。
//
// **zip 是在瀏覽器裡組的**,Worker 只出分頁 JSON。理由在 worker/routes/backup.ts:
// 單一使用者的個人筆記實測就有 35.8 MB,而 Worker free plan 一次請求只有 10ms
// CPU —— 在那裡打包不可能。
//
// 這張卡刻意跟「答題狀態分析」分開:那張是給 Excel 用的單一 CSV 長表(只有作答),
// 這張是完整的搬家用備份(題目、詳解、筆記、畫記、講義、模擬考)。

type Phase =
	| { s: "idle" }
	| { s: "counting" }
	| { s: "fetching"; label: string; rows: number }
	| { s: "zipping" }
	| { s: "done"; bytes: number }
	| { s: "error"; msg: string };

function mb(n: number) {
	return `${(n / 1048576).toFixed(1)} MB`;
}

export function BackupCard() {
	const [phase, setPhase] = useState<Phase>({ s: "idle" });
	const [manifest, setManifest] = useState<BackupManifest | null>(null);

	const busy =
		phase.s === "counting" || phase.s === "fetching" || phase.s === "zipping";

	async function run() {
		try {
			setPhase({ s: "counting" });
			const m = await fetchManifest();
			setManifest(m);

			const rows = await fetchAllRows((label, n) =>
				setPhase({ s: "fetching", label, rows: n }),
			);

			setPhase({ s: "zipping" });
			const files = buildBackupFiles(m, rows);
			const input: Record<string, Uint8Array> = {};
			const enc = new TextEncoder();
			const stamp = new Date(m.generated_at).toISOString().slice(0, 10);
			const root = `hema-2026-backup-${stamp}`;
			for (const [name, content] of Object.entries(files)) {
				input[`${root}/${name}`] = enc.encode(content);
			}

			// level 6 而不是 0:內容幾乎全是 JSON 與中文,壓縮率很高(實測 38 MB
			// 的原始資料壓完只剩幾 MB),而這是使用者會存下來的檔案。fflate 的
			// 非同步版本跑在 worker thread,壓縮期間分頁不會卡住。
			const blob = await new Promise<Blob>((resolve, reject) => {
				zip(input, { level: 6 }, (err, data) => {
					if (err) reject(err);
					else resolve(new Blob([data as BlobPart], { type: "application/zip" }));
				});
			});

			const url = URL.createObjectURL(blob);
			const a = document.createElement("a");
			a.href = url;
			a.download = `${root}.zip`;
			a.click();
			// 立刻 revoke 會讓某些瀏覽器來不及開始下載;交給下一個 task。
			setTimeout(() => URL.revokeObjectURL(url), 10_000);
			setPhase({ s: "done", bytes: blob.size });
		} catch (e: any) {
			setPhase({ s: "error", msg: e?.message || String(e) });
		}
	}

	return (
		<section
			id="profile-backup"
			className="scroll-mt-20 bg-white dark:bg-ink-800 border border-ink-200 dark:border-ink-700 rounded-lg p-6 sm:p-8 shadow-paper mt-6"
		>
			<h2 className="font-serif text-2xl text-ink-900 dark:text-ink-100 mb-2">
				備份我的紀錄
			</h2>
			<p className="text-sm text-ink-600 dark:text-ink-300 leading-relaxed mb-5">
				把你的全部紀錄打包成一個 zip:一題一個 JSON(題目、共筆詳解,加上你的
				作答、信心、筆記、畫記、收藏),外加全真模擬的每一場、講義上你標在第幾頁的
				東西,以及其他筆記。裡面附一份 <code>CLAUDE.md</code>,用 Claude
				打開整個資料夾就能直接開始分析。
			</p>
			<p className="text-sm text-ink-500 dark:text-ink-400 leading-relaxed mb-5">
				只包含<strong>你自己</strong>的紀錄 —— 個人筆記標示「僅你可見」,備份不會是
				那句話的例外。筆記裡的圖片保留原本的網址、不打包進去。
			</p>

			<button
				type="button"
				onClick={run}
				disabled={busy}
				className="inline-flex items-center gap-2 rounded bg-accent hover:bg-accent-dark text-white px-4 py-2 text-sm font-medium disabled:opacity-40"
			>
				<Archive size={16} />
				{busy ? "打包中…" : "下載備份"}
			</button>

			<div
				className="mt-4 text-sm text-ink-500 dark:text-ink-400"
				aria-live="polite"
			>
				{phase.s === "counting" && <span>正在清點…</span>}
				{phase.s === "fetching" && (
					<span>
						正在取得 {phase.label}
						{phase.rows > 0 && ` · ${phase.rows.toLocaleString()} 筆`}
					</span>
				)}
				{phase.s === "zipping" && <span>正在壓縮…</span>}
				{phase.s === "done" && (
					<span className="text-emerald-700 dark:text-emerald-400">
						已下載 · {mb(phase.bytes)}
					</span>
				)}
				{phase.s === "error" && (
					<span className="text-rose-600 dark:text-rose-400">
						備份失敗:{phase.msg}
					</span>
				)}
			</div>

			{manifest && phase.s !== "error" && (
				<dl className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-2 text-xs text-ink-500 dark:text-ink-400">
					{[
						["題目", manifest.counts.questions],
						["作答", manifest.counts.attempts],
						["題目筆記", manifest.counts.notes],
						["其他筆記", manifest.counts.free_notes],
					].map(([label, n]) => (
						<div key={label as string}>
							<dt className="inline">{label}</dt>{" "}
							<dd className="inline tabular-nums text-ink-700 dark:text-ink-200">
								{Number(n).toLocaleString()}
							</dd>
						</div>
					))}
				</dl>
			)}
		</section>
	);
}
