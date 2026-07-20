import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useQuestion } from '../hooks/useQuestion';
import { AnnotatableContent } from './AnnotatableContent';

// 教學模式的即時揭曉塊。
//
// 安全要求:這個元件會打 GET /api/questions/:id,回應裡含正解 —— 所以它
// **只能在使用者的答案送出之後才被 mount**(呼叫端負責),否則答案會提前
// 進到瀏覽器,考試模式就形同虛設。元件本身不做任何延後載入的把戲。
export function TutorReveal({ questionId, chosen }: { questionId: string; chosen: string }) {
  const { data, loading } = useQuestion(questionId);

  const explanationJson = useMemo(() => {
    if (!data?.explanation?.content_json) return null;
    try {
      return JSON.parse(data.explanation.content_json);
    } catch {
      return null;
    }
  }, [data?.explanation?.content_json]);

  if (loading && !data) {
    return (
      <div className="mt-4 text-sm text-ink-400 dark:text-ink-500">載入答案與詳解…</div>
    );
  }
  if (!data) return null;

  const right = chosen === data.answer;

  return (
    <div
      className={
        'mt-4 rounded-lg border p-4 sm:p-5 ' +
        (right
          ? 'border-emerald-300 dark:border-emerald-800 bg-emerald-50/60 dark:bg-emerald-900/20'
          : 'border-rose-300 dark:border-rose-800 bg-rose-50/60 dark:bg-rose-900/20')
      }
    >
      <div
        className={
          'text-sm font-medium ' +
          (right
            ? 'text-emerald-800 dark:text-emerald-200'
            : 'text-rose-800 dark:text-rose-200')
        }
      >
        {right ? '答對了' : '答錯了'} · 你選 {chosen} · 正解 {data.answer}
      </div>

      <div className="mt-4">
        {explanationJson ? (
          // 與 Question.tsx 同一份元件與 storeKey 慣例 → 畫記跨頁共用。
          <AnnotatableContent content={explanationJson} storeKey={`anno:exp:${questionId}`} />
        ) : (
          <p className="text-sm text-ink-500 dark:text-ink-400">這題還沒有詳解。</p>
        )}
      </div>

      <div className="mt-4">
        <Link
          to={`/q/${questionId}`}
          target="_blank"
          rel="noreferrer"
          className="text-sm text-accent hover:text-accent-dark"
        >
          → 看完整討論
        </Link>
      </div>
    </div>
  );
}
