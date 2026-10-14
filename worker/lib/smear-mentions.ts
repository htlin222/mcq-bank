import { excerpt, extractMentions } from "./db.ts";

/** 刪除後通知預覽只留這句。不把留言原文搬過來再打碼。 */
export const DELETED_SMEAR_COMMENT_PREVIEW = "留言已刪除";

/**
 * 從 TipTap 文件節點抽出要通知的 email。
 *
 * 只認 `mention` 節點,不掃純文字 —— 內文裡寫到某人的信箱不是在 @ 他。
 * 不存在於名單的 email、以及作者自己,都不產生通知。
 */
export function smearMentionTargets(
	contentJson: string,
	authorEmail: string,
	knownEmails: ReadonlySet<string>,
): string[] {
	const out: string[] = [];
	for (const email of extractMentions(contentJson)) {
		if (email === authorEmail) continue;
		if (!knownEmails.has(email)) continue;
		if (out.includes(email)) continue;
		out.push(email);
	}
	return out;
}

export function smearCommentPreview(contentJson: string): string {
	return excerpt(contentJson);
}
