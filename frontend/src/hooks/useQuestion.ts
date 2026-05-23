import { useEffect, useState, useCallback } from 'react';
import { api } from '../lib/api';

export type Options = { A: string; B: string; C: string; D: string; E?: string };

export type QuestionGroup = '內科' | '共同';

export type QuestionFull = {
  id: string;
  year: number;       // 民國
  number: number;     // 1..70 = 內科, 71..100 = 共同
  stem: string;
  options: Options;
  answer: string;
  group: QuestionGroup | null;
  difficulty: number | null;
  source: string | null;
  tags: string[];
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
  my_note: {
    content_json: string;
    updated_at: number;
  } | null;
  back_refs: Array<{
    source_type: 'explanation' | 'comment';
    source_question_id: string;
    source_stem: string;
    by_email: string;
    created_at: number;
  }>;
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
