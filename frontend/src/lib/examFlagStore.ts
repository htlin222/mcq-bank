import { api } from './api';
import { mergeFlags, type LocalFlags, type ServerFlag } from './examFlagSync';

// 考試標記(待回頭檢查)的儲存層。比照 highlightStore:localStorage 是即時、
// 可離線的快取,server(PUT /api/exam/:sid/flag)負責跨裝置。每次 toggle 都
// 先寫本機再 fire-and-forget 打 API —— 網路失敗時畫面上的標記絕不消失,
// 下次進入該 session 由 reconcileFlags 補推。
//
// 本機層用 localStorage,不是舊版的 sessionStorage:後者的生命週期只到分頁
// 關閉,連「關掉分頁再開同一場考試」都撐不過。

const key = (sid: string) => `exam:flags:${sid}`;

export function readLocalFlags(sid: string): LocalFlags {
  try {
    const raw = localStorage.getItem(key(sid));
    return raw ? (JSON.parse(raw) as LocalFlags) : {};
  } catch {
    return {};
  }
}

export function writeLocalFlags(sid: string, flags: LocalFlags): void {
  try {
    localStorage.setItem(key(sid), JSON.stringify(flags));
  } catch {
    /* quota / disabled — 非致命 */
  }
}

/** 目前(本機視角)有標記的 question_id,供首屏即時渲染。 */
export function flaggedIds(sid: string): string[] {
  return Object.entries(readLocalFlags(sid))
    .filter(([, v]) => v.flagged)
    .map(([k]) => k);
}

/** /state 或 GET /:sid 的題目/答案陣列 → ServerFlag[]。兩邊欄位名不同,一併吃。 */
export function toServerFlags(
  rows: Array<{
    id?: string;
    question_id?: string;
    flagged?: boolean | number;
    flagged_at?: number | null;
  }>,
): ServerFlag[] {
  return rows
    .map((r) => ({
      question_id: (r.question_id ?? r.id) as string,
      flagged: r.flagged === true || r.flagged === 1,
      flagged_at: r.flagged_at ?? null,
    }))
    .filter((r) => !!r.question_id);
}

// 使用者 toggle:本機立即生效,server 背景補。離線時本機仍保留,
// 下次進入該 session 由 reconcileFlags 上推。
export function setFlag(sid: string, qid: string, flagged: boolean): void {
  const t = Date.now();
  writeLocalFlags(sid, { ...readLocalFlags(sid), [qid]: { flagged, t } });
  void api
    .put(`/api/exam/${sid}/flag`, { question_id: qid, flagged, at: t })
    .catch(() => {
      /* 離線 — 本機已存,下次對帳再推 */
    });
}

// 進入 session 時對帳。serverRows 來自「已取得的」/state 或 /:sid 回應,
// 不額外多打一次 API。回傳合併後的標記狀態,呼叫端據此更新畫面。
export async function reconcileFlags(
  sid: string,
  serverRows: ServerFlag[],
): Promise<Record<string, { flagged: boolean; t: number }>> {
  const merged = mergeFlags(readLocalFlags(sid), serverRows);
  writeLocalFlags(sid, merged.flags);
  for (const qid of merged.push) {
    const v = merged.flags[qid];
    try {
      await api.put(`/api/exam/${sid}/flag`, {
        question_id: qid,
        flagged: v.flagged,
        at: v.t,
      });
    } catch {
      /* 下次進來再推 */
    }
  }
  return merged.flags;
}

// 一次性:把舊版存在 **sessionStorage** 的 `exam-marks-<sid>`(string[])
// 推上 server。
//
// 範圍很有限,別高估它:sessionStorage 的生命週期是「每分頁 × 每次瀏覽
// session」,所以這支只救得到「升級當下還開著同一分頁」的使用者;任何已經
// 關過分頁的舊標記早就不存在了。真正的修復是上面的寫入路徑。
// 旗標比照 highlightStore 的 `anno:synced:v1`。
const MIGRATED_FLAG = 'exam:flags:synced:v1';

export async function migrateLocalExamFlags(): Promise<void> {
  try {
    if (localStorage.getItem(MIGRATED_FLAG)) return;
  } catch {
    return;
  }

  const found: Array<{ sid: string; qids: string[] }> = [];
  try {
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i);
      if (!k?.startsWith('exam-marks-')) continue;
      const qids = JSON.parse(sessionStorage.getItem(k) || '[]') as string[];
      if (Array.isArray(qids) && qids.length) {
        found.push({ sid: k.slice('exam-marks-'.length), qids });
      }
    }
  } catch {
    return;
  }

  for (const { sid, qids } of found) {
    const local = readLocalFlags(sid);
    // 舊標記沒有時間戳:給最小非零值,任何 server 端寫入都比它新。
    for (const qid of qids) if (!local[qid]) local[qid] = { flagged: true, t: 1 };
    writeLocalFlags(sid, local);
    try {
      // 已交卷的 session /state 回 410,結果頁的 GET /:sid 才拿得到;
      // 兩條都試,取得到哪條就用哪條對帳。
      const s = await api
        .get<{ questions: Array<{ id: string; flagged?: boolean; flagged_at?: number | null }> }>(
          `/api/exam/${sid}/state`,
        )
        .then((r) => toServerFlags(r.questions))
        .catch(async () => {
          const r = await api.get<{
            answers: Array<{ question_id: string; flagged?: number; flagged_at?: number | null }>;
          }>(`/api/exam/${sid}`);
          return toServerFlags(r.answers);
        });
      await reconcileFlags(sid, s);
    } catch {
      /* session 不存在或非本人 —— 跳過 */
    }
  }

  try {
    localStorage.setItem(MIGRATED_FLAG, String(found.length));
  } catch {
    /* ignore */
  }
}
