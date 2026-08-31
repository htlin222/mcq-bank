import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { X, Info, Loader2, ExternalLink } from 'lucide-react';
import { questionCache } from '../lib/questionCache';
import type { QuestionFull } from '../hooks/useQuestion';
import { StaticContent } from './StaticContent';
import { StemText } from './StemText';
import { isEmptyDoc } from '../lib/drafts';

/**
 * 成績頁的「查看詳解」—— 不離開清單就把這一題的共筆詳解看完。
 *
 * 檢討一份考卷時,「這題我為什麼錯」通常一段話就講完了,而舊版要為那一段話走
 * 一趟 `/q/:id` 再走回來。走回來的路現在是修好的(見 Question.tsx 的
 * 「全真結果」),但**最好的路是不用走**。
 *
 * ## 走 `questionCache`,不另外開端點
 *
 * 沒有「只要詳解」的端點,而 `/api/questions/:id` 本來就整份回來。走
 * `lib/questionCache.ts` 而不是自己 fetch,買到三件事:同一題連開兩次不重打、
 * 併發去重,以及**看完真的要進去那一題時是同步命中的**(反過來也成立 ——
 * 從題目頁回來再開這個 peek 也不必等)。
 *
 * ## 唯讀走 StaticContent,不建 EditorView
 *
 * 這裡不需要畫記 / 自動挖空 / 防劇透,所以不該付 ProseMirror 的建構成本
 * (6x 節流下一個約 30–50ms)。同 CLAUDE.md「分頁的載入卡頓」那節的分法:
 * 要 decoration 的走 `AnnotatableContent`,其餘走 `lib/staticDoc.ts`。
 *
 * ## 手機是整頁,桌機是置中對話框
 *
 * 詳解是**長文**。手機上留一圈邊等於把本來就窄的可讀寬度再切掉一塊,所以
 * `<sm` 直接吃滿 `100dvh`;`sm` 以上才收成置中的卡片。
 */
export function ExplanationPeek({
  questionId,
  number,
  fromExam,
  onClose,
}: {
  questionId: string;
  /** 這一場考卷裡的題號 —— 標題要跟使用者剛才點的那一列對得起來。 */
  number: number;
  /** 帶進 /q/:id 的來源,讓那邊也畫得出「全真結果」。 */
  fromExam?: string;
  onClose(): void;
}) {
  // 同步先看快取:上一題/下一題預抓過、或剛從那一題回來時,連 loading 都不進。
  const [data, setData] = useState<QuestionFull | null>(
    () => questionCache.peek(questionId) ?? null,
  );
  const [error, setError] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    questionCache
      .get(questionId)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e?.message ?? e));
      });
    return () => {
      cancelled = true;
    };
  }, [questionId]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // 開起來就把焦點移進來:Esc 有人接、鍵盤走訪不會還停在後面那張卡上。
  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  const doc = useMemo(() => {
    const raw = data?.explanation?.content_json;
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }, [data?.explanation?.content_json]);

  const empty = !doc || isEmptyDoc(doc);

  return createPortal(
    <div
      className="fixed inset-0 z-50 bg-ink-900/40 backdrop-blur-sm flex items-stretch justify-center sm:items-center sm:p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={`第 ${number} 題的詳解`}
        className="bg-white dark:bg-ink-800 w-full flex flex-col outline-none h-[100dvh] sm:h-auto sm:max-h-[calc(100dvh-4rem)] sm:max-w-2xl sm:rounded-lg sm:border sm:border-ink-200 sm:dark:border-ink-700 sm:shadow-paper"
      >
        <header className="shrink-0 flex items-center justify-between gap-3 px-4 sm:px-5 py-3 border-b border-ink-100 dark:border-ink-700">
          <h2 className="font-serif text-lg text-ink-900 dark:text-ink-100 inline-flex items-center gap-2 min-w-0">
            <Info size={17} className="shrink-0 text-accent" />
            <span className="truncate">第 {number} 題 · 詳解</span>
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 p-1 rounded text-ink-400 hover:text-ink-700 dark:hover:text-ink-200"
            aria-label="關閉"
          >
            <X size={18} />
          </button>
        </header>

        {/* `overscroll-contain`:手機上這一塊是滿版的,捲到底再拉會把**底下的
            成績頁**帶著跑 —— 而成績頁正在記錄捲動位置(見 lib/examResultView.ts),
            關掉之後會落在一個誰都沒有捲過的地方。 */}
        <div className="flex-1 overflow-y-auto overscroll-contain px-4 sm:px-5 py-4">
          {error && (
            <p className="text-sm text-rose-700 dark:text-rose-400">
              讀不到這一題({error})
            </p>
          )}
          {!error && !data && (
            <p className="inline-flex items-center gap-2 text-sm text-ink-400 dark:text-ink-500">
              <Loader2 size={15} className="animate-spin" /> 載入中…
            </p>
          )}
          {data && (
            <>
              {/* 題幹:清單上那一列是 line-clamp-2,而只看詳解不看題目多半讀不懂。 */}
              <p className="text-sm text-ink-600 dark:text-ink-300 leading-relaxed border-l-2 border-ink-200 dark:border-ink-700 pl-3">
                <StemText text={data.stem} />
              </p>
              <p className="mt-2 text-xs text-ink-500 dark:text-ink-400">
                正解 {data.answer}
              </p>
              <hr className="my-4 border-ink-100 dark:border-ink-700" />
              {empty ? (
                <p className="text-sm text-ink-500 dark:text-ink-400">
                  這一題還沒有共筆詳解。
                </p>
              ) : (
                <StaticContent content={doc} />
              )}
            </>
          )}
        </div>

        <footer className="shrink-0 px-4 sm:px-5 py-3 border-t border-ink-100 dark:border-ink-700 flex justify-end">
          <Link
            to={`/q/${questionId}`}
            state={fromExam ? { fromExam } : undefined}
            className="inline-flex items-center gap-1 text-sm text-ink-500 dark:text-ink-400 hover:text-accent"
          >
            {empty ? '去寫一則詳解' : '開啟完整題目'} <ExternalLink size={14} />
          </Link>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
