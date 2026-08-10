// 「備份我的紀錄」zip 的目錄結構(#123)。
//
// 這裡**只做資料重排**,不碰網路也不碰 fflate —— 攤成純函式才驗得到「一題的
// 作答、信心、筆記、畫記、收藏有沒有正確併在同一個檔案裡」。抓資料在
// backupApi.ts,打包在 BackupCard.tsx。
//
// 圖片刻意不打包(見 #123 的討論):筆記內容是原封不動的 TipTap JSON,裡面的
// `/img/<key>` 保持原樣。離線看不到圖,但文字分析不受影響,而血液抹片那類圖
// 會讓體積再翻一倍。

export type BackupRows = {
  questions: any[];
  attempts: any[];
  confidence: any[];
  notes: any[];
  highlights: any[];
  progress: any[];
  bookmarks: any[];
  exams: any[];
  examAnswers: any[];
  lectureAnnotations: any[];
  lectureNotes: any[];
  freeNotes: any[];
};

export type BackupMeta = {
  email: string;
  generated_at: number;
  schema_version: number;
};

/** 一題一個檔案。題目本身是公開資料,其餘都是這個使用者自己的。 */
export type QuestionFile = {
  question: {
    id: string;
    year: number | null;
    number: number | null;
    group: string | null;
    stem: string;
    options: unknown;
    answer: string;
  };
  explanation: {
    content_json: unknown;
    version: number | null;
    updated_by: string | null;
    updated_at: number | null;
  } | null;
  my: {
    progress: unknown | null;
    bookmark: unknown | null;
    attempts: unknown[];
    confidence: unknown[];
    notes: unknown[];
    highlights: unknown[];
  };
};

function parseJson(v: unknown) {
  if (typeof v !== 'string') return v ?? null;
  try {
    return JSON.parse(v);
  } catch {
    // 存進去的東西壞掉時,寧可把原字串交出去也不要整份備份炸掉 —— 備份的
    // 全部價值就在於「壞掉的那份也帶得走」。
    return v;
  }
}

function groupBy<T>(rows: T[], key: (r: T) => string | null | undefined) {
  const m = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    if (k == null) continue;
    const list = m.get(k);
    if (list) list.push(r);
    else m.set(k, [r]);
  }
  return m;
}

/**
 * 畫記的 store_key 帶著它掛在哪。題目詳解是 `anno:<question_id>`、個人筆記是
 * `anno:note:<question_id>`、自由筆記是 `anno:free:<id>`(見 CLAUDE.md)。
 * 認不出來的前綴不丟掉 —— 收進 `misc/highlights.json`,少一種資料比多一個
 * 檔案糟糕得多。
 */
export function highlightQuestionId(storeKey: string): string | null {
  const m = /^anno:(?:note:)?(\d{3}-\d{3})(?::|$)/.exec(storeKey);
  return m ? m[1] : null;
}

/** 自由筆記的畫記:`anno:free:<id>`。 */
export function highlightFreeNoteId(storeKey: string): string | null {
  const m = /^anno:free:([^:]+)/.exec(storeKey);
  return m ? m[1] : null;
}

