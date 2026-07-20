// `GET /api/questions/:id/stats` 的回應型別 —— QuestionCard 與 ExamResult
// 共用一份,避免兩邊各抄一份型別後漂移。

export type ChoicesState = 'ok' | 'not_answered' | 'below_threshold';

export type StatsPayload = {
  attempts: number;
  correct: number;
  responders: number;
  accuracy: number | null;
  my_elapsed_ms: number | null;
  median_elapsed_ms: number | null;
  p90_elapsed_ms: number | null;
  timed_responders: number;
  choices: Record<string, number> | null;
  choice_pct: Record<string, number> | null;
  choice_responders: number;
  choices_state: ChoicesState;
  my_choice: string | null;
};

/**
 * 某個選項的分布百分比;server 未放行(未作答 / 人數不足)時回 null,
 * 呼叫端就不畫長條。缺欄位的舊回應同樣回 null(向後相容)。
 */
export function choicePct(
  stats: Pick<StatsPayload, 'choices_state' | 'choice_pct'> | null | undefined,
  letter: string,
): number | null {
  if (!stats || stats.choices_state !== 'ok') return null;
  return stats.choice_pct?.[letter] ?? 0;
}
