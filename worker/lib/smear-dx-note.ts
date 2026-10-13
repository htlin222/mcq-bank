/** 抹片共筆詳解的鎖與存檔(#251)。語意對齊筆試詳解:5 分鐘、同一人可續鎖。 */

export const SMEAR_NOTE_LOCK_MS = 5 * 60 * 1000;

export type SmearNoteLockRow = {
	editing_by: string | null;
	editing_until: number | null;
	version?: number;
};

/**
 * 條件更新,避免「先讀到沒人鎖、兩個人都寫成功」。
 * 綁定順序:email, until, dxId, email, now。
 */
export const SMEAR_NOTE_LOCK_SQL =
	"UPDATE smear_dx_notes SET editing_by = ?, editing_until = ? WHERE dx_id = ? AND (editing_by IS NULL OR editing_by = ? OR editing_until IS NULL OR editing_until <= ?)";

/**
 * 持鎖且版本吻合才寫得進去。寫入者記在 updated_by,匯入才不會蓋回來。
 * 綁定順序:json, email, now, dxId, expectedVersion, email, now。
 */
export const SMEAR_NOTE_SAVE_SQL =
	"UPDATE smear_dx_notes SET content_json = ?, version = version + 1, updated_by = ?, updated_at = ?, editing_by = NULL, editing_until = NULL WHERE dx_id = ? AND version = ? AND editing_by = ? AND editing_until >= ?";

export function smearNoteLockBinds(
	email: string,
	until: number,
	dxId: string,
	now: number,
): [string, number, string, string, number] {
	return [email, until, dxId, email, now];
}

export function smearNoteSaveBinds(
	json: string,
	email: string,
	now: number,
	dxId: string,
	expectedVersion: number,
): [string, string, number, string, number, string, number] {
	return [json, email, now, dxId, expectedVersion, email, now];
}

export function smearNoteLockDecision(
	row: SmearNoteLockRow | null,
	email: string,
	now: number,
):
	| { action: "grant"; until: number }
	| { action: "deny"; lockedBy: string; until: number }
	| { action: "missing" } {
	if (!row) return { action: "missing" };
	if (
		row.editing_by &&
		row.editing_until != null &&
		row.editing_until > now &&
		row.editing_by !== email
	) {
		return { action: "deny", lockedBy: row.editing_by, until: row.editing_until };
	}
	return { action: "grant", until: now + SMEAR_NOTE_LOCK_MS };
}

/** 條件更新沒寫到列時,用重讀的那列決定回 404 / 423 / 409。 */
export function smearNoteSaveRefusal(
	row: SmearNoteLockRow | null,
	email: string,
	expectedVersion: number,
	now: number,
):
	| { status: 404; error: "note missing" }
	| { status: 423; error: "locked"; lockedBy: string; until: number }
	| { status: 423; error: "you do not hold the lock" }
	| { status: 409; error: "version conflict"; serverVersion: number } {
	if (!row) return { status: 404, error: "note missing" };
	const holds = row.editing_by === email && (row.editing_until ?? 0) >= now;
	if (!holds) {
		const lock = smearNoteLockDecision(row, email, now);
		if (lock.action === "deny") {
			return { status: 423, error: "locked", lockedBy: lock.lockedBy, until: lock.until };
		}
		return { status: 423, error: "you do not hold the lock" };
	}
	if (row.version !== expectedVersion) {
		return {
			status: 409,
			error: "version conflict",
			serverVersion: row.version ?? expectedVersion,
		};
	}
	return { status: 423, error: "you do not hold the lock" };
}

export function parseSmearNoteSaveBody(
	body: unknown,
):
	| { ok: true; json: string; expectedVersion: number }
	| { ok: false; error: string } {
	if (!body || typeof body !== "object" || Array.isArray(body)) {
		return { ok: false, error: "content_json is required" };
	}
	const doc = (body as { content_json?: unknown }).content_json;
	if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
		return { ok: false, error: "content_json is required" };
	}
	const version = (body as { expected_version?: unknown }).expected_version;
	if (typeof version !== "number" || !Number.isInteger(version)) {
		return { ok: false, error: "expected_version is required" };
	}
	return { ok: true, json: JSON.stringify(doc), expectedVersion: version };
}