export function buildBackupFiles(meta: BackupMeta, rows: BackupRows): Record<string, string> {
  const out: Record<string, string> = {};
  const json = (v: unknown) => JSON.stringify(v, null, 2);

  const attemptsBy = groupBy(rows.attempts, (r) => r.question_id);
  const confidenceBy = groupBy(rows.confidence, (r) => r.question_id);
  const notesBy = groupBy(rows.notes, (r) => r.question_id);
  const progressBy = new Map(rows.progress.map((r) => [r.question_id, r]));
  const bookmarkBy = new Map(rows.bookmarks.map((r) => [r.question_id, r]));
  const hlBy = groupBy(rows.highlights, (r) => highlightQuestionId(r.store_key));
  const freeHl = groupBy(rows.highlights, (r) => highlightFreeNoteId(r.store_key));
  // 只有兩種前綴都認不出來的才進 misc。少了 free 這一半的話,自由筆記的畫記會
  // **同時**出現在 notes/<id>.json 與 misc/highlights.json —— 同一筆資料兩份,
  // 任何統計都會多算一次。
  const unmatchedHighlights = rows.highlights.filter(
    (r) => !highlightQuestionId(r.store_key) && !highlightFreeNoteId(r.store_key)
  );

  for (const q of rows.questions) {
    const id: string = q.id;
    const file: QuestionFile = {
      question: {
        id,
        year: q.year ?? null,
        number: q.number ?? null,
        group: q.group ?? null,
        stem: q.stem,
        options: parseJson(q.options_json),
        answer: q.answer,
      },
      explanation: q.explanation_json
        ? {
            content_json: parseJson(q.explanation_json),
            version: q.explanation_version ?? null,
            updated_by: q.explanation_updated_by ?? null,
            updated_at: q.explanation_updated_at ?? null,
          }
        : null,
      my: {
        progress: progressBy.get(id) ?? null,
        bookmark: bookmarkBy.get(id) ?? null,
        attempts: attemptsBy.get(id) ?? [],
        confidence: confidenceBy.get(id) ?? [],
        notes: (notesBy.get(id) ?? []).map((n) => ({
          slot: n.slot,
          content: parseJson(n.content_json),
          created_at: n.created_at,
          updated_at: n.updated_at,
        })),
        highlights: (hlBy.get(id) ?? []).map((h) => ({
          store_key: h.store_key,
          doc: parseJson(h.doc_json),
          updated_at: h.updated_at,
        })),
      },
    };
    // 依年份分目錄:1100 個檔案攤在同一層,任何檔案總管都難用。
    const year = q.year ?? 'unknown';
    out[`questions/${year}/${id}.json`] = json(file);
  }

  // 全真模擬:一場一個檔案,答案直接嵌進去。
  const answersBy = groupBy(rows.examAnswers, (r) => r.session_id);
  for (const s of rows.exams) {
    out[`exams/${s.id}.json`] = json({ session: s, answers: answersBy.get(s.id) ?? [] });
  }

  // 講義:一份講義一個檔案,「講義名稱對應頁數」。
  const annoBy = groupBy(rows.lectureAnnotations, (r) => r.slug);
  const lnBy = groupBy(rows.lectureNotes, (r) => r.slug);
  for (const slug of new Set([...annoBy.keys(), ...lnBy.keys()])) {
    const anno = annoBy.get(slug) ?? [];
    const notes = lnBy.get(slug) ?? [];
    out[`lectures/${slug}.json`] = json({
      slug,
      title: anno[0]?.lecture_title ?? notes[0]?.lecture_title ?? null,
      annotations: anno.map((a) => ({
        page: a.page,
        kind: a.kind,
        payload: parseJson(a.payload_json),
        created_at: a.created_at,
        updated_at: a.updated_at,
      })),
      notes: notes.map((n) => ({
        page: n.page,
        content: parseJson(n.content_json),
        created_at: n.created_at,
        updated_at: n.updated_at,
      })),
    });
  }

  // 其他筆記(不掛題目)。
  for (const n of rows.freeNotes) {
    out[`notes/${n.id}.json`] = json({
      id: n.id,
      title: n.title,
      content: parseJson(n.content_json),
      created_at: n.created_at,
      updated_at: n.updated_at,
      highlights: (freeHl.get(n.id) ?? []).map((h) => ({
        store_key: h.store_key,
        doc: parseJson(h.doc_json),
      })),
    });
  }

  if (unmatchedHighlights.length) {
    out['misc/highlights.json'] = json(unmatchedHighlights);
  }

  out['manifest.json'] = json({
    ...meta,
    counts: {
      questions: rows.questions.length,
      attempts: rows.attempts.length,
      confidence: rows.confidence.length,
      notes: rows.notes.length,
      highlights: rows.highlights.length,
      progress: rows.progress.length,
      bookmarks: rows.bookmarks.length,
      exams: rows.exams.length,
      exam_answers: rows.examAnswers.length,
      lecture_annotations: rows.lectureAnnotations.length,
      lecture_notes: rows.lectureNotes.length,
      free_notes: rows.freeNotes.length,
    },
  });

  out['CLAUDE.md'] = readmeFor(meta, rows);
  return out;
}

