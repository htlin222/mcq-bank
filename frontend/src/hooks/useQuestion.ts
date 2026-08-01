import { useEffect, useState, useCallback } from 'react';
import { api } from '../lib/api';

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

export function useQuestion(id: string | undefined) {
  const [data, setData] = useState<QuestionFull | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const reload = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    try {
      const q = await api.get<QuestionFull>(`/api/questions/${id}`);
      setData(q);
      setError(null);
    } catch (e) {
      setError(e as Error);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    if (id) reload();
  }, [id, reload]);

  return { data, loading, error, reload, setData };
}
