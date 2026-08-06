import { useEffect, useRef, useState, useCallback } from 'react';
import { questionCache } from '../lib/questionCache';

export type Options = { A: string; B: string; C: string; D: string; E?: string };

// Group labels come from config.toml [groups].list — see frontend/src/lib/groups.ts.
// Widened to plain string so forks can use any label set without touching code.
export type QuestionGroup = string;

export type QuestionFull = {
  id: string;
  year: number;       // 民國
  number: number;     // composition follows config.toml [groups].list order
  stem: string;
  options: Options;
  answer: string;
  group: QuestionGroup | null;
  difficulty: number | null;
  source: string | null;
  tags: string[];
  can_edit_answer: boolean;
  explanation: {
    question_id: string;
    content_json: string;
    version: number;
    updated_by: string | null;
    updated_at: number | null;
    editing_by: string | null;
    editing_until: number | null;
  } | null;
  my_progress: {
    times_seen: number;
    times_correct: number;
    last_chosen: string | null;
    last_correct: 0 | 1 | null;
    bookmarked: 0 | 1;
    bookmark_folder_id: string | null;
  } | null;
  /** 第一則筆記(= my_notes[0])。舊欄位,留著給只認一則的呼叫端。 */
  my_note: {
    content_json: string;
    updated_at: number;
  } | null;
  /** 這一題底下這個人的全部筆記,依 slot 排序(見 migration 0036)。 */
  my_notes?: Array<{
    slot: number;
    content_json: string;
    created_at: number;
    updated_at: number;
  }>;
  back_refs: Array<{
    source_type: 'explanation' | 'comment';
    source_question_id: string;
    source_stem: string;
    by_email: string;
    created_at: number;
  }>;
  // Total threaded comments under this question — drives the 討論串 tab badge
  // so we don't have to mount CommentThread just to know how many there are.
  comment_count: number;
};

/**
 * 換題時的兩件事,這個 hook 各處理一半:
 *
 * 1. **命中預抓就別進 loading。** `questionCache.peek()` 是同步的,所以 useState
 *    的初始值就能是完整資料 —— 第一次 render 直接畫出題目,連一幀骨架都不閃。
 *
 * 2. **沒命中就給骨架,而不是留著上一題。** 舊版把 `data` 存成單純的 state,換 id
 *    時不清空,結果使用者按下「下一題」後會繼續看到**上一題**的題幹與已揭曉的答
 *    案,幾百毫秒後才整頁跳掉。看起來像沒點到,而且會劇透。這裡把資料連同它屬於
 *    哪一題一起存,只在 `entry.id === id` 時才當作有資料。
 *
 * 同一個 id 的重抓(存完詳解後的 `reload()`)不受影響:id 沒變,畫面不會空白。
 */
export function useQuestion(id: string | undefined) {
  const [entry, setEntry] = useState<{ id: string; q: QuestionFull } | null>(() => {
    const hit = id ? questionCache.peek(id) : undefined;
    return hit && id ? { id, q: hit } : null;
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  // 快速連按下一題時,先發的請求可能後回來。用它擋掉「已經不是當前題目」的寫入,
  // 否則畫面會被倒退回去,或被 entry.id 不符判成沒資料而閃一下骨架。
  const currentId = useRef(id);
  currentId.current = id;

  // 快取命中時常常拿到跟現在完全一樣的物件,包成新的 entry 只會白白多繪一次。
  const adopt = useCallback((forId: string, q: QuestionFull) => {
    setEntry((prev) =>
      prev && prev.id === forId && prev.q === q ? prev : { id: forId, q },
    );
  }, []);

  const load = useCallback(
    async (force: boolean) => {
      if (!id) return;
      const cached = questionCache.peek(id);
      if (cached) adopt(id, cached);
      if (!force && questionCache.isFresh(id)) return;

      // 手上有(即使過期的)資料就別開 loading —— 背景重抓不該讓畫面變成載入中。
      if (!cached) setLoading(true);
      try {
        const q = await questionCache.get(id, { force });
        if (currentId.current !== id) return;
        adopt(id, q);
        setError(null);
      } catch (e) {
        if (currentId.current !== id) return;
        setError(e as Error);
      } finally {
        if (currentId.current === id) setLoading(false);
      }
    },
    [id, adopt],
  );

  const reload = useCallback(() => load(true), [load]);

  useEffect(() => {
    setError(null);
    void load(false);
  }, [load]);

  const setData = useCallback(
    (q: QuestionFull) => {
      if (!id) return;
      questionCache.set(id, q);
      adopt(id, q);
    },
    [id, adopt],
  );

  const data = entry && entry.id === id ? entry.q : null;
  return { data, loading: loading && !data, error, reload, setData };
}
