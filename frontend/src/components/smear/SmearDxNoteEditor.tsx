import { useEffect, useState } from "react";
import { ApiError } from "../../lib/api";
import { isEmptyDoc } from "../../lib/drafts";
import {
	lockSmearDxNote,
	saveSmearDxNote,
	unlockSmearDxNote,
	type SmearDxNote,
} from "../../lib/smearApi";
import { RichEditor } from "../RichEditor";
import { StaticContent } from "../StaticContent";

const RENEW_MS = 60_000;

function parseDoc(raw: string | undefined): unknown | null {
	if (!raw) return null;
	try {
		return JSON.parse(raw);
	} catch {
		return null;
	}
}

/**
 * 診斷頁的共筆詳解。只有管理員看得到編輯;別人持鎖時顯示「正在編輯」,
 * 不開編輯器。存檔帶預期版本,寫入者記在 updated_by。
 */
export function SmearDxNoteEditor({
	dxId,
	note,
	isAdmin,
	myEmail,
	onSaved,
}: {
	dxId: string;
	note: SmearDxNote | null;
	isAdmin: boolean;
	myEmail: string | null;
	onSaved: (note: SmearDxNote) => void;
}) {
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState<unknown>(null);
	const [busy, setBusy] = useState(false);
	const [banner, setBanner] = useState<string | null>(null);

	useEffect(() => {
		setEditing(false);
		setDraft(null);
		setBanner(null);
	}, [dxId]);

	useEffect(() => {
		if (!editing) return;
		const timer = window.setInterval(() => {
			lockSmearDxNote(dxId).catch((e) => {
				if (e instanceof ApiError && e.status === 423) {
					setBanner(`${e.data?.locked_by ?? "其他人"} 正在編輯`);
				}
			});
		}, RENEW_MS);
		return () => window.clearInterval(timer);
	}, [editing, dxId]);

	const doc = parseDoc(note?.content_json);
	const empty = !doc || isEmptyDoc(doc);
	const lockedByOther =
		!!note?.editing_by &&
		note.editing_by !== myEmail &&
		(note.editing_until ?? 0) > Date.now();

	async function startEdit() {
		if (!note || !isAdmin || lockedByOther) return;
		setBusy(true);
		setBanner(null);
		try {
			await lockSmearDxNote(dxId);
			setDraft(doc ?? { type: "doc", content: [] });
			setEditing(true);
		} catch (e) {
			if (e instanceof ApiError && e.status === 423) {
				setBanner(`${e.data?.locked_by ?? "其他人"} 正在編輯`);
			} else {
				setBanner(e instanceof ApiError ? `無法開始編輯 (${e.status})` : String(e));
			}
		} finally {
			setBusy(false);
		}
	}

	async function cancel() {
		setBusy(true);
		try {
			await unlockSmearDxNote(dxId);
		} catch {
			/* 鎖會在 5 分鐘後自己過期 */
		} finally {
			setEditing(false);
			setDraft(null);
			setBusy(false);
		}
	}

	async function save() {
		if (!note || draft == null) return;
		setBusy(true);
		setBanner(null);
		try {
			const res = await saveSmearDxNote(dxId, draft, note.version);
			const next: SmearDxNote = {
				...note,
				content_json: JSON.stringify(draft),
				version: res.version,
				updated_by: res.updated_by,
				updated_at: res.updated_at,
				editing_by: null,
				editing_until: null,
			};
			onSaved(next);
			setEditing(false);
			setDraft(null);
		} catch (e) {
			if (e instanceof ApiError && e.status === 423) {
				setBanner(`${e.data?.locked_by ?? "其他人"} 正在編輯`);
			} else if (e instanceof ApiError && e.status === 409) {
				setBanner("這份詳解已經有人存過,請重整後再改。");
			} else {
				setBanner(e instanceof ApiError ? `儲存失敗 (${e.status})` : String(e));
			}
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="space-y-3">
			{(banner || lockedByOther) && (
				<p className="text-sm text-accent break-words">
					{banner ?? `${note?.editing_by} 正在編輯`}
				</p>
			)}
			{editing ? (
				<div className="space-y-2">
					<RichEditor
						content={draft}
						autofocus
						onChange={setDraft}
						placeholder="寫下這個診斷的詳解…"
					/>
					<div className="flex justify-end gap-2">
						<button
							type="button"
							onClick={cancel}
							disabled={busy}
							className="px-3 py-1.5 text-sm text-ink-600 dark:text-ink-300 hover:text-ink-800 dark:hover:text-ink-100 disabled:opacity-50"
						>
							取消
						</button>
						<button
							type="button"
							onClick={save}
							disabled={busy}
							className="px-4 py-1.5 text-sm bg-accent text-white rounded hover:bg-accent-dark disabled:opacity-50"
						>
							{busy ? "儲存中…" : "儲存"}
						</button>
					</div>
				</div>
			) : empty ? (
				<p className="text-sm text-ink-400 dark:text-ink-500">詳解尚未建立。</p>
			) : (
				<StaticContent content={doc} />
			)}
			{isAdmin && !editing && note && !lockedByOther && (
				<button
					type="button"
					onClick={startEdit}
					disabled={busy}
					className="text-sm text-accent hover:text-accent-dark disabled:opacity-50"
				>
					編輯詳解
				</button>
			)}
		</div>
	);
}