function readmeFor(meta: BackupMeta, rows: BackupRows): string {
  const d = new Date(meta.generated_at).toISOString().slice(0, 10);
  return `# 這份備份是什麼

\`${meta.email}\` 在 ${d} 從「2026 台灣血專衝衝衝」匯出的個人紀錄。
格式版本 \`schema_version: ${meta.schema_version}\`(欄位形狀變更時會 +1)。

**這裡面只有這個帳號自己的紀錄。** 站上的個人筆記標示「僅你可見」,所以備份
不會包含其他使用者的筆記、作答或畫記。題目與共筆詳解是全站公開的,照原樣附上
—— 少了題幹,作答紀錄沒有東西可以分析。

## 目錄

\`\`\`
manifest.json          匯出時間、帳號、各類數量
questions/<年>/<題號>.json   一題一個檔案(見下)
exams/<session_id>.json      一場全真模擬:session + 每題作答
lectures/<slug>.json         一份講義:標題 + 我在第幾頁畫了什麼、寫了什麼
notes/<id>.json              其他筆記(不掛在任何題目上的私人筆記)
misc/highlights.json         前綴認不出來的畫記(通常是空的)
\`\`\`

## questions/<年>/<題號>.json

\`\`\`jsonc
{
  "question":    { "id", "year", "number", "group", "stem", "options", "answer" },
  "explanation": { "content_json", "version", "updated_by", "updated_at" } | null,
  "my": {
    "progress":   { "times_seen", "times_correct", "last_seen_at", "last_chosen", "last_correct" } | null,
    "bookmark":   { "folder_id", "folder_name", "note", "created_at" } | null,
    "attempts":   [ { "chosen", "is_correct", "source", "elapsed_ms", "created_at" } ],
    "confidence": [ { "confidence", "is_correct", "at" } ],
    "notes":      [ { "slot", "content", "created_at", "updated_at" } ],
    "highlights": [ { "store_key", "doc", "updated_at" } ]
  }
}
\`\`\`

## 讀這份資料要先知道的幾件事

- **\`attempts\` 是逐次的事實,\`progress\` 是它的彙總快取。** 兩者不一致時以
  \`attempts\` 為準。而且 2026 年那次改版之前的舊資料**只有彙總、沒有逐次紀錄**
  —— 早期的 \`times_seen\` 不會有對應的 \`attempts\` 列,那不是資料遺失。
- **\`source\` 分 \`review\` / \`exam\` / \`drill\` / \`anki\`。** 算正確率時通常要
  分開看:全真模擬是一次寫完一百題,跟平常複習不是同一種行為。
- **\`elapsed_ms\` 是 client 量的,而且伺服器會夾上限。** 拿來比較相對快慢可以,
  當成精確的作答時間不行。
- **\`confidence\` 沒有 attempt id**,是靠 timestamp 對上的(作答與信心在同一次
  請求裡用同一個 \`now\` 寫入)。所以 \`confidence[].at\` 會等於某一列
  \`attempts[].created_at\`。
- **筆記與詳解是 TipTap(ProseMirror)JSON,不是 HTML 也不是 Markdown。**
  取純文字要走訪節點樹、收集 \`type: "text"\` 的 \`text\`。
- **圖片沒有打包。** 內容裡的 \`/img/<key>\` 指向原站,要登入才看得到。
- **\`highlights[].store_key\` 的前綴決定它掛在哪**:\`anno:<題號>\` 是共筆詳解上
  的畫記,\`anno:note:<題號>\` 是個人筆記上的,\`anno:free:<id>\` 是其他筆記上的。

## 可以問的問題

- 我在哪些主題上反覆答錯?(逐題翻 \`my.attempts\`,對照 \`question.group\` 與年份)
- 我「很有信心但答錯」的題目有哪些?(\`confidence\` 高、\`is_correct\` 為 0)——
  這一類通常是真正的觀念錯誤,比單純不會的更值得補。
- 我的筆記寫了很多、但作答仍然錯的題目?(\`my.notes\` 非空且最近一次 \`is_correct\` 為 0)
- 全真模擬的分數趨勢,以及每一場裡錯在哪些年份/分類。

目前共 ${rows.questions.length} 題、${rows.attempts.length} 筆作答、${rows.notes.length} 則題目筆記、${rows.freeNotes.length} 則其他筆記。
`;
}
